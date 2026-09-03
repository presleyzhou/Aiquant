"""Token-usage metering for every Claude call the platform makes.

In-memory per instance, mirrored to the disk cache once a minute so a warm
/tmp survives instance recycling. Surfaced on /api/ai/status so spend is
visible instead of discovered on the invoice.
"""

from __future__ import annotations

import threading
import time
from datetime import date

from app.services import disk_cache

_lock = threading.Lock()
_state: dict = {"day": "", "calls": 0, "input_tokens": 0, "output_tokens": 0, "by_model": {}}
_last_flush = 0.0


def _roll(today: str) -> None:
    global _state
    if _state["day"] != today:
        cached = disk_cache.load(f"usage-{today}", ttl_seconds=2 * 86_400)
        _state = cached if isinstance(cached, dict) and cached.get("day") == today else {
            "day": today, "calls": 0, "input_tokens": 0, "output_tokens": 0, "by_model": {}
        }


def record(model: str, input_tokens: int, output_tokens: int) -> None:
    global _last_flush
    today = date.today().isoformat()
    with _lock:
        _roll(today)
        _state["calls"] += 1
        _state["input_tokens"] += int(input_tokens or 0)
        _state["output_tokens"] += int(output_tokens or 0)
        m = _state["by_model"].setdefault(model, {"calls": 0, "input_tokens": 0, "output_tokens": 0})
        m["calls"] += 1
        m["input_tokens"] += int(input_tokens or 0)
        m["output_tokens"] += int(output_tokens or 0)
        if time.time() - _last_flush > 60:
            disk_cache.store(f"usage-{today}", dict(_state))
            _last_flush = time.time()


def today() -> dict:
    with _lock:
        _roll(date.today().isoformat())
        return dict(_state)
