from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

import pandas as pd

from app.api.kronos import signal_points
from app.api.market import _clean_symbol
from app.services import backtest as bt
from app.services import indicators as ind
from app.services.datasource import market_data

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/indicators")
async def list_indicators():
    return {"indicators": sorted(ind.REGISTRY)}


@router.get("/indicator/{symbol}/{name}")
async def get_indicator(
    symbol: str,
    name: str,
    period: int | None = Query(None, ge=2, le=400),
    history: str = Query("1y", description="Price history window to compute over"),
):
    symbol = _clean_symbol(symbol)
    try:
        df = await market_data.history_frame(symbol, history, "1d")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    params = {}
    if period is not None and name.lower() in {"sma", "ema", "rsi", "atr"}:
        params["period"] = period

    try:
        result = ind.compute(df, name, **params)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "symbol": symbol.upper(),
        "indicator": name.lower(),
        "params": params,
        "history": history,
        "data": result,
    }


class BacktestRequest(BaseModel):
    symbol: str
    strategy: str = Field(
        "sma_cross",
        description="sma_cross | ema_cross | rsi_reversion | buy_and_hold | kronos_signal",
    )
    period: str = Field("2y", description="1y 2y 5y max")
    fast: int = Field(20, ge=2, le=200)
    slow: int = Field(50, ge=3, le=400)
    # rsi_reversion parameters — exposed so marketplace presets like Connors
    # RSI(2) are actually runnable rather than approximations.
    rsi_period: int = Field(14, ge=2, le=100)
    rsi_oversold: float = Field(30.0, ge=1, le=50)
    rsi_overbought: float = Field(70.0, ge=50, le=99)
    initial_capital: float = Field(100_000.0, gt=0)
    commission_bps: float = Field(5.0, ge=0, le=100)
    slippage_bps: float = Field(2.0, ge=0, le=100)
    # kronos_signal: forecast horizon (= rebalance cadence, in bars)
    kronos_horizon: int = Field(14, ge=5, le=60)


@router.post("/backtest")
async def run_backtest(req: BacktestRequest):
    if req.fast >= req.slow and req.strategy in {"sma_cross", "ema_cross"}:
        raise HTTPException(status_code=400, detail="fast period must be shorter than slow period")

    try:
        df = await market_data.history_frame(req.symbol, req.period, "1d")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    cfg = bt.BacktestConfig(
        strategy=req.strategy,
        fast=req.fast,
        slow=req.slow,
        rsi_period=req.rsi_period,
        rsi_oversold=req.rsi_oversold,
        rsi_overbought=req.rsi_overbought,
        initial_capital=req.initial_capital,
        commission_bps=req.commission_bps,
        slippage_bps=req.slippage_bps,
        kronos_horizon=req.kronos_horizon,
    )

    want_long = None
    if req.strategy == "kronos_signal":
        points = await signal_points(req.symbol.upper(), req.period, req.kronos_horizon, df=df)
        want_long = kronos_points_to_series(df, points)

    try:
        result = bt.run(df, cfg, want_long=want_long)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "symbol": req.symbol.upper(),
        "strategy": req.strategy,
        "period": req.period,
        "stats": result.stats,
        "equity_curve": result.equity_curve,
        "benchmark_curve": result.benchmark_curve,
        "drawdown_curve": result.drawdown_curve,
        "trades": result.trades,
    }


def kronos_points_to_series(df, points: list[dict]) -> "pd.Series":
    """Turn dated long/flat anchors into a bar-aligned signal series.

    Matching is by calendar date so a locally-fetched frame and one fetched by
    the remote inference service line up even if their tz handling differs.
    The signal holds (forward-fills) between anchors and is flat before the
    first one.
    """
    sig_map = {p["date"]: bool(p["long"]) for p in points}
    current = False
    values = []
    for ts in df.index:
        current = sig_map.get(str(ts.date()), current)
        values.append(current)
    return pd.Series(values, index=df.index)
