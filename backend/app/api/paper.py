"""Paper trading: honest FORWARD tracking of deployed strategies/factors.

A deployment freezes a config at a real calendar date. Tracking replays the
rule over history, then slices and renormalizes the equity curve from the
deployment date — everything after that date is out-of-sample by
construction. The response also carries the SAME rule's pre-deployment
(backtest-period) stats, so the page can show the one number every backtest
tool hides: how much the edge decayed once the future started.
"""

from __future__ import annotations

import asyncio
import math
from datetime import UTC, date, datetime
from itertools import pairwise

import numpy as np
import pandas as pd
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.api.analytics import kronos_points_to_series
from app.api.kronos import signal_points
from app.services import backtest as bt
from app.services import factor_dsl
from app.services.datasource import market_data
from app.services.factor_mine import (
    UNIVERSES,
    _load_panel_blocking,
    portfolio_backtest_blocking,
)
from app.services.pipeline import current_holdings_blocking, run_pipeline_blocking

router = APIRouter(prefix="/api/paper", tags=["paper"])


class TrackRequest(BaseModel):
    kind: str = Field(pattern="^(strategy|factor|pipeline)$")
    started_at: date
    config: dict = Field(default_factory=dict)


# ------------------------------------------------------------- helpers


def _rebase(curve: list[dict], lo: int | None, hi: int | None) -> list[dict]:
    """Slice [lo, hi) by epoch and rebase to 100k at the first kept bar."""
    part = [p for p in curve if (lo is None or p["time"] >= lo) and (hi is None or p["time"] < hi)]
    if not part:
        return []
    base = part[0]["value"] or 1.0
    return [{"time": p["time"], "value": round(p["value"] / base * 100_000, 2)} for p in part]


def _stats(equity: list[dict], benchmark: list[dict], ann: int) -> dict:
    """Return/risk figures for a rebased window. Empty-safe."""
    if len(equity) < 2:
        return {
            "return_pct": 0.0, "bench_return_pct": 0.0, "excess_pct": 0.0,
            "max_drawdown_pct": 0.0, "current_drawdown_pct": 0.0, "sharpe": None,
            "ann_vol_pct": None, "win_rate_pct": None, "bars": len(equity),
            "last_7d_pct": None, "last_30d_pct": None,
        }
    values = np.array([p["value"] for p in equity], dtype=float)
    rets = np.diff(values) / values[:-1]
    ret = (values[-1] / values[0] - 1) * 100
    bench = (benchmark[-1]["value"] / benchmark[0]["value"] - 1) * 100 if len(benchmark) > 1 else 0.0
    peak = np.maximum.accumulate(values)
    dd = values / peak - 1
    vol = float(rets.std(ddof=1)) if len(rets) > 1 else 0.0
    sharpe = float(rets.mean() / vol * math.sqrt(ann)) if vol > 1e-12 else None

    def window(n: int) -> float | None:
        if len(values) <= n:
            return None
        return round((values[-1] / values[-1 - n] - 1) * 100, 2)

    return {
        "return_pct": round(float(ret), 2),
        "bench_return_pct": round(float(bench), 2),
        "excess_pct": round(float(ret - bench), 2),
        "max_drawdown_pct": round(float(dd.min() * 100), 2),
        "current_drawdown_pct": round(float(dd[-1] * 100), 2),
        "sharpe": round(sharpe, 2) if sharpe is not None else None,
        "ann_vol_pct": round(vol * math.sqrt(ann) * 100, 2) if vol else None,
        "win_rate_pct": round(float((rets > 0).mean() * 100), 1) if len(rets) else None,
        "bars": len(equity),
        "last_7d_pct": window(7),
        "last_30d_pct": window(30),
    }


def _decay(pre: dict, post: dict) -> dict:
    """Did the edge survive contact with the future? Compared on Sharpe and
    excess return, with an explicit 'not enough data yet' state."""
    if pre["bars"] < 60 or post["bars"] < 20 or pre["sharpe"] is None or post["sharpe"] is None:
        return {"verdict": "insufficient", "sharpe_delta": None, "excess_delta": None}
    sd = round(post["sharpe"] - pre["sharpe"], 2)
    ed = round(post["excess_pct"] - pre["excess_pct"], 2)
    if post["sharpe"] < pre["sharpe"] - 0.5 and post["excess_pct"] < 0:
        verdict = "degraded"
    elif post["sharpe"] > pre["sharpe"] + 0.3:
        verdict = "improved"
    else:
        verdict = "holding"
    return {"verdict": verdict, "sharpe_delta": sd, "excess_delta": ed}


def _daily_returns(equity: list[dict], n: int = 60) -> list[dict]:
    out = []
    for prev, cur in pairwise(equity):
        if prev["value"]:
            out.append({"time": cur["time"], "ret_pct": round((cur["value"] / prev["value"] - 1) * 100, 3)})
    return out[-n:]


def _factor_holdings(expression: str, market: str, top_n: int, invert: bool) -> dict:
    panel = _load_panel_blocking(market if market in UNIVERSES else "us")
    values, _ = factor_dsl.compute(expression, panel)
    if invert:
        values = -values
    for i in range(1, min(6, len(values)) + 1):
        row = values.iloc[-i].dropna().sort_values(ascending=False)
        if len(row) >= top_n:
            return {
                "state": "holdings",
                "symbols": [str(sym) for sym in row.index[:top_n]],
                "since": str(values.index[-i].date()),
            }
    return {"state": "unknown"}


# ------------------------------------------------------------ endpoint


@router.post("/track")
async def track(req: TrackRequest) -> dict:
    start_epoch = int(datetime(
        req.started_at.year, req.started_at.month, req.started_at.day, tzinfo=UTC
    ).timestamp())
    if req.started_at > date.today():
        raise HTTPException(status_code=400, detail="deployment date is in the future")

    position: dict = {"state": "unknown"}

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
        full_eq, full_bench = result.equity_curve, result.benchmark_curve
        ann = 252
        # current stance = last signal (the engine acts on it next bar)
        try:
            signals = want_long if want_long is not None else bt._signals(df, cfg)
            state = "long" if bool(signals.iloc[-1]) else "flat"
            # find how long the current stance has held
            flipped = signals != signals.iloc[-1]
            since_idx = flipped[::-1].idxmax() if flipped.any() else signals.index[0]
            position = {"state": state, "since": str(pd.Timestamp(since_idx).date()), "symbols": [symbol]}
        except Exception:
            position = {"state": "unknown"}
        trades_live = sum(1 for t in result.trades if (t.get("entry_time") or 0) >= start_epoch)

    elif req.kind == "pipeline":
        # the whole signal → portfolio → backtest chain, frozen as a spec
        try:
            result = await asyncio.to_thread(
                run_pipeline_blocking, {**req.config, "compare": False}
            )
        except factor_dsl.FactorError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        full_eq, full_bench = result["backtest"]["equity_curve"], result["backtest"]["benchmark_curve"]
        ann = 252 if result["spec"]["market"] == "us" else 365
        trades_live = None
        try:
            position = await asyncio.to_thread(current_holdings_blocking, req.config)
        except Exception:
            position = {"state": "unknown"}

    else:  # factor
        expression = str(req.config.get("expression", ""))
        market = str(req.config.get("market", "us"))
        top_n = int(req.config.get("top_n", 5))
        invert = bool(req.config.get("invert", False))
        try:
            result = await asyncio.to_thread(
                portfolio_backtest_blocking,
                expression, market, top_n, int(req.config.get("rebalance", 10)), invert,
            )
        except factor_dsl.FactorError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        full_eq, full_bench = result["equity_curve"], result["benchmark_curve"]
        ann = 252 if market == "us" else 365
        trades_live = None
        # current holdings: top-N of the factor on the latest COMPLETE bar
        # (the newest row is often partial — a few symbols not yet printed).
        try:
            position = await asyncio.to_thread(_factor_holdings, expression, market, top_n, invert)
        except Exception:
            position = {"state": "unknown"}

    post_eq = _rebase(full_eq, start_epoch, None)
    post_bench = _rebase(full_bench, start_epoch, None)
    pre_eq = _rebase(full_eq, None, start_epoch)
    pre_bench = _rebase(full_bench, None, start_epoch)
    if len(post_eq) < 1:
        raise HTTPException(
            status_code=400, detail="no bars since the deployment date yet — check back tomorrow"
        )

    post = _stats(post_eq, post_bench, ann)
    pre = _stats(pre_eq, pre_bench, ann)
    if pre_eq:
        pre["from"] = str(pd.Timestamp(pre_eq[0]["time"], unit="s").date())
        pre["to"] = str(pd.Timestamp(pre_eq[-1]["time"], unit="s").date())

    as_of = pd.Timestamp(post_eq[-1]["time"], unit="s").date()
    return {
        "kind": req.kind,
        "started_at": str(req.started_at),
        "as_of": str(as_of),
        "days_live": (date.today() - req.started_at).days,
        "equity_curve": post_eq,
        "benchmark_curve": post_bench,
        "stats": post,
        "pre": pre,
        "decay": _decay(pre, post),
        "position": position,
        "trades_live": trades_live,
        "daily_returns": _daily_returns(post_eq),
    }
