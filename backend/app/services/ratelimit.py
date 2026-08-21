"""Minimal in-memory rate limiter for token-spending endpoints.

Per-instance (serverless instances don't share memory), which still stops the
realistic abuse pattern — one client hammering one warm instance. A shared
store (Upstash/Redis) can replace `_BUCKETS` later without changing callers.
"""

from __future__ import annotations

import time
from collections import defaultdict

_BUCKETS: dict[str, list[float]] = defaultdict(list)
_MAX_KEYS = 5000


def allow(key: str, limit: int, window_seconds: float) -> bool:
    """Sliding-window check: True while `key` has budget left."""
    now = time.time()
    if len(_BUCKETS) > _MAX_KEYS:  # memory backstop against key-spray
        _BUCKETS.clear()
    bucket = _BUCKETS[key]
    cutoff = now - window_seconds
    while bucket and bucket[0] < cutoff:
        bucket.pop(0)
    if len(bucket) >= limit:
        return False
    bucket.append(now)
    return True
