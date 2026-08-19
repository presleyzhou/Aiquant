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
from app.services import factor_dsl
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
        "SHIB-USD", "TON-USD", "NEAR-USD", "UNI-USD",
    ],
}

HOLDOUT_FRACTION = 0.2      # trailing slice the LLM never gets feedback on
MIN_ABS_IC = 0.015          # in-sample bar a candidate must clear
MAX_ZOO_CORR = 0.7          # redundancy ceiling vs accepted factors
MAX_COMPLEXITY = 24         # AST nodes — AlphaAgent-style regularizer
MIN_COVERAGE = 0.55         # fraction of days with a computable cross-section

_PANEL_CACHE: dict[str, tuple[float, dict[str, pd.DataFrame]]] = {}
_PANEL_TTL = 6 * 3600


# ------------------------------------------------------------------- data


def _load_panel_blocking(market: str) -> dict[str, pd.DataFrame]:
    cached = _PANEL_CACHE.get(market)
    if cached and time.time() - cached[0] < _PANEL_TTL:
        return cached[1]

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

    # Keep only symbols with a usable close history.
    good = panel["close"].columns[panel["close"].notna().mean() > 0.7]
    if len(good) < 8:
        raise LookupError(f"only {len(good)} usable symbols in the {market} universe")
    for field in list(panel):
        panel[field] = panel[field][good]

    close = panel["close"]
    panel["returns"] = close.pct_change()
    panel["vwap"] = (panel["high"] + panel["low"] + close) / 3

    _PANEL_CACHE[market] = (time.time(), panel)
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


def _verdict(m: dict) -> tuple[bool, list[str]]:
    """Accept/reject + the reasons that become next-round feedback."""
    reasons: list[str] = []
    if m["coverage"] < MIN_COVERAGE:
        reasons.append(f"coverage {m['coverage']:.0%} < {MIN_COVERAGE:.0%} — too many NaN days")
    if m["complexity"] > MAX_COMPLEXITY:
        reasons.append(f"complexity {m['complexity']} > {MAX_COMPLEXITY} — simplify")
    if abs(m["is_ic"]) < MIN_ABS_IC:
        reasons.append(f"weak signal: |IS IC| {abs(m['is_ic']):.3f} < {MIN_ABS_IC}")
    elif np.sign(m["oos_ic"]) != np.sign(m["is_ic"]) or abs(m["oos_ic"]) < MIN_ABS_IC / 2:
        reasons.append(
            f"holdout does not confirm: IS IC {m['is_ic']:+.3f} vs OOS IC {m['oos_ic']:+.3f}"
        )
    if abs(m["is_icir"]) < 0.15:
        reasons.append(f"unstable: |ICIR| {abs(m['is_icir']):.2f} < 0.15")
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
    market: str, horizon: int, rounds: int, per_round: int
) -> AsyncIterator[dict]:
    """The loop engine. Yields NDJSON-able progress events."""
    if not analyst.enabled:
        yield {"type": "error", "message": "AI is not configured (ANTHROPIC_API_KEY)."}
        return

    market = market if market in UNIVERSES else "us"
    horizon = max(1, min(30, horizon))
    rounds = max(1, min(6, rounds))
    per_round = max(2, min(6, per_round))

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
        "universe": symbols,
        "span": {
            "from": str(panel["close"].index[0].date()),
            "to": str(panel["close"].index[-1].date()),
        },
    }

    zoo: list[dict] = []
    zoo_values: list[pd.DataFrame] = []
    history: list[str] = []
    seen: set[str] = set()

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

            accepted, reasons = _verdict(metrics)
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
    yield {"type": "done", "zoo": zoo_public, "evaluated": len(seen)}
