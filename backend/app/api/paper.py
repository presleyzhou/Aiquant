"""Paper trading: honest FORWARD tracking of deployed strategies/factors.

A deployment freezes a config at a real calendar date. Tracking replays the
rule over history, then slices and renormalizes the equity curve from the
deployment date — everything after that date is out-of-sample by
construction, because the date is in the actual past. Backtests answer
"was it good?"; this answers "has it been good SINCE you clicked deploy?".
"""

from __future__ import annotations

import asyncio
from datetime import date, datetime, timezone

import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.analytics import kronos_points_to_series
from app.api.kronos import signal_points
from app.services import backtest as bt
from app.services import factor_dsl
from app.services.datasource import market_data
from app.services.factor_mine import portfolio_backtest_blocking

router = APIRouter(prefix="/api/paper", tags=["paper"])


class TrackRequest(BaseModel):
    kind: str = Field(pattern="^(strategy|factor)$")
    started_at: date
    config: dict = Field(default_factory=dict)


def _slice_and_rebase(
    equity: list[dict], benchmark: list[dict], start_epoch: int
) -> tuple[list[dict], list[dict]]:
    """Keep only bars from the deployment date on, rebased to 100k at start."""

    def rebase(curve: list[dict]) -> list[dict]:
        tail = [p for p in curve if p["time"] >= start_epoch]
        if not tail:
            return []
        base = tail[0]["value"] or 1.0
        return [{"time": p["time"], "value": round(p["value"] / base * 100_000, 2)} for p in tail]

    return rebase(equity), rebase(benchmark)


def _stats(equity: list[dict], benchmark: list[dict]) -> dict:
    ret = (equity[-1]["value"] / equity[0]["value"] - 1) * 100 if len(equity) > 1 else 0.0
    bench = (benchmark[-1]["value"] / benchmark[0]["value"] - 1) * 100 if len(benchmark) > 1 else 0.0
    peak, max_dd = 0.0, 0.0
    for p in equity:
        peak = max(peak, p["value"])
        if peak:
            max_dd = min(max_dd, (p["value"] / peak - 1) * 100)
    return {
        "return_pct": round(ret, 2),
        "bench_return_pct": round(bench, 2),
        "excess_pct": round(ret - bench, 2),
        "max_drawdown_pct": round(max_dd, 2),
        "bars": len(equity),
    }


@router.post("/track")
async def track(req: TrackRequest) -> dict:
    start_epoch = int(datetime(
        req.started_at.year, req.started_at.month, req.started_at.day, tzinfo=timezone.utc
    ).timestamp())
    if req.started_at > date.today():
        raise HTTPException(status_code=400, detail="deployment date is in the future")

    if req.kind == "strategy":
        symbol = str(req.config.get("symbol", "")).upper().strip()
        if not symbol:
            raise HTTPException(status_code=400, detail="strategy config needs a symbol")
        try:
            df = await market_data.history_frame(symbol, "5y", "1d")
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc

        cfg = bt.BacktestConfig(
            strategy=str(req.config.get("strategy", "sma_cross")),
            fast=int(req.config.get("fast", 20)),
            slow=int(req.config.get("slow", 50)),
            rsi_period=int(req.config.get("rsi_period", 14)),
            rsi_oversold=float(req.config.get("rsi_oversold", 30)),
            rsi_overbought=float(req.config.get("rsi_overbought", 70)),
            kronos_horizon=int(req.config.get("kronos_horizon", 14)),
        )
        want_long = None
        if cfg.strategy == "kronos_signal":
            points = await signal_points(symbol, "5y", cfg.kronos_horizon, df=df)
            want_long = kronos_points_to_series(df, points)
        try:
            result = bt.run(df, cfg, want_long=want_long)
        except ValueError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        equity, benchmark = _slice_and_rebase(
            result.equity_curve, result.benchmark_curve, start_epoch
        )

    else:  # factor
        expression = str(req.config.get("expression", ""))
        try:
            result = await asyncio.to_thread(
                portfolio_backtest_blocking,
                expression,
                str(req.config.get("market", "us")),
                int(req.config.get("top_n", 5)),
                int(req.config.get("rebalance", 10)),
                bool(req.config.get("invert", False)),
            )
        except factor_dsl.FactorError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        equity, benchmark = _slice_and_rebase(
            result["equity_curve"], result["benchmark_curve"], start_epoch
        )

    if len(equity) < 1:
        raise HTTPException(
            status_code=400, detail="no bars since the deployment date yet — check back tomorrow"
        )

    as_of = pd.Timestamp(equity[-1]["time"], unit="s").date()
    return {
        "kind": req.kind,
        "started_at": str(req.started_at),
        "as_of": str(as_of),
        "days_live": (date.today() - req.started_at).days,
        "equity_curve": equity,
        "benchmark_curve": benchmark,
        "stats": _stats(equity, benchmark),
    }
