"""Per-day counters of which data provider actually served each panel
download, whether the configured primary fell back, and how long it took.
Surfaced in the admin overview so "Yahoo is rate-limiting us again" shows up
as a number, not a log line."""

from __future__ import annotations

import logging
import threading
import time
from datetime import UTC, date, datetime, timedelta

from app.services import kvstore

log = logging.getLogger("aiquant.provider_health")
_lock = threading.Lock()


def _day() -> str:
    return datetime.now(UTC).date().isoformat()


def record(market: str, configured: str, used: list[str], seconds: float) -> None:
    """`configured` is the provider the settings asked for; `used` the chain
    that actually served. A chain not starting with the configured provider
    (or containing yahoo when it should not) counts as a fallback."""
    try:
        primary = {"binance": "binance", "akshare": "akshare", "auto": "akshare", "yahoo": "yahoo"}.get(configured, configured)
        served = used[0] if used else "none"
        fell_back = bool(used) and used[0] != primary and primary != "yahoo"
        key = f"provhealth:{_day()}"
        with _lock:
            doc = kvstore.get(key) or {"day": _day(), "markets": {}}
            m = doc["markets"].setdefault(market, {"calls": 0, "fallbacks": 0, "seconds": 0.0, "served": {}})
            m["calls"] += 1
            m["fallbacks"] += int(fell_back)
            m["seconds"] = round(float(m["seconds"]) + float(seconds), 2)
            m["served"][served] = m["served"].get(served, 0) + 1
            kvstore.put(key, doc)
    except Exception as exc:  # never let bookkeeping break a download
        log.warning("provider health record failed: %s", exc)


def summary(days: int = 7) -> dict:
    """Aggregate the last `days` daily documents per market."""
    today = date.today()
    out: dict[str, dict] = {}
    for i in range(days):
        doc = kvstore.get(f"provhealth:{(today - timedelta(days=i)).isoformat()}")
        if not doc:
            continue
        for market, m in (doc.get("markets") or {}).items():
            agg = out.setdefault(market, {"calls": 0, "fallbacks": 0, "seconds": 0.0, "served": {}})
            agg["calls"] += int(m.get("calls", 0))
            agg["fallbacks"] += int(m.get("fallbacks", 0))
            agg["seconds"] += float(m.get("seconds", 0.0))
            for prov, n in (m.get("served") or {}).items():
                agg["served"][prov] = agg["served"].get(prov, 0) + int(n)
    for agg in out.values():
        calls = max(agg["calls"], 1)
        agg["fallback_rate_pct"] = round(agg["fallbacks"] / calls * 100, 1)
        agg["avg_seconds"] = round(agg["seconds"] / calls, 2)
        agg["seconds"] = round(agg["seconds"], 2)
    return {"days": days, "markets": out, "generated_at": int(time.time())}
