"""End-to-end quantitative investment pipeline.

    universe/data  →  alpha signal  →  portfolio construction  →  backtest
                   →  risk & attribution  →  target weights (→ paper trading)

The first two stages reuse the platform's engines (the cached OHLCV panel
and the safe factor DSL; the composite signal follows the same rank-blend
and in-sample-only IC weighting as `factor_mine.composite_backtest_blocking`).
The portfolio and risk stages live in `portfolio.py`. This module wires them
into one simulation with the honesty rules the rest of the site enforces:

  * no look-ahead — weights decided on the close of day t earn returns from
    day t+1; covariances and vols use trailing windows only;
  * costs on every unit of turnover, weights drift with prices between
    rebalances (no free daily re-weighting);
  * the trailing 20% of the backtest is reported separately as a holdout and
    the IC weights of the blend never see it;
  * the benchmark is the equal-weight universe — the thing a factor tilt has
    to beat to have earned its complexity.
"""

from __future__ import annotations

from typing import Any

import numpy as np
import pandas as pd

from app.services import factor_dsl, portfolio
from app.services.factor_mine import (
    HOLDOUT_FRACTION,
    UNIVERSES,
    _daily_rank_ic,
    _load_panel_blocking,
)

SCHEME_INFO: list[dict[str, str]] = [
    {"id": "equal", "zh": "等权 Top-N", "en": "Equal-weight Top-N",
     "desc_zh": "入选标的等权。最简单、最难被过拟合的基线。",
     "desc_en": "Equal weight across the selected names — the simplest baseline and the hardest to overfit."},
    {"id": "score", "zh": "信号加权", "en": "Score-weighted",
     "desc_zh": "按信号排名线性加权，信号最强的标的权重最大。押注的是排序本身。",
     "desc_en": "Rank-linear in the signal: the strongest name gets the most. A bet on the ordering itself."},
    {"id": "inverse_vol", "zh": "波动率倒数", "en": "Inverse volatility",
     "desc_zh": "权重与近期波动率成反比，让每个标的承担相近的风险预算。",
     "desc_en": "Weights inversely proportional to trailing volatility so every name carries a similar risk budget."},
    {"id": "min_variance", "zh": "最小方差", "en": "Minimum variance",
     "desc_zh": "在多头、上限约束下最小化组合方差（收缩协方差 + 投影梯度）。",
     "desc_en": "Minimise portfolio variance under long-only and cap constraints (shrunk covariance, projected gradient)."},
    {"id": "risk_parity", "zh": "风险平价", "en": "Risk parity",
     "desc_zh": "每个标的对组合方差的贡献相等。低相关、低波动的标的得到更多权重。",
     "desc_en": "Every name contributes the same share of portfolio variance; low-vol, low-correlation names get more."},
]

STARTER_FACTORS: dict[str, list[dict[str, Any]]] = {
    "us": [
        {"expression": "neg(delta(close, 5) / ts_std(returns, 20))", "zh": "短期反转（波动率调整）", "en": "Short-term reversal (vol-adjusted)", "invert": False, "horizon": 10},
        {"expression": "ts_mean(returns, 120) - ts_mean(returns, 20)", "zh": "中期动量（剔除近月）", "en": "Medium-term momentum ex recent month", "invert": False, "horizon": 10},
        {"expression": "neg(ts_std(returns, 60))", "zh": "低波动", "en": "Low volatility", "invert": False, "horizon": 10},
        {"expression": "neg(ts_mean(volume, 5) / ts_mean(volume, 60))", "zh": "成交量收缩", "en": "Volume contraction", "invert": False, "horizon": 10},
    ],
    "crypto": [
        {"expression": "ts_mean(returns, 30) - ts_mean(returns, 7)", "zh": "中期动量（剔除近周）", "en": "Medium-term momentum ex recent week", "invert": False, "horizon": 7},
        {"expression": "neg(ts_std(returns, 30))", "zh": "低波动", "en": "Low volatility", "invert": False, "horizon": 7},
        {"expression": "neg(delta(close, 3) / ts_std(returns, 14))", "zh": "短期反转（波动率调整）", "en": "Short-term reversal (vol-adjusted)", "invert": False, "horizon": 7},
    ],
}

DEFAULTS: dict[str, Any] = {
    "scheme": "inverse_vol", "signal_weighting": "ic", "top_n": 8, "rebalance": 10,
    "max_weight": 0.25, "cost_bps": 7.0, "target_vol_pct": None, "vol_lookback": 60, "horizon": 10,
}
LIMITS: dict[str, list] = {
    "factors": [1, 8], "top_n": [2, 20], "rebalance": [1, 30], "max_weight": [0.05, 1.0],
    "cost_bps": [0, 50], "target_vol_pct": [5, 40], "vol_lookback": [20, 120],
}

_MIN_BARS = 60


def config() -> dict:
    return {
        "markets": list(UNIVERSES),
        "universes": {k: list(v) for k, v in UNIVERSES.items()},
        "schemes": SCHEME_INFO,
        "starter_factors": STARTER_FACTORS,
        "defaults": DEFAULTS,
        "limits": LIMITS,
    }


# ----------------------------------------------------------------- spec


def _clamp(value: Any, lo: float, hi: float, cast=float):
    try:
        v = cast(value)
    except (TypeError, ValueError):
        raise factor_dsl.FactorError(f"invalid parameter value: {value!r}") from None
    return max(lo, min(hi, v))


def normalize_spec(raw: dict) -> dict:
    """Coerce a request (or a stored paper-trading config) to a valid spec."""
    market = raw.get("market", "us")
    market = market if market in UNIVERSES else "us"
    factors_in = raw.get("factors") or []
    if not isinstance(factors_in, list) or not (LIMITS["factors"][0] <= len(factors_in) <= LIMITS["factors"][1]):
        raise factor_dsl.FactorError("pipeline needs between 1 and 8 factors")
    factors = []
    for f in factors_in:
        if isinstance(f, str):
            f = {"expression": f}
        expr = str(f.get("expression", "")).strip()
        if not expr:
            raise factor_dsl.FactorError("empty factor expression")
        factor_dsl.parse(expr)  # raises FactorError with the position quoted
        factors.append({
            "expression": expr[:240],
            "invert": bool(f.get("invert", False)),
            "horizon": int(_clamp(f.get("horizon", DEFAULTS["horizon"]), 1, 30, int)),
        })
    scheme = str(raw.get("scheme", DEFAULTS["scheme"]))
    if scheme not in portfolio.SCHEMES:
        raise factor_dsl.FactorError(f"unknown weighting scheme: {scheme}")
    weighting = str(raw.get("signal_weighting", DEFAULTS["signal_weighting"]))
    weighting = weighting if weighting in ("ic", "equal") else "ic"
    tv = raw.get("target_vol_pct")
    target_vol = None if tv in (None, "", 0, "0", False) else _clamp(tv, *LIMITS["target_vol_pct"])
    return {
        "market": market,
        "factors": factors,
        "signal_weighting": weighting,
        "scheme": scheme,
        "top_n": int(_clamp(raw.get("top_n", DEFAULTS["top_n"]), *LIMITS["top_n"], cast=int)),
        "rebalance": int(_clamp(raw.get("rebalance", DEFAULTS["rebalance"]), *LIMITS["rebalance"], cast=int)),
        "max_weight": round(_clamp(raw.get("max_weight", DEFAULTS["max_weight"]), *LIMITS["max_weight"]), 4),
        "cost_bps": round(_clamp(raw.get("cost_bps", DEFAULTS["cost_bps"]), *LIMITS["cost_bps"]), 2),
        "target_vol_pct": round(target_vol, 2) if target_vol is not None else None,
        "vol_lookback": int(_clamp(raw.get("vol_lookback", DEFAULTS["vol_lookback"]), *LIMITS["vol_lookback"], cast=int)),
        "compare": bool(raw.get("compare", True)),
    }


# --------------------------------------------------------------- signal


def build_signal(spec: dict, panel: dict[str, pd.DataFrame]) -> tuple[pd.DataFrame, dict, list[pd.DataFrame]]:
    """Composite cross-sectional score in [0, 1]-ish rank space, plus the
    component diagnostics. Returns (scores, signal_info, per_factor_ranks)."""
    close = panel["close"]
    ranked_list: list[pd.DataFrame] = []
    components: list[dict] = []
    for f in spec["factors"]:
        values, _ = factor_dsl.compute(f["expression"], panel)
        if f["invert"]:
            values = -values
        fwd = close.pct_change(f["horizon"]).shift(-f["horizon"])
        ic = _daily_rank_ic(values, fwd)
        if len(ic) < _MIN_BARS:
            raise factor_dsl.FactorError(
                f"{f['expression']}: only {len(ic)} evaluable days — factor too sparse for this universe"
            )
        split = int(len(ic) * (1 - HOLDOUT_FRACTION))
        is_ic = float(ic.iloc[:split].mean()) if split > 0 else 0.0
        oos_ic = float(ic.iloc[split:].mean()) if split < len(ic) else 0.0
        ranked_list.append(values.rank(axis=1, pct=True))
        components.append({
            "expression": f["expression"], "invert": f["invert"], "horizon": f["horizon"],
            "is_ic": round(is_ic if np.isfinite(is_ic) else 0.0, 4),
            "oos_ic": round(oos_ic if np.isfinite(oos_ic) else 0.0, 4),
        })

    n = len(ranked_list)
    max_pair_corr = 0.0
    for i in range(n):
        for j in range(i + 1, n):
            pair = pd.concat([ranked_list[i].stack(), ranked_list[j].stack()], axis=1).dropna()
            if len(pair) > 200:
                c = abs(float(pair.iloc[:, 0].corr(pair.iloc[:, 1])))
                if np.isfinite(c):
                    max_pair_corr = max(max_pair_corr, c)

    # Sign-align on the IN-SAMPLE IC (a factor whose in-sample IC is negative
    # is flipped); magnitude by |IC| or equal. The holdout never enters here.
    signs = [1.0 if c["is_ic"] >= 0 else -1.0 for c in components]
    if spec["signal_weighting"] == "ic":
        mags = [abs(c["is_ic"]) for c in components]
        total = sum(mags)
        mags = [m / total if total > 1e-9 else 1.0 / n for m in mags]
    else:
        mags = [1.0 / n] * n
    weights = [s * m for s, m in zip(signs, mags)]
    for c, w in zip(components, weights):
        c["weight"] = round(w, 3)

    scores = sum(r * w for r, w in zip(ranked_list, weights))
    info = {"weighting": spec["signal_weighting"], "components": components, "max_pair_corr": round(max_pair_corr, 3)}
    return scores, info, ranked_list


# ------------------------------------------------------------- simulate


def _decide_weights(
    scheme: str,
    row_scores: pd.Series,
    trailing: pd.DataFrame,
    spec: dict,
    ann: int,
) -> tuple[pd.Series, float]:
    """Target weights (indexed by symbol) on one rebalance date and the
    exposure multiplier applied by vol targeting."""
    lookback = spec["vol_lookback"]
    # only names with a usable trailing history can be sized
    usable = trailing.notna().sum() >= max(10, int(lookback * 0.6))
    candidates = row_scores.dropna()
    candidates = candidates[usable.reindex(candidates.index).fillna(False).astype(bool)]
    if len(candidates) < 2:
        return pd.Series(dtype=float), 1.0
    top_n = min(spec["top_n"], len(candidates))
    selected = candidates.sort_values(ascending=False).iloc[:top_n]
    sub = trailing[selected.index]
    w = portfolio.construct(scheme, selected.values, sub.values, spec["max_weight"])
    scale = 1.0
    if spec["target_vol_pct"]:
        scale = portfolio.vol_scale(w, sub.values, spec["target_vol_pct"] / 100.0, ann)
    return pd.Series(w * scale, index=selected.index), scale


def simulate(scores: pd.DataFrame, panel: dict[str, pd.DataFrame], spec: dict, scheme: str | None = None) -> dict:
    """Run the portfolio through history. Returns raw series for reporting."""
    scheme = scheme or spec["scheme"]
    market = spec["market"]
    ann = 252 if market == "us" else 365
    close = panel["close"]
    ret = close.pct_change()
    symbols = list(close.columns)
    scores = scores.reindex(index=close.index, columns=symbols)
    ret_np = ret.to_numpy(dtype=float)
    T, N = ret_np.shape
    lookback = spec["vol_lookback"]
    rebalance = spec["rebalance"]
    cost = spec["cost_bps"] / 10_000.0

    # first day the signal has at least top_n names AND a trailing window exists
    enough = (scores.notna().sum(axis=1) >= min(spec["top_n"], 2)).to_numpy()
    first = None
    for i in range(lookback, T):
        if enough[i]:
            first = i
            break
    if first is None or T - first < _MIN_BARS:
        raise factor_dsl.FactorError("signal warms up too late to backtest on this universe")

    rebalance_days = set(range(first, T, rebalance))
    held = np.zeros(N)
    net = np.zeros(T)
    gross = np.zeros(T)
    turnover = np.zeros(T)
    exposure = np.zeros(T)
    contrib = np.zeros(N)
    days_held = np.zeros(N)
    weight_sum = np.zeros(N)
    eff_n: list[float] = []
    cap_hits = 0
    n_rebal = 0
    pending: pd.Series | None = None
    last_target: tuple[pd.Timestamp, pd.Series, float] | None = None

    for i in range(first, T):
        # trade into yesterday's decision at today's open (≈ earn today's return)
        if pending is not None:
            target = np.zeros(N)
            idx = [symbols.index(s) for s in pending.index]
            target[idx] = pending.values
            turnover[i] = float(np.abs(target - held).sum()) / 2
            held = target
            pending = None
        r = np.nan_to_num(ret_np[i])
        day_contrib = held * r
        g = float(day_contrib.sum())
        gross[i] = g
        net[i] = g - turnover[i] * cost
        contrib += day_contrib
        active = held > 1e-12
        days_held += active
        weight_sum += held
        exposure[i] = float(held.sum())
        held = held * (1 + r) / (1 + g) if abs(1 + g) > 1e-9 else held
        # decide the next weights on today's close
        if i in rebalance_days and i + 1 < T:
            trailing = ret.iloc[i - lookback + 1: i + 1]
            w, scale = _decide_weights(scheme, scores.iloc[i], trailing, spec, ann)
            if len(w):
                pending = w
                n_rebal += 1
                eff_n.append(portfolio.effective_n(w.values))
                unscaled = w.values / scale if scale > 1e-9 else w.values
                if spec["max_weight"] < 1 and (unscaled >= spec["max_weight"] - 1e-9).any():
                    cap_hits += 1

    # latest decision (for target weights): newest complete row with a full cross-section
    for i in range(T - 1, max(first, T - 8) - 1, -1):
        trailing = ret.iloc[i - lookback + 1: i + 1]
        w, scale = _decide_weights(scheme, scores.iloc[i], trailing, spec, ann)
        if len(w) >= min(spec["top_n"], 2):
            last_target = (close.index[i], w, scale)
            break

    index = close.index[first:]
    net_s = pd.Series(net[first:], index=index)
    bench_w = close.notna().astype(float)
    bench_w = bench_w.div(bench_w.sum(axis=1).replace(0, np.nan), axis=0)
    bench_s = (bench_w.shift(1) * ret).sum(axis=1).loc[index]

    return {
        "scheme": scheme,
        "ann": ann,
        "net": net_s,
        "bench": bench_s,
        "turnover": pd.Series(turnover[first:], index=index),
        "exposure": pd.Series(exposure[first:], index=index),
        "contrib": pd.Series(contrib, index=symbols),
        "days_held": pd.Series(days_held, index=symbols),
        "avg_weight": pd.Series(np.divide(weight_sum, np.maximum(days_held, 1)), index=symbols),
        "effective_n": float(np.mean(eff_n)) if eff_n else 0.0,
        "cap_binding_pct": round(100.0 * cap_hits / n_rebal, 1) if n_rebal else 0.0,
        "rebalances": n_rebal,
        "last_target": last_target,
    }


# --------------------------------------------------------------- report


def _epoch(ts) -> int:
    return int(pd.Timestamp(ts).timestamp())


def _curve(series: pd.Series, digits: int = 2) -> list[dict]:
    return [{"time": _epoch(ts), "value": round(float(v), digits)} for ts, v in series.items()]


def _summary(sim: dict) -> dict:
    stats = portfolio.period_stats(sim["net"], sim["bench"], sim["ann"])
    return {
        "scheme": sim["scheme"],
        "total_return_pct": stats["total_return_pct"],
        "sharpe": stats["sharpe"],
        "max_drawdown_pct": stats["max_drawdown_pct"],
        "ann_vol_pct": stats["ann_vol_pct"],
        "avg_turnover_pct": round(float(sim["turnover"].mean() * 100), 2),
    }


def report(spec: dict, panel: dict[str, pd.DataFrame], signal: dict, sim: dict,
           alternatives: list[dict], universe: dict) -> dict:
    net, bench, ann = sim["net"], sim["bench"], sim["ann"]
    equity = (1 + net).cumprod() * 100_000
    bench_eq = (1 + bench).cumprod() * 100_000
    dd = (equity / equity.cummax() - 1) * 100

    stats = portfolio.period_stats(net, bench, ann)
    bench_stats = portfolio.period_stats(bench, bench, ann)
    rel = portfolio.relative_stats(net, bench, ann)
    split = int(len(net) * (1 - HOLDOUT_FRACTION))
    is_stats = portfolio.period_stats(net.iloc[:split], bench.iloc[:split], ann)
    oos_stats = portfolio.period_stats(net.iloc[split:], bench.iloc[split:], ann)
    months, years = portfolio.calendar_returns(net, bench)

    def window(s: dict, part: pd.Series) -> dict:
        return {
            "from": str(part.index[0].date()) if len(part) else None,
            "to": str(part.index[-1].date()) if len(part) else None,
            "total_return_pct": s["total_return_pct"], "sharpe": s["sharpe"],
            "max_drawdown_pct": s["max_drawdown_pct"], "excess_pct": s["excess_pct"],
        }

    contrib = sim["contrib"]
    held = contrib[sim["days_held"] > 0]

    def rows(series: pd.Series) -> list[dict]:
        return [
            {"symbol": str(sym), "contribution_pct": round(float(v) * 100, 2),
             "avg_weight_pct": round(float(sim["avg_weight"][sym]) * 100, 2),
             "days_held": int(sim["days_held"][sym])}
            for sym, v in series.items()
        ]

    contributors = rows(held.sort_values(ascending=False).iloc[:5])
    detractors = rows(held.sort_values(ascending=True).iloc[:5])
    detractors = [d for d in detractors if d["contribution_pct"] < 0]

    target = {"as_of": None, "exposure_pct": 0.0, "weights": []}
    if sim["last_target"] is not None:
        ts, w, _scale = sim["last_target"]
        ordered = w.sort_values(ascending=False)
        target = {
            "as_of": str(pd.Timestamp(ts).date()),
            "exposure_pct": round(float(w.sum()) * 100, 1),
            "weights": [
                {"symbol": str(sym), "weight_pct": round(float(v) * 100, 2), "score_rank": rank}
                for rank, (sym, v) in enumerate(ordered.items(), start=1)
            ],
        }

    avg_turnover = float(sim["turnover"].mean())
    warnings: list[str] = []
    if (is_stats["sharpe"] is not None and oos_stats["sharpe"] is not None
            and oos_stats["sharpe"] < is_stats["sharpe"] - 0.5 and oos_stats["excess_pct"] < 0):
        warnings.append("holdout_sharpe_collapsed")
    if avg_turnover * ann > 12:  # > 12× one-way annual turnover eats most edges
        warnings.append("high_turnover")
    if sim["rebalances"] < 12:
        warnings.append("few_rebalances")
    if 0 < sim["effective_n"] < 3:
        warnings.append("concentrated")
    if universe["symbols"] < 12:
        warnings.append("low_coverage")

    return {
        "spec": spec,
        "universe": universe,
        "signal": signal,
        "portfolio": {
            "scheme": sim["scheme"], "top_n": spec["top_n"], "max_weight": spec["max_weight"],
            "rebalance": spec["rebalance"], "cost_bps": spec["cost_bps"],
            "target_vol_pct": spec["target_vol_pct"], "vol_lookback": spec["vol_lookback"],
            "avg_effective_n": round(sim["effective_n"], 2),
            "avg_exposure_pct": round(float(sim["exposure"].mean()) * 100, 1),
            "avg_turnover_pct": round(avg_turnover * 100, 2),
            "rebalances": int(sim["rebalances"]),
        },
        "backtest": {
            "span": {"from": str(net.index[0].date()), "to": str(net.index[-1].date())},
            "stats": {
                **stats,
                "beta": rel["beta"], "tracking_error_pct": rel["tracking_error_pct"],
                "information_ratio": rel["information_ratio"],
                "benchmark": {k: bench_stats[k] for k in ("total_return_pct", "cagr_pct", "ann_vol_pct", "sharpe", "max_drawdown_pct")},
            },
            "in_sample": window(is_stats, net.iloc[:split]),
            "holdout": window(oos_stats, net.iloc[split:]),
            "equity_curve": _curve(equity),
            "benchmark_curve": _curve(bench_eq),
            "drawdown_curve": _curve(dd, 3),
            "exposure_curve": _curve(sim["exposure"] * 100, 1),
            "monthly_returns": months,
            "yearly_returns": years,
        },
        "risk": {
            "drawdowns": portfolio.drawdown_episodes(equity),
            "contributors": contributors,
            "detractors": detractors,
            "concentration": {"avg_effective_n": round(sim["effective_n"], 2), "cap_binding_pct": sim["cap_binding_pct"]},
            "correlation_to_benchmark": rel["correlation"],
        },
        "alternatives": alternatives,
        "target_weights": target,
        "warnings": warnings,
    }


# ------------------------------------------------------------------ entry


def run_pipeline_blocking(raw_spec: dict, panel: dict[str, pd.DataFrame] | None = None) -> dict:
    """The whole pipeline, synchronously. Raises FactorError (400) or
    LookupError (404, from the data layer)."""
    spec = normalize_spec(raw_spec)
    panel = panel if panel is not None else _load_panel_blocking(spec["market"])
    close = panel["close"]
    universe = {
        "market": spec["market"], "symbols": int(close.shape[1]),
        "from": str(close.index[0].date()), "to": str(close.index[-1].date()), "bars": int(len(close)),
    }

    scores, signal, ranked_list = build_signal(spec, panel)
    sim = simulate(scores, panel, spec)

    # each factor alone through the same portfolio machinery
    for comp, ranks in zip(signal["components"], ranked_list):
        try:
            solo = simulate(ranks if comp["weight"] >= 0 else -ranks, panel, spec)
            comp["standalone_sharpe"] = portfolio.period_stats(solo["net"], solo["bench"], sim["ann"])["sharpe"]
        except factor_dsl.FactorError:
            comp["standalone_sharpe"] = None

    alternatives: list[dict] = []
    if spec["compare"]:
        for scheme in portfolio.SCHEMES:
            if scheme == spec["scheme"]:
                alternatives.append(_summary(sim))
                continue
            try:
                alternatives.append(_summary(simulate(scores, panel, spec, scheme=scheme)))
            except factor_dsl.FactorError:
                continue

    return report(spec, panel, signal, sim, alternatives, universe)


def current_holdings_blocking(raw_spec: dict) -> dict:
    """Paper-trading position: the latest target weights of a deployed spec."""
    spec = normalize_spec(raw_spec)
    panel = _load_panel_blocking(spec["market"])
    scores, _, _ = build_signal(spec, panel)
    sim = simulate(scores, panel, spec)
    if sim["last_target"] is None:
        return {"state": "unknown"}
    ts, w, _ = sim["last_target"]
    ordered = w.sort_values(ascending=False)
    return {
        "state": "holdings",
        "symbols": [str(s) for s in ordered.index],
        "weights_pct": [round(float(v) * 100, 2) for v in ordered.values],
        "since": str(pd.Timestamp(ts).date()),
    }
