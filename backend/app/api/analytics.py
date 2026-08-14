from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app.services import backtest as bt
from app.services import indicators as ind
from app.services.datasource import market_data, resolve_interval

router = APIRouter(prefix="/api/analytics", tags=["analytics"])


@router.get("/indicators")
async def list_indicators():
    return {"indicators": sorted(ind.REGISTRY)}


@router.get("/indicator/{symbol}/{name}")
async def get_indicator(
    symbol: str,
    name: str,
    response: Response,
    period: int | None = Query(None, ge=2, le=400),
    history: str = Query("1y", description="Price history window to compute over"),
    interval: str | None = Query(None, description="Bar size; defaults to the candle endpoint's choice for this window"),
):
    # Same period→interval mapping as /market/candles: an overlay computed on
    # daily bars drawn over an hourly (1mo) or weekly (5y) candle series is
    # silently wrong, so by default the indicator follows the chart's bar size.
    interval = interval or resolve_interval(history)
    try:
        df = await market_data.history_frame(symbol, history, interval)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    params = {}
    if period is not None and name.lower() in {"sma", "ema", "rsi", "atr", "bollinger"}:
        params["period"] = period

    try:
        result = ind.compute(df, name, **params)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    response.headers["Cache-Control"] = "public, max-age=60"
    return {
        "symbol": symbol.upper(),
        "indicator": name.lower(),
        "params": params,
        "history": history,
        "interval": interval,
        "data": result,
    }


class BacktestRequest(BaseModel):
    symbol: str
    strategy: str = Field("sma_cross", description="sma_cross | ema_cross | rsi_reversion | buy_and_hold")
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
    )

    try:
        result = bt.run(df, cfg)
    except ValueError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    return {
        "symbol": req.symbol.upper(),
        "strategy": req.strategy,
        "period": req.period,
        "stats": result.stats,
        "equity_curve": result.equity_curve,
        "trades": result.trades,
    }
