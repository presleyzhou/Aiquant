"""Nightly real-data integration check (run by .github/workflows/live-check.yml
on a networked runner; the unit tests never touch the network).

For every built-in market it downloads the panel from the configured
providers, runs the default pipeline, and builds a rebalance ticket — the
three things a user does on the site — and fails loudly when any of them
breaks or the data looks wrong (few symbols, stale last bar, empty targets).
Writes live-check.json and, on GitHub, a step summary.

    cd backend && python scripts/live_check.py [--markets us,crypto] [--max-stale-days 5]
"""

from __future__ import annotations

import argparse
import json
import os
import sys
import time
import traceback
from datetime import UTC, datetime
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
os.environ.setdefault("AIQUANT_CACHE_DIR", str(Path(__file__).resolve().parent / ".live-cache"))

MIN_SYMBOLS = {"us": 60, "crypto": 20}


def check_market(market: str, max_stale_days: int) -> dict:
    from app.services import pipeline
    from app.services.factor_mine import UNIVERSES
    from app.services.panel_providers import download_panel, provider_of

    row: dict = {"market": market, "ok": True, "problems": [], "steps": {}}
    problems = row["problems"]

    t0 = time.time()
    panel = download_panel(list(UNIVERSES[market]), "3y", market, market=market)
    close = panel["close"]
    last = close.index[-1].date()
    stale_days = (datetime.now(UTC).date() - last).days
    health = pipeline.data_health(panel)
    row["steps"]["download"] = {
        "seconds": round(time.time() - t0, 1), "provider": provider_of(panel),
        "symbols": int(close.shape[1]), "bars": int(len(close)), "last_bar": str(last),
        "stale_days": stale_days, "stale_symbols": sum(1 for h in health if h.get("stale")),
        "expected_symbols": len(UNIVERSES[market]),
    }
    if close.shape[1] < MIN_SYMBOLS[market]:
        problems.append(f"only {close.shape[1]} symbols (expected ≥ {MIN_SYMBOLS[market]})")
    if stale_days > max_stale_days:
        problems.append(f"last bar {last} is {stale_days} days old")
    if len(close) < 500:
        problems.append(f"only {len(close)} bars of history")

    t0 = time.time()
    spec = {"market": market, "factors": pipeline.STARTER_FACTORS[market], "compare": True}
    result = pipeline.run_pipeline_blocking(spec, panel=panel)
    stats = result["backtest"]["stats"]
    tw = result["target_weights"]
    row["steps"]["pipeline"] = {
        "seconds": round(time.time() - t0, 1), "sharpe": stats.get("sharpe"),
        "holdout_sharpe": (result["backtest"].get("holdout") or {}).get("sharpe"),
        "targets": len(tw.get("weights") or []), "exposure_pct": tw.get("exposure_pct"),
        "as_of": tw.get("as_of"), "warnings": result.get("warnings", []),
    }
    if not tw.get("weights"):
        problems.append("pipeline produced no target weights")
    if tw.get("as_of") != str(last):
        problems.append(f"targets as of {tw.get('as_of')} but the panel ends {last}")
    if stats.get("sharpe") is None:
        problems.append("backtest statistics missing")

    t0 = time.time()
    ticket = pipeline.orders_blocking(spec, nav=100_000.0, panel=panel)
    orders = ticket.get("orders") or []
    row["steps"]["ticket"] = {
        "seconds": round(time.time() - t0, 1), "orders": len(orders),
        "turnover_pct": (ticket.get("summary") or {}).get("turnover_pct"), "as_of": ticket.get("as_of"),
        "unpriced": ticket.get("unpriced") or [],
    }
    if not orders:
        problems.append("rebalance ticket has no orders for an empty book")
    if ticket.get("unpriced"):
        problems.append(f"unpriced symbols in the ticket: {ticket['unpriced'][:5]}")
    row["ok"] = not problems
    return row


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--markets", default="us,crypto")
    ap.add_argument("--max-stale-days", type=int, default=5)
    ap.add_argument("--out", default="live-check.json")
    args = ap.parse_args()
    report = {"generated_at": datetime.now(UTC).isoformat(timespec="seconds"), "markets": []}
    for market in [m.strip() for m in args.markets.split(",") if m.strip()]:
        try:
            row = check_market(market, args.max_stale_days)
        except Exception as exc:
            row = {"market": market, "ok": False, "problems": [f"{type(exc).__name__}: {str(exc)[:300]}"],
                   "steps": {}, "traceback": traceback.format_exc()[-2000:]}
        report["markets"].append(row)
    report["ok"] = all(r["ok"] for r in report["markets"])
    Path(args.out).write_text(json.dumps(report, indent=2, default=str))

    lines = [f"## Live data check — {'✅ passed' if report['ok'] else '❌ FAILED'}", ""]
    lines.append("| market | provider | symbols | last bar | download | pipeline | Sharpe | holdout | orders | problems |")
    lines.append("|---|---|---|---|---|---|---|---|---|---|")
    for r in report["markets"]:
        d, p, t = (r["steps"].get(k, {}) for k in ("download", "pipeline", "ticket"))
        lines.append(
            f"| {r['market']} | {d.get('provider', '—')} | {d.get('symbols', '—')}/{d.get('expected_symbols', '—')} | "
            f"{d.get('last_bar', '—')} | {d.get('seconds', '—')}s | {p.get('seconds', '—')}s | {p.get('sharpe', '—')} | "
            f"{p.get('holdout_sharpe', '—')} | {t.get('orders', '—')} | {'; '.join(r['problems']) or '—'} |"
        )
    summary = "\n".join(lines)
    print(summary)
    if os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(os.environ["GITHUB_STEP_SUMMARY"], "a", encoding="utf-8") as fh:
            fh.write(summary + "\n")
    return 0 if report["ok"] else 1


if __name__ == "__main__":
    sys.exit(main())
