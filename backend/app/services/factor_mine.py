"""Loop-engineered alpha factor mining.

The architecture follows the 2025 LLM-alpha-mining literature — most directly
Chain-of-Alpha (arXiv:2508.06312, dual generate/optimize chains driven by
backtest feedback), with AlphaAgent's complexity regularization
(arXiv:2502.16789) and QuantAgent-style accumulated knowledge:

  round k:  Claude proposes N candidate factor expressions (a forced tool
            call — the only delivery channel), guided by everything learned
            in rounds 1..k-1;
  evaluate: every candidate runs against a real cross-sectional panel —
            rank IC / ICIR on an in-sample window, an untouched holdout,
            redundancy vs the accepted zoo, complexity caps;
  feedback: results are compressed into *directive* feedback (weak signal →
            strengthen; unstable → stabilize; redundant → diversify; parse
            errors quoted verbatim), which steers round k+1.

The loop itself is deterministic Python — the LLM only ever fills in the
generation step, so every metric shown to the user comes from our own math.

Honesty rules mirror the rest of the platform: the holdout window is never
part of feedback (the LLM cannot fit to it), acceptance requires the holdout
to CONFIRM the in-sample sign, and factors that fail are shown failing.
"""

from __future__ import annotations

import asyncio
import logging
import time
from typing import Any, AsyncIterator

import numpy as np
import pandas as pd
import yfinance as yf

from app.config import get_settings
from app.services import disk_cache, factor_dsl
from app.services.llm import ClaudeUnavailable, analyst

log = logging.getLogger("aiquant.factors")

UNIVERSES: dict[str, list[str]] = {
    "us": [
        "AAPL", "MSFT", "NVDA", "GOOG", "AMZN", "META", "TSLA", "AVGO",
        "JPM", "V", "UNH", "XOM", "LLY", "JNJ", "PG", "HD",
        "COST", "MRK", "ABBV", "CRM", "AMD", "NFLX", "WMT", "BAC",
    ],
    "crypto": [
        "BTC-USD", "ETH-USD", "SOL-USD", "BNB-USD", "XRP-USD", "DOGE-USD",
        "ADA-USD", "AVAX-USD", "DOT-USD", "LTC-USD", "LINK-USD", "TRX-USD",
        "SHIB-USD", "NEAR-USD", "UNI-USD", "ATOM-USD",
    ],
}

HOLDOUT_FRACTION = 0.2      # trailing slice the LLM never gets feedback on
MIN_ABS_IC = 0.015          # "standard" in-sample bar (kept for tests/back-compat)
MAX_ZOO_CORR = 0.7          # redundancy ceiling vs accepted factors
MAX_COMPLEXITY = 24         # AST nodes — AlphaAgent-style regularizer
MIN_COVERAGE = 0.55         # fraction of days with a computable cross-section

# Acceptance tiers: (min |in-sample IC|, min |in-sample ICIR|). The holdout
# same-sign confirmation is NON-negotiable in every tier — loosening only
# lowers the magnitude bars, and the UI warns that loose = more overfit risk.
MODES: dict[str, tuple[float, float]] = {
    "strict": (0.02, 0.25),
    "standard": (0.015, 0.15),
    "loose": (0.01, 0.08),
}

_PANEL_CACHE: dict[str, tuple[float, dict[str, pd.DataFrame]]] = {}
_PANEL_TTL = 6 * 3600
MAX_LEN_HINT = 240


# ------------------------------------------------------------------- data


def _load_panel_blocking(market: str) -> dict[str, pd.DataFrame]:
    cached = _PANEL_CACHE.get(market)
    if cached and time.time() - cached[0] < _PANEL_TTL:
        return cached[1]

    # Disk layer: survives process restarts and serverless instance churn,
    # and cuts the 40-ticker × 3y Yahoo download to one fetch per TTL window.
    disk = disk_cache.load(f"panel-{market}", _PANEL_TTL)
    if isinstance(disk, dict) and "close" in disk:
        _PANEL_CACHE[market] = (time.time(), disk)
        return disk

    tickers = UNIVERSES[market]
    raw = yf.download(
        tickers, period="3y", interval="1d", auto_adjust=True,
        progress=False, group_by="column", threads=True,
    )
    if raw is None or raw.empty:
        raise LookupError(f"could not download the {market} universe")

    panel: dict[str, pd.DataFrame] = {}
    for field, source in (("open", "Open"), ("high", "High"), ("low", "Low"),
                          ("close", "Close"), ("volume", "Volume")):
        frame = raw[source].copy()
        frame = frame.dropna(axis=1, how="all")
        panel[field] = frame

    # Keep only symbols with a usable close history AND sane daily moves —
    # a >400% day in daily bars is a data feed error, not a market event.
    close_ok = panel["close"].notna().mean() > 0.7
    sane = panel["close"].pct_change().abs().max() < 4.0
    good = panel["close"].columns[close_ok & sane]
    if len(good) < 8:
        raise LookupError(f"only {len(good)} usable symbols in the {market} universe")
    for field in list(panel):
        panel[field] = panel[field][good]

    close = panel["close"]
    panel["returns"] = close.pct_change()
    panel["vwap"] = (panel["high"] + panel["low"] + close) / 3

    _PANEL_CACHE[market] = (time.time(), panel)
    disk_cache.store(f"panel-{market}", panel)
    return panel


# ---------------------------------------------------------------- metrics


def _daily_rank_ic(factor: pd.DataFrame, fwd: pd.DataFrame) -> pd.Series:
    """Cross-sectional Spearman IC per day (rank-then-Pearson, vectorized)."""
    f = factor.rank(axis=1)
    r = fwd.rank(axis=1)
    fm = f.sub(f.mean(axis=1), axis=0)
    rm = r.sub(r.mean(axis=1), axis=0)
    # only count symbols present on BOTH sides that day
    both = f.notna() & r.notna()
    fm = fm.where(both)
    rm = rm.where(both)
    cov = (fm * rm).sum(axis=1)
    denom = np.sqrt((fm**2).sum(axis=1) * (rm**2).sum(axis=1))
    ic = cov / denom.replace(0, np.nan)
    return ic[both.sum(axis=1) >= 6]


def evaluate_candidate(
    expression: str,
    panel: dict[str, pd.DataFrame],
    horizon: int,
    zoo_values: list[pd.DataFrame],
) -> dict:
    """All the numbers one candidate gets judged by. Raises FactorError."""
    values, node = factor_dsl.compute(expression, panel)

    close = panel["close"]
    fwd = close.pct_change(horizon).shift(-horizon)

    ic = _daily_rank_ic(values, fwd)
    if len(ic) < 60:
        raise factor_dsl.FactorError(f"only {len(ic)} evaluable days; factor too sparse")

    split = int(len(ic) * (1 - HOLDOUT_FRACTION))
    ic_is, ic_oos = ic.iloc[:split], ic.iloc[split:]

    def summarize(series: pd.Series) -> tuple[float, float]:
        mean = float(series.mean())
        # Floor the std so a near-constant IC series reads as extremely
        # stable (huge ICIR), not as 0/0 -> "unstable".
        std = max(float(series.std()), 1e-4)
        return mean, mean / std

    is_ic, is_icir = summarize(ic_is)
    oos_ic, oos_icir = summarize(ic_oos)

    ranked = values.rank(axis=1, pct=True)
    stability = float(ranked.corrwith(ranked.shift(1), axis=1).mean())

    max_corr = 0.0
    flat = ranked.stack()
    for other in zoo_values:
        pair = pd.concat([flat, other.rank(axis=1, pct=True).stack()], axis=1).dropna()
        if len(pair) > 200:
            corr = abs(float(pair.iloc[:, 0].corr(pair.iloc[:, 1])))
            max_corr = max(max_corr, corr)

    coverage = float((values.notna().sum(axis=1) >= 6).mean())

    return {
        "expression": expression,
        "complexity": factor_dsl.complexity(node),
        "is_ic": round(is_ic, 4),
        "is_icir": round(is_icir, 3),
        "oos_ic": round(oos_ic, 4),
        "oos_icir": round(oos_icir, 3),
        "stability": round(stability, 3),
        "coverage": round(coverage, 3),
        "max_zoo_corr": round(max_corr, 3),
        "days": int(len(ic)),
        "_values": ranked,  # stripped before serialization
    }


def _verdict(m: dict, mode: str = "standard") -> tuple[bool, list[str]]:
    """Accept/reject + the reasons that become next-round feedback."""
    min_ic, min_icir = MODES.get(mode, MODES["standard"])
    reasons: list[str] = []
    if m["coverage"] < MIN_COVERAGE:
        reasons.append(f"coverage {m['coverage']:.0%} < {MIN_COVERAGE:.0%} — too many NaN days")
    if m["complexity"] > MAX_COMPLEXITY:
        reasons.append(f"complexity {m['complexity']} > {MAX_COMPLEXITY} — simplify")
    if abs(m["is_ic"]) < min_ic:
        reasons.append(f"weak signal: |IS IC| {abs(m['is_ic']):.3f} < {min_ic}")
    elif np.sign(m["oos_ic"]) != np.sign(m["is_ic"]) or abs(m["oos_ic"]) < min_ic / 3:
        reasons.append(
            f"holdout does not confirm: IS IC {m['is_ic']:+.3f} vs OOS IC {m['oos_ic']:+.3f}"
        )
    if abs(m["is_icir"]) < min_icir:
        reasons.append(f"unstable: |ICIR| {abs(m['is_icir']):.2f} < {min_icir}")
    if m["max_zoo_corr"] > MAX_ZOO_CORR:
        reasons.append(f"redundant: |corr| {m['max_zoo_corr']:.2f} with an accepted factor")
    return (not reasons), reasons


def _round_feedback(results: list[dict]) -> str:
    """Compress a round into the directives that steer the next one —
    the Chain-of-Alpha optimization-chain step."""
    lines: list[str] = []
    for r in results:
        if r.get("error"):
            lines.append(f"- `{r['expression']}` FAILED to evaluate: {r['error']}")
            continue
        state = "ACCEPTED" if r["accepted"] else "rejected"
        lines.append(
            f"- `{r['expression']}` {state}: IS IC {r['is_ic']:+.3f} (ICIR {r['is_icir']:+.2f}), "
            f"OOS IC {r['oos_ic']:+.3f}, corr_zoo {r['max_zoo_corr']:.2f}"
            + (f" | {'; '.join(r['reasons'])}" if r.get("reasons") else "")
        )

    evaluated = [r for r in results if not r.get("error")]
    if evaluated:
        weak = sum(abs(r["is_ic"]) < MIN_ABS_IC for r in evaluated)
        unstable = sum(abs(r.get("is_icir", 0)) < 0.15 for r in evaluated)
        redundant = sum(r["max_zoo_corr"] > MAX_ZOO_CORR for r in evaluated)
        directives = []
        if weak >= len(evaluated) / 2:
            directives.append(
                "most candidates were weak — combine price AND volume information, "
                "try different horizons, sharpen with rank()/zscore()"
            )
        if unstable >= len(evaluated) / 2:
            directives.append(
                "signals were unstable over time — smooth with ts_mean, lengthen windows, "
                "prefer ratios over raw differences"
            )
        if redundant:
            directives.append(
                "some candidates duplicated the zoo — explore a structurally different idea "
                "(e.g. volatility, gaps, volume-price divergence, range position)"
            )
        if directives:
            lines.append("DIRECTIVES for next round: " + " | ".join(directives) + ".")
    return "\n".join(lines)


# --------------------------------------------------------------- LLM step

FACTOR_TOOL: dict[str, Any] = {
    "name": "submit_factors",
    "description": "Submit this round's candidate factor expressions. The only delivery channel.",
    "input_schema": {
        "type": "object",
        "properties": {
            "factors": {
                "type": "array",
                "items": {
                    "type": "object",
                    "properties": {
                        "expression": {"type": "string", "description": "DSL expression"},
                        "hypothesis": {
                            "type": "string",
                            "description": "One sentence: the market inefficiency this captures",
                        },
                    },
                    "required": ["expression", "hypothesis"],
                },
            }
        },
        "required": ["factors"],
    },
}

_SYSTEM = """You are the factor-generation engine of a loop-engineered alpha mining system \
(Chain-of-Alpha style). Each round you propose candidate formulaic alpha factors; a real \
evaluator scores them on a cross-sectional {market_desc} universe (rank IC against {horizon}-day \
forward returns, in-sample vs holdout, redundancy vs accepted factors), and its feedback comes \
back to you next round.

DSL reference (ONLY these constructs parse):
{operator_doc}

Rules:
- Exactly {per_round} candidates per round, via the submit_factors tool. No prose.
- Each factor must encode a DIFFERENT economic hypothesis (momentum, reversal, volume-price \
divergence, volatility structure, range position, gap behavior...).
- Respect the feedback: fix what failed, do not resubmit rejected or accepted expressions, \
and avoid structures highly correlated with the accepted zoo.
- Prefer simple, readable expressions (complexity cap {max_complexity} AST nodes). \
rank()/zscore() usually improves cross-sectional comparability.
- Sign matters: negative IC just means the factor works inverted — you may wrap in neg()."""


async def _generate_round(
    market: str, horizon: int, per_round: int, history: list[str], round_no: int, rounds: int
) -> list[dict]:
    """One forced-tool Claude call. Returns [{expression, hypothesis}]."""
    settings = get_settings()
    market_desc = "US large-cap equity" if market == "us" else "24×7 crypto"
    system = _SYSTEM.format(
        market_desc=market_desc,
        horizon=horizon,
        operator_doc=factor_dsl.OPERATOR_DOC,
        per_round=per_round,
        max_complexity=MAX_COMPLEXITY,
    )
    user = f"Round {round_no} of {rounds}."
    if history:
        user += "\n\nResults so far (oldest first):\n" + "\n\n".join(history)
        user += "\n\nGenerate the next round of candidates."
    else:
        user += " No history yet — cast a wide net across distinct hypotheses."

    response = await analyst.client.messages.create(
        model=settings.claude_model,
        max_tokens=2000,
        system=system,
        messages=[{"role": "user", "content": user}],
        tools=[FACTOR_TOOL],
        tool_choice={"type": "tool", "name": "submit_factors"},
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_factors":
            factors = block.input.get("factors", [])
            return [
                {
                    "expression": str(f.get("expression", "")).strip(),
                    "hypothesis": str(f.get("hypothesis", "")).strip(),
                }
                for f in factors
                if str(f.get("expression", "")).strip()
            ][:per_round]
    raise RuntimeError("model did not call submit_factors")


# ------------------------------------------------------------------ loop


async def mine_stream(
    market: str,
    horizon: int,
    rounds: int,
    per_round: int,
    mode: str = "standard",
    memory: dict | None = None,
) -> AsyncIterator[dict]:
    """The loop engine. Yields NDJSON-able progress events.

    `memory` carries cross-session state (AlphaMemo/XALPHA-style): previously
    accepted expressions (never resubmitted, counted in redundancy checks via
    the prompt) and compressed lessons from earlier sessions.
    """
    if not analyst.enabled:
        yield {"type": "error", "message": "AI is not configured (ANTHROPIC_API_KEY)."}
        return

    market = market if market in UNIVERSES else "us"
    horizon = max(1, min(30, horizon))
    rounds = max(1, min(6, rounds))
    per_round = max(2, min(6, per_round))
    mode = mode if mode in MODES else "standard"
    memory = memory or {}
    prior_accepted = [str(x)[:MAX_LEN_HINT] for x in memory.get("accepted", [])][:20]
    prior_lessons = [str(x)[:300] for x in memory.get("lessons", [])][:12]

    try:
        panel = await asyncio.to_thread(_load_panel_blocking, market)
    except Exception as exc:
        yield {"type": "error", "message": f"universe data failed: {exc}"}
        return

    symbols = list(panel["close"].columns)
    yield {
        "type": "start",
        "market": market,
        "horizon": horizon,
        "rounds": rounds,
        "per_round": per_round,
        "mode": mode,
        "prior_memory": {"accepted": len(prior_accepted), "lessons": len(prior_lessons)},
        "universe": symbols,
        "span": {
            "from": str(panel["close"].index[0].date()),
            "to": str(panel["close"].index[-1].date()),
        },
    }

    zoo: list[dict] = []
    zoo_values: list[pd.DataFrame] = []
    history: list[str] = []
    seen: set[str] = set(prior_accepted)

    if prior_accepted or prior_lessons:
        block = "PRIOR SESSIONS (cross-session memory):"
        if prior_accepted:
            block += (
                "\nAlready-accepted factors — do NOT resubmit these, and avoid "
                "structurally similar ideas:\n"
                + "\n".join(f"- `{e}`" for e in prior_accepted)
            )
        if prior_lessons:
            block += "\nLessons from earlier sessions:\n" + "\n".join(
                f"- {le}" for le in prior_lessons
            )
        history.append(block)

    for round_no in range(1, rounds + 1):
        yield {"type": "round", "round": round_no, "rounds": rounds}

        try:
            candidates = await _generate_round(
                market, horizon, per_round, history, round_no, rounds
            )
        except ClaudeUnavailable as exc:
            yield {"type": "error", "message": str(exc)}
            return
        except Exception as exc:
            log.warning("factor generation failed: %s", exc)
            yield {"type": "error", "message": f"generation failed: {exc}"}
            return

        results: list[dict] = []
        for cand in candidates:
            expr = cand["expression"]
            if expr in seen:
                results.append({"expression": expr, "error": "duplicate of an earlier candidate"})
                yield {"type": "eval", "round": round_no, **results[-1], "accepted": False}
                continue
            seen.add(expr)

            yield {"type": "gen", "round": round_no, "expression": expr,
                   "hypothesis": cand["hypothesis"]}
            try:
                metrics = await asyncio.to_thread(
                    evaluate_candidate, expr, panel, horizon, zoo_values
                )
            except factor_dsl.FactorError as exc:
                results.append({"expression": expr, "error": str(exc)})
                yield {"type": "eval", "round": round_no, "expression": expr,
                       "error": str(exc), "accepted": False}
                continue
            except Exception as exc:  # pandas edge cases — report, keep looping
                results.append({"expression": expr, "error": f"{type(exc).__name__}: {exc}"})
                yield {"type": "eval", "round": round_no, "expression": expr,
                       "error": str(exc), "accepted": False}
                continue

            accepted, reasons = _verdict(metrics, mode)
            values = metrics.pop("_values")
            row = {**metrics, "hypothesis": cand["hypothesis"], "accepted": accepted,
                   "reasons": reasons, "round": round_no}
            results.append(row)
            if accepted:
                zoo.append(row)
                zoo_values.append(values)
            yield {"type": "eval", **row}

        feedback = _round_feedback(results)
        history.append(f"Round {round_no}:\n{feedback}")
        if round_no < rounds:
            yield {"type": "feedback", "round": round_no, "text": feedback}

    zoo_public = [{k: v for k, v in f.items() if not k.startswith("_")} for f in zoo]
    yield {
        "type": "done",
        "zoo": zoo_public,
        "evaluated": len(seen) - len(prior_accepted),
        "mode": mode,
        "lessons": _session_lessons(history, market, horizon),
    }


def _session_lessons(history: list[str], market: str, horizon: int) -> list[str]:
    """Compress a session into carry-forward lessons: the directive lines,
    tagged with market/horizon so later sessions know their context."""
    lessons: list[str] = []
    for chunk in history:
        for line in chunk.splitlines():
            if line.startswith("DIRECTIVES"):
                text = line.removeprefix("DIRECTIVES for next round:").strip().rstrip(".")
                lessons.append(f"[{market}/{horizon}d] {text}")
    # dedup, keep the most recent occurrences
    out: list[str] = []
    for lesson in reversed(lessons):
        if lesson not in out:
            out.append(lesson)
    return list(reversed(out))[-6:]


# ------------------------------------------------------- factor backtest


def portfolio_backtest_blocking(
    expression: str,
    market: str,
    top_n: int = 5,
    rebalance: int = 10,
    invert: bool = False,
    cost_bps: float = 7.0,
) -> dict:
    """Judge a factor with money instead of IC: equal-weight the top-N ranked
    symbols, rebalance every `rebalance` bars, subtract turnover costs, and
    compare against an equal-weight buy-and-hold of the same universe.

    No look-ahead: the factor is computed on data up to day t and the
    resulting weights earn returns from day t+1 onward.
    """
    market = market if market in UNIVERSES else "us"
    panel = _load_panel_blocking(market)
    values, _ = factor_dsl.compute(expression, panel)
    if invert:
        values = -values
    result = _portfolio_from_values(values, panel, market, top_n, rebalance, cost_bps)
    return {"expression": expression, "inverted": invert, **result}


def _portfolio_from_values(
    values: pd.DataFrame,
    panel: dict[str, pd.DataFrame],
    market: str,
    top_n: int,
    rebalance: int,
    cost_bps: float = 7.0,
) -> dict:
    top_n = max(2, min(10, top_n))
    rebalance = max(1, min(30, rebalance))

    close = panel["close"]
    daily_ret = close.pct_change()

    ranked = values.rank(axis=1, ascending=False)  # 1 = best
    member = (ranked <= top_n).astype(float)
    # freeze weights between rebalance dates, then lag one bar (enter at t+1)
    is_rebalance_day = pd.Series(range(len(member)), index=member.index) % rebalance == 0
    member = member.where(is_rebalance_day).ffill()
    weights = member.div(member.sum(axis=1).replace(0, np.nan), axis=0).fillna(0.0)
    held = weights.shift(1).fillna(0.0)

    gross = (held * daily_ret).sum(axis=1)
    turnover = (weights - held).abs().sum(axis=1) / 2
    net = gross - turnover * (cost_bps / 10_000)

    bench_w = close.notna().astype(float)
    bench_w = bench_w.div(bench_w.sum(axis=1), axis=0)
    bench = (bench_w.shift(1) * daily_ret).sum(axis=1)

    # drop the warmup where the factor had no values at all
    first = held.abs().sum(axis=1).gt(0).idxmax()
    net, bench = net.loc[first:], bench.loc[first:]
    if len(net) < 60:
        raise factor_dsl.FactorError("factor warms up too late to backtest")

    equity = (1 + net).cumprod() * 100_000
    bench_eq = (1 + bench).cumprod() * 100_000
    peak = equity.cummax()
    dd = (equity / peak - 1) * 100

    ann = 252 if market == "us" else 365
    years = len(net) / ann

    def stats(series: pd.Series, eq: pd.Series) -> dict:
        total = float(eq.iloc[-1] / eq.iloc[0] - 1) * 100
        vol = float(series.std() * np.sqrt(ann))
        sharpe = float(series.mean() * ann / vol) if vol > 1e-9 else 0.0
        return {
            "total_return_pct": round(total, 2),
            "cagr_pct": round(float((eq.iloc[-1] / eq.iloc[0]) ** (1 / years) - 1) * 100, 2)
            if years > 0.2 else None,
            "sharpe": round(sharpe, 2),
        }

    epoch = lambda ts: int(pd.Timestamp(ts).timestamp())  # noqa: E731
    return {
        "market": market,
        "top_n": top_n,
        "rebalance": rebalance,
        "cost_bps": cost_bps,
        "span": {"from": str(net.index[0].date()), "to": str(net.index[-1].date())},
        "stats": {
            **stats(net, equity),
            "max_drawdown_pct": round(float(dd.min()), 2),
            "avg_turnover_pct": round(float(turnover.loc[first:].mean() * 100), 1),
            "benchmark": stats(bench, bench_eq),
        },
        "equity_curve": [
            {"time": epoch(ts), "value": round(float(v), 2)} for ts, v in equity.items()
        ],
        "benchmark_curve": [
            {"time": epoch(ts), "value": round(float(v), 2)} for ts, v in bench_eq.items()
        ],
        "drawdown_curve": [
            {"time": epoch(ts), "value": round(float(v), 3)} for ts, v in dd.items()
        ],
    }


# ------------------------------------------------- composite & health


def composite_backtest_blocking(
    factors: list[dict],
    market: str,
    weighting: str = "ic",
    top_n: int = 5,
    rebalance: int = 10,
) -> dict:
    """Blend 2+ factors into one meta-signal and run the same portfolio test.

    Each factor is sign-aligned (inverted when its stored IC was negative),
    reduced to daily cross-sectional ranks (scale-free, so heterogeneous
    factors are comparable), then combined equal-weight or |IC|-weighted.
    IC weights come from the IN-SAMPLE window only — the same 80% the miner
    used — so the blend never peeks at the holdout it is judged on.
    """
    if len(factors) < 2:
        raise factor_dsl.FactorError("composite needs at least 2 factors")
    if len(factors) > 8:
        raise factor_dsl.FactorError("composite supports at most 8 factors")
    market = market if market in UNIVERSES else "us"
    weighting = weighting if weighting in ("equal", "ic") else "ic"

    panel = _load_panel_blocking(market)
    close = panel["close"]

    ranked_list: list[pd.DataFrame] = []
    components: list[dict] = []
    for f in factors:
        expr = str(f.get("expression", ""))
        values, _ = factor_dsl.compute(expr, panel)
        if bool(f.get("invert")):
            values = -values
        horizon = max(1, min(30, int(f.get("horizon", 10))))
        fwd = close.pct_change(horizon).shift(-horizon)
        ic = _daily_rank_ic(values, fwd)
        split = int(len(ic) * (1 - HOLDOUT_FRACTION))
        is_ic = float(ic.iloc[:split].mean()) if split > 0 else 0.0
        ranked_list.append(values.rank(axis=1, pct=True))
        components.append({"expression": expr, "is_ic": round(is_ic, 4)})

    # pairwise redundancy — shown, not enforced: the user chose the blend
    n = len(ranked_list)
    max_pair_corr = 0.0
    for i in range(n):
        for j in range(i + 1, n):
            pair = pd.concat(
                [ranked_list[i].stack(), ranked_list[j].stack()], axis=1
            ).dropna()
            if len(pair) > 200:
                max_pair_corr = max(
                    max_pair_corr, abs(float(pair.iloc[:, 0].corr(pair.iloc[:, 1])))
                )

    if weighting == "ic":
        raw = [abs(c["is_ic"]) for c in components]
        total = sum(raw)
        weights = [r / total if total > 1e-9 else 1 / n for r in raw]
    else:
        weights = [1 / n] * n
    for c, w in zip(components, weights):
        c["weight"] = round(w, 3)

    combined = sum(r * w for r, w in zip(ranked_list, weights))

    result = _portfolio_from_values(combined, panel, market, top_n, rebalance)
    return {
        "weighting": weighting,
        "components": components,
        "max_pair_corr": round(max_pair_corr, 3),
        **result,
    }


def check_factor_blocking(expression: str, market: str, horizon: int) -> dict:
    """One factor's current health on one market: full-window IC, holdout IC,
    and the trailing-60-evaluable-day IC that exposes decay. Serves both the
    re-checkup button and the cross-market robustness test."""
    market = market if market in UNIVERSES else "us"
    horizon = max(1, min(30, horizon))

    panel = _load_panel_blocking(market)
    values, _ = factor_dsl.compute(expression, panel)
    fwd = panel["close"].pct_change(horizon).shift(-horizon)
    ic = _daily_rank_ic(values, fwd)
    if len(ic) < 90:
        raise factor_dsl.FactorError(f"only {len(ic)} evaluable days on {market}")

    split = int(len(ic) * (1 - HOLDOUT_FRACTION))
    recent = ic.iloc[-60:]
    return {
        "expression": expression,
        "market": market,
        "horizon": horizon,
        "is_ic": round(float(ic.iloc[:split].mean()), 4),
        "oos_ic": round(float(ic.iloc[split:].mean()), 4),
        "recent_ic": round(float(recent.mean()), 4),
        "recent_days": int(len(recent)),
        "days": int(len(ic)),
        "as_of": str(ic.index[-1].date()),
    }
