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

import hashlib
import re
import time
from typing import Any

import numpy as np
import pandas as pd

from app.services import disk_cache, factor_dsl, panel_providers, portfolio
from app.services.factor_mine import (
    HOLDOUT_FRACTION,
    UNIVERSES,
    _daily_rank_ic,
    _load_panel_blocking,
    download_panel,
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
    {"id": "hrp", "zh": "层次风险平价 HRP", "en": "Hierarchical Risk Parity",
     "desc_zh": "López de Prado (2016)：按相关性聚类后自上而下分配风险，不求逆矩阵，协方差病态时也稳定。",
     "desc_en": "López de Prado (2016): cluster the correlation matrix and split risk top-down. No matrix inversion — stable when covariances are ill-conditioned."},
    {"id": "mean_variance", "zh": "均值-方差（Grinold α）", "en": "Mean-variance (Grinold alpha)",
     "desc_zh": "Grinold-Kahn：α = IC × σ × z 把排名换算成收益预测，再在多头、上限约束下做均值-方差优化。",
     "desc_en": "Grinold-Kahn: alpha = IC × sigma × z turns the ranking into return forecasts, then mean-variance optimise under long-only and cap constraints."},
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

# Group labels for attribution. US = GICS-style sectors of the 60-name
# universe; crypto = the categories the market itself talks in.
SECTORS: dict[str, str] = {
    **{s: "tech" for s in ("AAPL", "MSFT", "NVDA", "AVGO", "CRM", "AMD", "ORCL", "ADBE", "CSCO", "INTC", "QCOM", "TXN", "IBM")},
    **{s: "communication" for s in ("GOOG", "META", "NFLX", "DIS")},
    **{s: "consumer" for s in ("AMZN", "TSLA", "HD", "MCD", "NKE", "SBUX", "LOW", "TGT")},
    **{s: "staples" for s in ("COST", "WMT", "PG", "KO", "PEP", "PM")},
    **{s: "financials" for s in ("JPM", "V", "MA", "BAC", "GS", "MS", "BLK", "AXP")},
    **{s: "health" for s in ("UNH", "LLY", "JNJ", "MRK", "ABBV", "PFE", "TMO", "AMGN")},
    **{s: "industrials" for s in ("CAT", "HON", "UPS", "BA", "GE", "LIN")},
    **{s: "energy" for s in ("XOM", "CVX", "COP")},
    **{s: "utilities_realestate" for s in ("NEE", "DUK", "AMT", "PLD")},
    # universe expansion (~120 US names)
    **{s: "tech" for s in ("NOW", "INTU", "AMAT", "MU", "LRCX", "KLAC", "ADI", "PANW", "SNPS", "CDNS", "ANET", "PLTR")},
    **{s: "communication" for s in ("CMCSA", "TMUS", "VZ", "T", "EA", "TTWO")},
    **{s: "consumer" for s in ("BKNG", "TJX", "CMG", "ORLY", "MAR", "GM", "F")},
    **{s: "staples" for s in ("MO", "MDLZ", "CL", "KMB")},
    **{s: "financials" for s in ("WFC", "C", "SCHW", "SPGI", "CB", "PGR", "MMC")},
    **{s: "health" for s in ("ABT", "DHR", "ISRG", "GILD", "VRTX", "MDT", "BMY")},
    **{s: "industrials" for s in ("RTX", "DE", "LMT", "UNP", "ETN", "ADP", "WM")},
    **{s: "materials" for s in ("APD", "SHW", "FCX", "NEM")},
    **{s: "energy" for s in ("SLB", "EOG")},
    **{s: "utilities_realestate" for s in ("SO", "EQIX")},
    # crypto expansion (40 assets)
    **{s: "layer1" for s in ("BCH-USD", "ALGO-USD", "VET-USD", "ICP-USD", "EGLD-USD", "XTZ-USD", "EOS-USD", "FLOW-USD", "THETA-USD")},
    **{s: "defi_infra" for s in ("AAVE-USD", "MKR-USD", "GRT-USD")},
    **{s: "gaming_meta" for s in ("SAND-USD", "MANA-USD", "AXS-USD", "CHZ-USD")},
    **{s: "layer1" for s in ("BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "ADA-USD", "AVAX-USD", "DOT-USD", "TRX-USD", "NEAR-USD", "ATOM-USD", "APT-USD", "HBAR-USD")},
    **{s: "layer2" for s in ("ARB-USD", "OP-USD")},
    **{s: "payments" for s in ("XRP-USD", "LTC-USD", "XLM-USD", "ETC-USD")},
    **{s: "defi_infra" for s in ("LINK-USD", "UNI-USD", "INJ-USD", "FIL-USD")},
    **{s: "meme" for s in ("DOGE-USD", "SHIB-USD")},
}

DEFAULTS: dict[str, Any] = {
    "scheme": "inverse_vol", "signal_weighting": "ic_expanding", "top_n": 8, "rebalance": 10,
    "max_weight": 0.25, "cost_bps": 7.0, "target_vol_pct": None, "vol_lookback": 60, "horizon": 10,
    "hold_buffer": 4, "trade_rate": 1.0, "shrink_to_equal": 0.0, "history": "3y",
}
LIMITS: dict[str, list] = {
    "factors": [1, 8], "top_n": [2, 20], "rebalance": [1, 30], "max_weight": [0.05, 1.0],
    "cost_bps": [0, 50], "target_vol_pct": [5, 40], "vol_lookback": [20, 120],
    "hold_buffer": [0, 20], "trade_rate": [0.1, 1.0], "shrink_to_equal": [0.0, 1.0], "prior_trials": [0, 10_000],
}
SIGNAL_WEIGHTINGS: tuple[str, ...] = ("ic_expanding", "ic", "equal")
IC_HORIZONS: tuple[int, ...] = (1, 2, 3, 5, 10, 15, 20)
_IC_WARMUP = 60             # IC observations before expanding weights leave equal-weight
MIN_ACTIVE_IC = 0.005       # |expanding IC| below this → factor gated out of the blend
SENSITIVITY_STEPS = {"top_n": (-3, 0, 3), "rebalance": (0.5, 1.0, 2.0)}

_MIN_BARS = 60
HISTORIES: tuple[str, ...] = ("3y", "5y")
MAX_CUSTOM_SYMBOLS = 40
MIN_CUSTOM_SYMBOLS = 8
_SYMBOL_RE = re.compile(r"^[A-Z0-9^][A-Z0-9.\-=]{0,19}$")  # ^GSPC-style indices allowed
_CUSTOM_CACHE_MAX = 8
_CUSTOM_CACHE: dict[str, tuple[float, dict[str, pd.DataFrame]]] = {}
_CUSTOM_TTL = 6 * 3600


def config() -> dict:
    return {
        "markets": list(UNIVERSES),
        "universes": {k: list(v) for k, v in UNIVERSES.items()},
        "schemes": SCHEME_INFO,
        "signal_weightings": list(SIGNAL_WEIGHTINGS),
        "sectors": SECTORS,
        "starter_factors": STARTER_FACTORS,
        "defaults": DEFAULTS,
        "limits": {**LIMITS, "symbols": [MIN_CUSTOM_SYMBOLS, MAX_CUSTOM_SYMBOLS]},
        "histories": list(HISTORIES),
    }


# ----------------------------------------------------------------- spec


def _clamp(value: Any, lo: float, hi: float, cast=float):
    try:
        v = cast(value)
        if isinstance(v, float) and not np.isfinite(v):
            raise ValueError
    except (TypeError, ValueError, OverflowError):
        raise factor_dsl.FactorError(f"invalid parameter value: {value!r}") from None
    return max(lo, min(hi, v))


def normalize_spec(raw: dict) -> dict:
    """Coerce a request (or a stored paper-trading config) to a valid spec."""
    market = raw.get("market", "us")
    market = market if isinstance(market, str) and market in UNIVERSES else "us"
    symbols = parse_symbols(raw.get("symbols"))
    history = raw.get("history", DEFAULTS["history"])
    history = history if isinstance(history, str) and history in HISTORIES else DEFAULTS["history"]
    factors_in = raw.get("factors") or []
    if not isinstance(factors_in, list) or not (LIMITS["factors"][0] <= len(factors_in) <= LIMITS["factors"][1]):
        raise factor_dsl.FactorError("pipeline needs between 1 and 8 factors")
    factors = []
    for f in factors_in:
        if isinstance(f, str):
            f = {"expression": f}
        if not isinstance(f, dict):
            raise factor_dsl.FactorError("each factor must be an expression string or an object")
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
    weighting = weighting if weighting in SIGNAL_WEIGHTINGS else DEFAULTS["signal_weighting"]
    tv = raw.get("target_vol_pct")
    if tv in (None, "", 0, "0", False):
        target_vol = None
    else:
        target_vol = _clamp(tv, *LIMITS["target_vol_pct"])
        if float(tv) < LIMITS["target_vol_pct"][0]:
            raise factor_dsl.FactorError("target_vol_pct must be 0 (off) or between 5 and 40")
    return {
        "market": market,
        "symbols": symbols,
        "history": history,
        "factors": factors,
        "signal_weighting": weighting,
        "scheme": scheme,
        "top_n": int(_clamp(raw.get("top_n", DEFAULTS["top_n"]), *LIMITS["top_n"], cast=int)),
        "rebalance": int(_clamp(raw.get("rebalance", DEFAULTS["rebalance"]), *LIMITS["rebalance"], cast=int)),
        "max_weight": round(_clamp(raw.get("max_weight", DEFAULTS["max_weight"]), *LIMITS["max_weight"]), 4),
        "cost_bps": round(_clamp(raw.get("cost_bps", DEFAULTS["cost_bps"]), *LIMITS["cost_bps"]), 2),
        "target_vol_pct": round(target_vol, 2) if target_vol is not None else None,
        "vol_lookback": int(_clamp(raw.get("vol_lookback", DEFAULTS["vol_lookback"]), *LIMITS["vol_lookback"], cast=int)),
        "hold_buffer": int(_clamp(raw.get("hold_buffer", DEFAULTS["hold_buffer"]), *LIMITS["hold_buffer"], cast=int)),
        "trade_rate": round(_clamp(raw.get("trade_rate", DEFAULTS["trade_rate"]), *LIMITS["trade_rate"]), 3),
        "shrink_to_equal": round(_clamp(raw.get("shrink_to_equal", DEFAULTS["shrink_to_equal"]), *LIMITS["shrink_to_equal"]), 3),
        # configurations the user already tried before this run (the client
        # counts them) — they inflate the Deflated Sharpe's N honestly
        "prior_trials": int(_clamp(raw.get("prior_trials", 0) or 0, *LIMITS["prior_trials"], cast=int)),
        "compare": bool(raw.get("compare", True)),
    }


def parse_symbols(raw: Any) -> list[str]:
    """A user-supplied universe: 8–40 distinct tickers, or empty for the
    built-in one. Rejects anything that is not a plain ticker string."""
    if raw in (None, "", [], ()):
        return []
    if isinstance(raw, str):
        raw = re.split(r"[\s,;]+", raw)
    if not isinstance(raw, (list, tuple)):
        raise factor_dsl.FactorError("symbols must be a list of tickers")
    out: list[str] = []
    for item in raw:
        if not isinstance(item, str) or not item.isascii():
            raise factor_dsl.FactorError("symbols must be plain ASCII tickers")
        sym = item.strip().upper()
        if not sym:
            continue
        if not _SYMBOL_RE.match(sym):
            raise factor_dsl.FactorError(f"invalid symbol {item!r}")
        if sym not in out:
            out.append(sym)
    if not out:
        return []
    if not (MIN_CUSTOM_SYMBOLS <= len(out) <= MAX_CUSTOM_SYMBOLS):
        raise factor_dsl.FactorError(f"a custom universe needs {MIN_CUSTOM_SYMBOLS}–{MAX_CUSTOM_SYMBOLS} symbols (got {len(out)})")
    return out


def load_panel(spec: dict) -> dict[str, pd.DataFrame]:
    """The OHLCV panel for a spec: the shared built-in universe when no
    symbols are given and history is 3y, otherwise a custom download cached
    (memory + disk) for 6 hours under a key derived from the request."""
    if not spec["symbols"] and spec["history"] == "3y":
        return _load_panel_blocking(spec["market"])
    tickers = spec["symbols"] or list(UNIVERSES[spec["market"]])
    from app.config import get_settings

    st = get_settings()
    digest = hashlib.sha1(",".join(sorted(tickers)).encode()).hexdigest()[:12]
    key = f"panel-custom-{spec['history']}-{digest}-{st.panel_provider_us}-{st.panel_provider_crypto}"
    hit = _CUSTOM_CACHE.get(key)
    if hit and time.time() - hit[0] < _CUSTOM_TTL:
        return hit[1]
    disk = disk_cache.load(key, _CUSTOM_TTL)
    if isinstance(disk, dict) and "close" in disk:
        _remember_custom(key, disk)
        return disk
    label = "custom" if spec["symbols"] else spec["market"]
    panel = download_panel(tickers, spec["history"], label, min_symbols=MIN_CUSTOM_SYMBOLS,
                           market=None if spec["symbols"] else spec["market"])
    _remember_custom(key, panel)
    disk_cache.store(key, panel)
    return panel


def _remember_custom(key: str, panel: dict[str, pd.DataFrame]) -> None:
    """Bounded in-memory cache: expired entries go first, then the oldest, so
    an anonymous client permuting ticker lists cannot grow the process."""
    now = time.time()
    for k in [k for k, (ts, _) in _CUSTOM_CACHE.items() if now - ts >= _CUSTOM_TTL]:
        _CUSTOM_CACHE.pop(k, None)
    while len(_CUSTOM_CACHE) >= _CUSTOM_CACHE_MAX:
        oldest = min(_CUSTOM_CACHE, key=lambda k: _CUSTOM_CACHE[k][0])
        _CUSTOM_CACHE.pop(oldest, None)
    _CUSTOM_CACHE[key] = (now, panel)


# --------------------------------------------------------------- signal


def build_signal(spec: dict, panel: dict[str, pd.DataFrame]) -> tuple[pd.DataFrame, dict, list[pd.DataFrame]]:
    """Composite cross-sectional score in rank space, plus component
    diagnostics. Returns (scores, signal_info, per_factor_ranks).

    Three blends:
      ic_expanding — weights at day t use only IC observations whose forward
                     window closed before t (expanding mean, lagged by the
                     horizon). Every day of the backtest is out-of-sample
                     with respect to the blend; equal-weight during warm-up.
      ic           — one static weight per factor from the first 80% window
                     (the legacy composite; the holdout is still clean).
      equal        — 1/n with the sign fixed by the in-sample IC.
    """
    close = panel["close"]
    ranked_list: list[pd.DataFrame] = []
    ic_series: list[pd.Series] = []
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
        # an IC observation at day s needs returns through s+h; the last
        # in-sample observation must have CLOSED before the holdout begins
        split = max(1, int(len(ic) * (1 - HOLDOUT_FRACTION)) - f["horizon"])
        is_ic = float(ic.iloc[:split].mean()) if split > 0 else 0.0
        oos_ic = float(ic.iloc[split:].mean()) if split < len(ic) else 0.0
        ranked_list.append(values.rank(axis=1, pct=True))
        ic_series.append(ic)
        components.append({
            "expression": f["expression"], "invert": f["invert"], "horizon": f["horizon"],
            "is_ic": round(is_ic if np.isfinite(is_ic) else 0.0, 4),
            "oos_ic": round(oos_ic if np.isfinite(oos_ic) else 0.0, 4),
        })

    n = len(ranked_list)
    max_pair_corr = 0.0
    corr_matrix = [[1.0 if i == j else None for j in range(n)] for i in range(n)]
    for i in range(n):
        for j in range(i + 1, n):
            pair = pd.concat([ranked_list[i].stack(), ranked_list[j].stack()], axis=1).dropna()
            if len(pair) > 200:
                c = float(pair.iloc[:, 0].corr(pair.iloc[:, 1]))
                if np.isfinite(c):
                    corr_matrix[i][j] = corr_matrix[j][i] = round(c, 3)
                    max_pair_corr = max(max_pair_corr, abs(c))

    weighting = spec["signal_weighting"]
    if weighting == "ic_expanding":
        # weight_t(f) = expanding mean of IC_f over observations known at t
        cols = []
        for f, ic in zip(spec["factors"], ic_series):
            known = ic.reindex(close.index).expanding(min_periods=_IC_WARMUP).mean().shift(f["horizon"] + 1)
            cols.append(known)
        w_t = pd.concat(cols, axis=1)
        w_t.columns = range(n)
        # AlphaForge-style dynamic selection (Shi et al. 2024): a factor whose
        # realised IC is indistinguishable from zero is switched OFF rather
        # than flipped — flipping a coin-toss signal only adds noise. If every
        # factor is gated out the blend falls back to equal weight.
        gated = w_t.where(w_t.abs() >= MIN_ACTIVE_IC, 0.0)
        mags = gated.abs()
        total = mags.sum(axis=1)
        warm = w_t.notna().all(axis=1)
        w_t = gated.div(total.where(total > 1e-9), axis=0)
        w_t = w_t.where(warm & (total > 1e-9), 1.0 / n)
        scores = sum(ranked_list[k].mul(w_t[k], axis=0) for k in range(n))
        for k, c in enumerate(components):
            c["weight"] = round(float(w_t[k].iloc[-1]), 3)
            c["avg_weight"] = round(float(w_t[k].mean()), 3)
            live = w_t[k][warm]
            c["active_pct"] = round(float((live.abs() > 1e-12).mean() * 100), 1) if len(live) else 100.0
    else:
        signs = [1.0 if c["is_ic"] >= 0 else -1.0 for c in components]
        if weighting == "ic":
            mags = [abs(c["is_ic"]) for c in components]
            total = sum(mags)
            mags = [m / total if total > 1e-9 else 1.0 / n for m in mags]
        else:
            mags = [1.0 / n] * n
        weights = [sg * m for sg, m in zip(signs, mags)]
        for c, w in zip(components, weights):
            c["weight"] = round(w, 3)
            c["avg_weight"] = round(w, 3)
            c["active_pct"] = 100.0
        scores = sum(r * w for r, w in zip(ranked_list, weights))

    # composite diagnostics: IC at several horizons (the information-horizon
    # curve of Grinold & Kahn) — tells the user how fast the blend decays and
    # therefore how often it is worth rebalancing
    ic_by_horizon = []
    for h in IC_HORIZONS:
        fwd = close.pct_change(h).shift(-h)
        ic_h = _daily_rank_ic(scores, fwd)
        ic_by_horizon.append({"horizon": h, "ic": _r(float(ic_h.mean()), 4) if len(ic_h) >= 30 else None})
    main_h = max(1, int(round(float(np.mean([f["horizon"] for f in spec["factors"]])))))
    ic_main = _daily_rank_ic(scores, close.pct_change(main_h).shift(-main_h))
    split = max(1, int(len(ic_main) * (1 - HOLDOUT_FRACTION)) - main_h)
    composite_is_ic = float(ic_main.iloc[:split].mean()) if split > 0 else 0.0

    info = {
        "weighting": weighting, "components": components, "max_pair_corr": round(max_pair_corr, 3),
        "corr_matrix": corr_matrix,
        "ic_by_horizon": ic_by_horizon,
        "composite_is_ic": round(composite_is_ic if np.isfinite(composite_is_ic) else 0.0, 4),
        "composite_oos_ic": _r(float(ic_main.iloc[split:].mean()), 4) if split < len(ic_main) else None,
    }
    return scores, info, ranked_list


# ------------------------------------------------------------- simulate


def _select(candidates: pd.Series, top_n: int, buffer: int, held: set) -> pd.Series:
    """Top-N selection with a hold buffer (banding): a name already held stays
    as long as it ranks within top_n + buffer, and new names enter only into
    the slots that frees up. Zero buffer = plain top-N. This is the classic
    turnover reducer (cf. Qlib's TopkDropout, index-rebalancing bands)."""
    ranked = candidates.sort_values(ascending=False)
    if buffer <= 0 or not held:
        return ranked.iloc[:top_n]
    keep = [s for s in ranked.index[: top_n + buffer] if s in held][:top_n]
    for s in ranked.index:
        if len(keep) >= top_n:
            break
        if s not in keep:
            keep.append(s)
    return ranked.loc[keep]


def _decide_weights(
    scheme: str,
    row_scores: pd.Series,
    trailing: pd.DataFrame,
    spec: dict,
    ann: int,
    held: set | None = None,
    ic: float | None = None,
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
    if held and spec["hold_buffer"] > 0:
        # a held name whose score is missing TODAY (data hiccup) is not sold
        # on that account: it is treated as sitting at the edge of the band
        missing = [h for h in held if h not in candidates.index and bool(usable.get(h, False))]
        if missing:
            edge = candidates.sort_values(ascending=False).iloc[min(top_n, len(candidates)) - 1]
            candidates = pd.concat([candidates, pd.Series(edge, index=missing)])
    selected = _select(candidates, top_n, spec["hold_buffer"], held or set())
    sub = trailing[selected.index]
    w = portfolio.construct(scheme, selected.values, sub.values, spec["max_weight"], ic=ic)
    if spec.get("shrink_to_equal", 0) > 0 and len(w):
        # DeMiguel-Garlappi-Uppal (2009): optimisers rarely beat 1/N out of
        # sample; blending toward it hedges estimation error
        lam = spec["shrink_to_equal"]
        w = (1 - lam) * w + lam * (w.sum() / len(w))
    scale = 1.0
    if spec["target_vol_pct"]:
        scale = portfolio.vol_scale(w, sub.values, spec["target_vol_pct"] / 100.0, ann)
    return pd.Series(w * scale, index=selected.index), scale


def simulate(scores: pd.DataFrame, panel: dict[str, pd.DataFrame], spec: dict, scheme: str | None = None,
             ic: float | None = None) -> dict:
    """Run the portfolio through history. Returns raw series for reporting."""
    scheme = scheme or spec["scheme"]
    market = spec["market"]
    ann = 252 if market == "us" else 365
    close = panel["close"]
    # forward-fill BEFORE differencing: a single missing close would otherwise
    # turn two daily returns into NaN (→ 0) and silently erase the move across
    # the gap. Leading NaNs (late listings) stay NaN; a delisted name earns 0.
    ret = close.ffill().pct_change()
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
    held_hist = np.zeros((T, N))
    trade_hist = np.zeros((T, N))  # |Δw| per name on trade days — feeds the impact model
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
            # partial adjustment toward the aim portfolio (Gârleanu & Pedersen
            # 2013): trade only a fraction of the distance when costs matter
            target = held + spec["trade_rate"] * (target - held)
            trade_hist[i] = np.abs(target - held)
            turnover[i] = float(trade_hist[i].sum()) / 2
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
        held_hist[i] = held
        exposure[i] = float(held.sum())
        held = held * (1 + r) / (1 + g) if abs(1 + g) > 1e-9 else held
        # decide the next weights on today's close
        if i in rebalance_days and i + 1 < T:
            trailing = ret.iloc[i - lookback + 1: i + 1]
            current = {symbols[k] for k in np.flatnonzero(held > 1e-6)}
            w, scale = _decide_weights(scheme, scores.iloc[i], trailing, spec, ann, held=current, ic=ic)
            if len(w):
                pending = w
                n_rebal += 1
                eff_n.append(portfolio.effective_n(w.values))
                unscaled = w.values / scale if scale > 1e-9 else w.values
                if spec["max_weight"] < 1 and (unscaled >= spec["max_weight"] - 1e-9).any():
                    cap_hits += 1

    # latest decision (for target weights): newest complete row with a full cross-section
    current = {symbols[k] for k in np.flatnonzero(held > 1e-6)}
    # the newest row is often partial (a few names not yet printed): only a
    # row with a near-complete cross-section may define the live target
    counts = scores.notna().sum(axis=1)
    typical = float(counts.iloc[first:].median()) if T > first else 0.0
    needed = max(spec["top_n"], int(np.ceil(0.8 * typical)))
    for i in range(T - 1, max(first, T - 8) - 1, -1):
        if counts.iloc[i] < needed:
            continue
        trailing = ret.iloc[i - lookback + 1: i + 1]
        w, scale = _decide_weights(scheme, scores.iloc[i], trailing, spec, ann, held=current, ic=ic)
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
        "gross": pd.Series(gross[first:], index=index),
        "bench": bench_s,
        "turnover": pd.Series(turnover[first:], index=index),
        "exposure": pd.Series(exposure[first:], index=index),
        "held": pd.DataFrame(held_hist[first:], index=index, columns=symbols),
        "trades": pd.DataFrame(trade_hist[first:], index=index, columns=symbols),
        "bench_w": bench_w.shift(1).loc[index],
        "returns": ret.loc[index],
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


def _r(x, digits: int = 2):
    return None if x is None or not np.isfinite(x) else round(float(x), digits)


def _daily_sharpe(sim: dict) -> float | None:
    sd = float(sim["net"].std(ddof=1))
    return float(sim["net"].mean() / sd) if sd > 1e-12 else None


def _summary(sim: dict) -> dict:
    stats = portfolio.period_stats(sim["net"], sim["bench"], sim["ann"])
    return {
        "scheme": sim["scheme"],
        "total_return_pct": stats["total_return_pct"],
        "sharpe": stats["sharpe"],
        "psr": _r(portfolio.probabilistic_sharpe(sim["net"]), 3),
        "max_drawdown_pct": stats["max_drawdown_pct"],
        "ann_vol_pct": stats["ann_vol_pct"],
        "avg_turnover_pct": round(float(sim["turnover"].mean() * 100), 2),
    }


def report(spec: dict, panel: dict[str, pd.DataFrame], signal: dict, sim: dict,
           alternatives: list[dict], universe: dict, trial_sharpes: list[float] | None = None) -> dict:
    net, bench, ann = sim["net"], sim["bench"], sim["ann"]
    equity = (1 + net).cumprod() * 100_000
    bench_eq = (1 + bench).cumprod() * 100_000
    dd = (equity / equity.cummax() - 1) * 100

    stats = portfolio.period_stats(net, bench, ann)
    stats["rolling_6m_beat_pct"] = portfolio.rolling_window_beat_pct(net, bench, 126)
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
        by_group: dict[str, float] = {}
        for sym, v in ordered.items():
            by_group[SECTORS.get(str(sym), "other")] = by_group.get(SECTORS.get(str(sym), "other"), 0.0) + float(v)
        target = {
            "as_of": str(pd.Timestamp(ts).date()),
            "exposure_pct": round(float(w.sum()) * 100, 1),
            "weights": [
                {"symbol": str(sym), "weight_pct": round(float(v) * 100, 2), "score_rank": rank,
                 "group": SECTORS.get(str(sym), "other")}
                for rank, (sym, v) in enumerate(ordered.items(), start=1)
            ],
            "groups": [
                {"group": g, "weight_pct": round(v * 100, 2)}
                for g, v in sorted(by_group.items(), key=lambda kv: -kv[1])
            ],
        }

    avg_turnover = float(sim["turnover"].mean())
    total_turnover = float(sim["turnover"].sum())
    gross_total = float((1 + sim["gross"]).prod() - 1)
    bench_total = float((1 + bench).prod() - 1)
    breakeven = (gross_total - bench_total) / total_turnover * 10_000 if total_turnover > 1e-9 else None

    psr = portfolio.probabilistic_sharpe(net)
    holdout_psr = portfolio.probabilistic_sharpe(net.iloc[split:])
    dsr = portfolio.deflated_sharpe(net, trial_sharpes or [], extra_trials=spec.get("prior_trials", 0))
    capture = portfolio.capture_ratios(net, bench)
    rolling = pd.concat([net, bench], axis=1).dropna()
    rb = rolling.iloc[:, 0].rolling(60).cov(rolling.iloc[:, 1]) / rolling.iloc[:, 1].rolling(60).var()
    rolling_beta = rb.dropna()

    tstat = portfolio.sharpe_tstat(net)
    min_trl = portfolio.min_track_record_length(net)
    regimes = portfolio.regime_table(net, bench, ann)
    groups = {k: v for k, v in SECTORS.items()}
    attribution = portfolio.brinson(sim["held"], sim["bench_w"], sim["returns"], groups)

    warnings: list[str] = []
    if psr is not None and psr < 0.9:
        warnings.append("low_psr")
    if tstat is not None and tstat < 2:
        warnings.append("not_significant")
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
            "annual_turnover_x": round(avg_turnover * ann, 2),
            "breakeven_cost_bps": _r(breakeven, 1),
            "hold_buffer": spec["hold_buffer"], "trade_rate": spec["trade_rate"],
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
            "holdout": {**window(oos_stats, net.iloc[split:]), "psr": _r(holdout_psr, 3)},
            "overfitting": {
                "psr": _r(psr, 3),
                "dsr": _r(dsr["dsr"], 3),
                "trials": dsr["trials"],
                "expected_max_sharpe_ann": _r(dsr["expected_max_sharpe"] * np.sqrt(ann) if dsr["expected_max_sharpe"] is not None else None, 2),
                "t_stat": tstat,
                "hlz_hurdle": 3.0,
                "min_track_record_days": min_trl,
                "track_days": int(len(net)),
            },
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
            "capture": capture,
            "cvar_95_pct": portfolio.cvar(net, 0.95),
            "bench_cvar_95_pct": portfolio.cvar(bench, 0.95),
            "rolling_beta": _curve(rolling_beta, 3),
            "regimes": regimes,
            "attribution": attribution,
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
    panel = panel if panel is not None else load_panel(spec)
    close = panel["close"]
    universe = {
        "market": spec["market"], "symbols": int(close.shape[1]),
        "from": str(close.index[0].date()), "to": str(close.index[-1].date()), "bars": int(len(close)),
        "custom": bool(spec["symbols"]), "history": spec["history"],
        "requested": len(spec["symbols"]) if spec["symbols"] else None,
        "dropped": sorted(set(spec["symbols"]) - set(map(str, close.columns))) if spec["symbols"] else [],
        "health": data_health(panel),
        "provider": panel_providers.provider_of(panel),
    }

    scores, signal, ranked_list = build_signal(spec, panel)
    ic = signal["composite_is_ic"]
    signal["quantiles"] = portfolio.quantile_returns(scores, close.ffill().pct_change(), 252 if spec["market"] == "us" else 365)
    sim = simulate(scores, panel, spec, ic=ic)
    trials: list[float] = []  # every configuration evaluated → the DSR's N

    # each factor alone through the same portfolio machinery
    for comp, ranks in zip(signal["components"], ranked_list):
        try:
            solo = simulate(ranks if comp["is_ic"] >= 0 else -ranks, panel, spec, ic=abs(comp["is_ic"]))
            comp["standalone_sharpe"] = portfolio.period_stats(solo["net"], solo["bench"], sim["ann"])["sharpe"]
            trials.append(_daily_sharpe(solo))
        except factor_dsl.FactorError:
            comp["standalone_sharpe"] = None

    alternatives: list[dict] = []
    if spec["compare"]:
        sims: dict[str, dict] = {}
        for scheme in portfolio.SCHEMES:
            if scheme == spec["scheme"]:
                sims[scheme] = sim
                continue
            try:
                alt = simulate(scores, panel, spec, scheme=scheme, ic=ic)
                sims[scheme] = alt
                trials.append(_daily_sharpe(alt))
            except factor_dsl.FactorError:
                continue
        # every scheme is tested against 1/N (DeMiguel et al.): the Sharpe gap
        # and a Ledoit-Wolf bootstrap p-value — "better" has to survive noise
        equal = sims.get("equal")
        for scheme, s_ in sims.items():
            row = _summary(s_)
            if equal is not None and scheme != "equal":
                test = portfolio.sharpe_difference_test(s_["net"], equal["net"])
                row["delta_sharpe_vs_equal_ann"] = _r(test["delta_sharpe"] * np.sqrt(sim["ann"]) if test["delta_sharpe"] is not None else None, 2)
                row["p_value_vs_equal"] = test["p_value"]
            else:
                row["delta_sharpe_vs_equal_ann"] = 0.0 if scheme == "equal" else None
                row["p_value_vs_equal"] = None
            alternatives.append(row)
    trials.append(_daily_sharpe(sim))

    # Parameter sensitivity (López de Prado's "plateau vs spike" test): the
    # same signal and scheme on a 3×3 grid around the chosen top_n × rebalance.
    # A robust result degrades gently; an overfit one collapses one step away.
    sensitivity = None
    if spec["compare"]:
        top_ns = sorted({int(min(LIMITS["top_n"][1], max(LIMITS["top_n"][0], spec["top_n"] + d))) for d in SENSITIVITY_STEPS["top_n"]})
        rebs = sorted({int(min(LIMITS["rebalance"][1], max(LIMITS["rebalance"][0], round(spec["rebalance"] * m)))) for m in SENSITIVITY_STEPS["rebalance"]})
        grid = []
        for tn in top_ns:
            row = []
            for rb in rebs:
                if tn == spec["top_n"] and rb == spec["rebalance"]:
                    cell_sim = sim
                else:
                    try:
                        cell_sim = simulate(scores, panel, {**spec, "top_n": tn, "rebalance": rb}, ic=ic)
                        trials.append(_daily_sharpe(cell_sim))
                    except factor_dsl.FactorError:
                        row.append(None)
                        continue
                st = portfolio.period_stats(cell_sim["net"], cell_sim["bench"], sim["ann"])
                row.append({"sharpe": st["sharpe"], "excess_pct": st["excess_pct"], "max_drawdown_pct": st["max_drawdown_pct"]})
            grid.append(row)
        sharpes = [c["sharpe"] for r_ in grid for c in r_ if c and c["sharpe"] is not None]
        centre = portfolio.period_stats(sim["net"], sim["bench"], sim["ann"])["sharpe"]
        sensitivity = {
            "top_n": top_ns, "rebalance": rebs, "cells": grid,
            "median_sharpe": _r(float(np.median(sharpes)), 2) if sharpes else None,
            "min_sharpe": _r(min(sharpes), 2) if sharpes else None,
            # spike ratio: how far the chosen cell sits above the neighbourhood median
            "spike": _r(centre - float(np.median(sharpes)), 2) if sharpes and centre is not None else None,
        }

    out = report(spec, panel, signal, sim, alternatives, universe, [t for t in trials if t is not None])
    out["sensitivity"] = sensitivity
    out["capacity"] = capacity_curve(sim, panel, spec, out["backtest"]["stats"])
    if out["capacity"]["breakeven_aum"] is not None and out["capacity"]["breakeven_aum"] < 1e7:
        out["warnings"].append("low_capacity")
    if sensitivity and sensitivity["spike"] is not None and sensitivity["spike"] > 0.5:
        out["warnings"].append("parameter_spike")
    return out


def current_holdings_blocking(raw_spec: dict) -> dict:
    """Paper-trading position: the latest target weights of a deployed spec."""
    spec = normalize_spec(raw_spec)
    panel = load_panel(spec)
    scores, signal, _ = build_signal(spec, panel)
    sim = simulate(scores, panel, spec, ic=signal["composite_is_ic"])
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


# ------------------------------------------------------------- execution


def orders_blocking(raw_spec: dict, nav: float, current: dict[str, float] | None = None,
                    min_trade_pct: float = 0.25, panel: dict[str, pd.DataFrame] | None = None) -> dict:
    """Rebalance ticket: the trades that move a real book (`nav` in account
    currency, `current` = {symbol: shares}) to the pipeline's latest target
    weights. Reference prices are the last available closes in the panel —
    the sheet says so, and the user fills at the open. Trades below
    `min_trade_pct` of NAV are suppressed as dust."""
    spec = normalize_spec(raw_spec)
    if not np.isfinite(nav) or nav <= 0:
        raise factor_dsl.FactorError("nav must be a positive number")
    panel = panel if panel is not None else load_panel(spec)
    scores, signal, _ = build_signal(spec, panel)
    sim = simulate(scores, panel, spec, ic=signal["composite_is_ic"])
    if sim["last_target"] is None:
        raise factor_dsl.FactorError("no complete bar to build target weights from")
    ts, target, _scale = sim["last_target"]
    prices = panel["close"].ffill().iloc[-1]

    holdings: dict[str, float] = {}
    for sym, shares in (current or {}).items():
        s_ = str(sym).strip().upper()
        try:
            q = float(shares)
        except (TypeError, ValueError):
            raise factor_dsl.FactorError(f"invalid share count for {sym!r}") from None
        if q < 0 or not np.isfinite(q) or q > 1e12:
            raise factor_dsl.FactorError(f"share count for {s_} must be a non-negative number below 1e12")
        if len(s_) > 32:
            raise factor_dsl.FactorError("symbol too long")
        if q > 0:
            holdings[s_] = holdings.get(s_, 0.0) + q

    symbols = sorted(set(target.index.astype(str)) | set(holdings))
    orders: list[dict] = []
    unpriced: list[str] = []
    buy_total = sell_total = 0.0
    invested_now = 0.0
    for sym in symbols:
        px = float(prices.get(sym, np.nan))
        if not np.isfinite(px) or px <= 0:
            unpriced.append(sym)
            continue
        cur_sh = holdings.get(sym, 0.0)
        cur_val = cur_sh * px
        if not np.isfinite(cur_val) or cur_val > 1e15:
            raise factor_dsl.FactorError(f"position in {sym} is implausibly large")
        invested_now += cur_val
        tgt_w = float(target.get(sym, 0.0))
        tgt_val = tgt_w * nav
        delta = tgt_val - cur_val
        if abs(delta) < nav * min_trade_pct / 100:
            continue
        shares = int(np.floor(abs(delta) / px))
        if shares == 0:
            continue
        notional = shares * px
        side = "buy" if delta > 0 else "sell"
        if side == "sell":
            shares = min(shares, int(np.floor(cur_sh)))  # never short
            notional = shares * px
            if shares == 0:
                continue
            sell_total += notional
        else:
            buy_total += notional
        orders.append({
            "symbol": sym, "side": side, "shares": shares, "price": round(px, 4),
            "notional": round(notional, 2),
            "from_weight_pct": round(cur_val / nav * 100, 2), "to_weight_pct": round(tgt_w * 100, 2),
            "group": SECTORS.get(sym, "other"),
        })
    orders.sort(key=lambda o: (o["side"] != "sell", -o["notional"]))  # sells first (they fund the buys)
    cost = (buy_total + sell_total) * spec["cost_bps"] / 10_000
    # with an unpriceable holding the cash split of NAV is unknown — say so
    # rather than report the unpriced position as cash
    cash_known = not unpriced
    cash_now = nav - invested_now if cash_known else None
    return {
        "as_of": str(pd.Timestamp(ts).date()),
        "price_date": str(prices.name.date()) if hasattr(prices.name, "date") else None,
        "nav": round(nav, 2),
        "orders": orders,
        "unpriced": unpriced,
        "summary": {
            "buys": len([o for o in orders if o["side"] == "buy"]),
            "sells": len([o for o in orders if o["side"] == "sell"]),
            "buy_notional": round(buy_total, 2), "sell_notional": round(sell_total, 2),
            "turnover_pct": round((buy_total + sell_total) / 2 / nav * 100, 2),
            "est_cost": round(cost, 2),
            "cash_before": round(cash_now, 2) if cash_known else None,
            "cash_after": round(cash_now + sell_total - buy_total - cost, 2) if cash_known else None,
            "cash_unknown": not cash_known,
            "target_exposure_pct": round(float(target.sum()) * 100, 1),
        },
    }


# ------------------------------------------------------- data & capacity


def data_health(panel: dict[str, pd.DataFrame]) -> list[dict]:
    """Per-symbol data quality: coverage, gaps, first/last print. Custom
    universes bring whatever Yahoo has — the user should see it."""
    close = panel["close"]
    rows = []
    for sym in close.columns:
        col = close[sym]
        valid = col.notna()
        if not valid.any():
            rows.append({"symbol": str(sym), "group": SECTORS.get(str(sym), "other"), "coverage_pct": 0.0,
                         "gaps": 0, "first": None, "last": None, "stale_days": int(len(close)), "stale": True})
            continue
        first, last = col.first_valid_index(), col.last_valid_index()
        inner = valid.loc[first:last]
        stale_days = int(len(close) - 1 - close.index.get_loc(last))
        rows.append({
            "symbol": str(sym),
            "group": SECTORS.get(str(sym), "other"),
            "coverage_pct": round(float(valid.mean()) * 100, 1),
            "gaps": int((~inner).sum()),                # missing prints between first and last
            "first": str(pd.Timestamp(first).date()),
            "last": str(pd.Timestamp(last).date()),
            "stale_days": stale_days,
            # the newest 1–3 bars are often partial; only a longer silence means delisted/halted
            "stale": stale_days > 3,
        })
    rows.sort(key=lambda r: (r["coverage_pct"], r["symbol"]))
    return rows


AUM_GRID: tuple[float, ...] = (1e6, 1e7, 1e8, 1e9)
IMPACT_COEF = 1.0          # square-root law: cost = coef · σ_daily · sqrt(participation)
ADV_WINDOW = 20


def capacity_curve(sim: dict, panel: dict[str, pd.DataFrame], spec: dict, stats: dict) -> dict:
    """How much money can this run? Market impact per trade follows the
    square-root law (Almgren et al. 2005; Gatheral 2010):

        impact_i = IMPACT_COEF · σ_i · sqrt(Q_i / ADV_i),   Q_i = |Δw_i| · AUM

    charged on the traded notional. For each AUM on the grid the annualised
    drag is subtracted from the excess return over the benchmark; the
    breakeven AUM is where net excess crosses zero (log-interpolated). Yahoo
    volume is in shares for equities (× price → dollar ADV) and already in
    quote currency for crypto."""
    trades = sim["trades"]
    if trades.empty or float(trades.values.sum()) <= 0:
        return {"aum_grid": list(AUM_GRID), "impact_drag_pct_ann": [None] * len(AUM_GRID),
                "net_excess_pct_ann": [None] * len(AUM_GRID), "participation_pct": [None] * len(AUM_GRID),
                "breakeven_aum": None, "excess_pct_ann": None}
    ann = sim["ann"]
    close = panel["close"].ffill()
    vol = panel["volume"].reindex(columns=trades.columns)
    # Yahoo reports crypto volume in quote currency already; equities in shares
    is_quote_ccy = pd.Series([str(c).upper().endswith(("-USD", "-USDT", "-USDC")) for c in vol.columns], index=vol.columns)
    dollar_vol = vol.where(is_quote_ccy, vol * close.reindex(columns=vol.columns))
    dollar_vol = dollar_vol.rolling(ADV_WINDOW, min_periods=5).mean()
    adv = dollar_vol.shift(1).reindex(index=trades.index, columns=trades.columns)   # known before the trade
    # a name without volume data borrows that day's cross-sectional median ADV
    # rather than being costed at zero — understating impact is the worse error
    adv = adv.apply(lambda row: row.fillna(row.median()), axis=1)
    sigma = close.pct_change().rolling(ADV_WINDOW, min_periods=5).std().shift(1).reindex(index=trades.index, columns=trades.columns)
    sigma = sigma.apply(lambda row: row.fillna(row.median()), axis=1)
    mask = trades.values > 0
    tw_all = trades.values[mask]
    adv_v = adv.values[mask].astype(float)
    sig_v = sigma.values[mask].astype(float)
    ok = np.isfinite(adv_v) & (adv_v > 0) & np.isfinite(sig_v)
    costed_pct = float(tw_all[ok].sum() / tw_all.sum() * 100) if tw_all.sum() > 0 else 0.0
    tw, adv_v, sig_v = tw_all[ok], adv_v[ok], sig_v[ok]
    if len(tw) == 0:
        return {"aum_grid": list(AUM_GRID), "impact_drag_pct_ann": [None] * len(AUM_GRID),
                "net_excess_pct_ann": [None] * len(AUM_GRID), "participation_pct": [None] * len(AUM_GRID),
                "breakeven_aum": None, "excess_pct_ann": None, "costed_trade_pct": 0.0, "model": "sqrt_impact"}
    years = len(sim["net"]) / ann
    excess_ann = None
    if stats.get("cagr_pct") is not None and stats.get("benchmark", {}).get("cagr_pct") is not None:
        excess_ann = float(stats["cagr_pct"] - stats["benchmark"]["cagr_pct"])
    elif years > 0:
        excess_ann = float(stats["excess_pct"]) / years
    drags, nets, parts = [], [], []
    exact_drags = []
    for aum in AUM_GRID:
        q = tw * aum                                    # traded notional per name
        participation = q / adv_v
        cost = IMPACT_COEF * sig_v * np.sqrt(participation) * tw   # fraction of NAV lost on each trade
        drag_ann = float(cost.sum()) / max(years, 1e-9) * 100
        exact_drags.append(drag_ann)
        drags.append(round(drag_ann, 3))
        nets.append(round(excess_ann - drag_ann, 2) if excess_ann is not None else None)
        parts.append(round(float(np.mean(participation)) * 100, 3))
    breakeven = None
    if excess_ann is not None and excess_ann > 0 and exact_drags[0] > 0:
        # drag scales as AUM^0.5 → AUM* = AUM_ref · (excess / drag_ref)^2 (unrounded reference)
        breakeven = float(AUM_GRID[0] * (excess_ann / exact_drags[0]) ** 2)
    return {
        "aum_grid": list(AUM_GRID),
        "impact_drag_pct_ann": drags,
        "net_excess_pct_ann": nets,
        "participation_pct": parts,
        "excess_pct_ann": _r(excess_ann, 2),
        "breakeven_aum": _r(breakeven, 0),
        "costed_trade_pct": round(costed_pct, 1),
        "model": "sqrt_impact",
    }
