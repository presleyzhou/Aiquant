"""Minimal in-memory rate limiter for token-spending endpoints.

Per-instance (serverless instances don't share memory), which still stops the
realistic abuse pattern — one client hammering one warm instance. A shared
store (Upstash/Redis) can replace `_BUCKETS` later without changing callers.
"""

from __future__ import annotations

import time
from collections import defaultdict

from fastapi import HTTPException, Request

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


def client_ip(request) -> str:
    """First hop of X-Forwarded-For (Vercel/HF proxies), else the socket peer."""
    fwd = request.headers.get("x-forwarded-for", "")
    if fwd:
        return fwd.split(",")[0].strip()[:64]
    return (request.client.host if request.client else "unknown") or "unknown"


def limiter(name: str, limit_attr: str, window_seconds: float, *, global_attr: str | None = None):
    """FastAPI dependency: per-IP sliding window (+ optional instance-wide cap).
    Limits are read from Settings by attribute name so they are env-tunable."""
    from app.config import get_settings

    async def dependency(request: Request) -> None:
        settings = get_settings()
        limit = int(getattr(settings, limit_attr))
        if not allow(f"{name}:{client_ip(request)}", limit, window_seconds):
            raise HTTPException(
                status_code=429,
                detail=f"rate limit: {limit} {name} requests per {int(window_seconds // 3600)}h per client",
            )
        if global_attr and not allow(
            f"{name}:GLOBAL", int(getattr(settings, global_attr)), 86_400
        ):
            raise HTTPException(status_code=429, detail="site-wide daily AI budget exhausted")

    return dependency
