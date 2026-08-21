"""Disk cache for market data frames.

yfinance is the platform's most fragile dependency — the factor panel alone
is 40 tickers × 3 years, refetched by mining, evaluation, composites and
health checks. Persisting frames to disk cuts Yahoo round-trips by an order
of magnitude and survives serverless instance recycling (same warm /tmp).

Storage is pandas pickle rather than parquet on purpose: parquet needs
pyarrow, whose wheel alone would blow Vercel's 225MB bundle cap. These are
our own cache files written and read by the same process — the usual
pickle-from-untrusted-source concern does not apply, and a corrupt/stale
file just falls through to a refetch.
"""

from __future__ import annotations

import logging
import os
import pickle
import re
import tempfile
import time
from pathlib import Path

log = logging.getLogger("aiquant.cache")

_SAFE = re.compile(r"[^A-Za-z0-9._-]")


def cache_dir() -> Path:
    """Writable cache root: /tmp on serverless, a project-local dir otherwise."""
    override = os.environ.get("AIQUANT_CACHE_DIR")
    if override:
        base = Path(override)
    elif os.environ.get("VERCEL"):
        base = Path(tempfile.gettempdir()) / "aiquant-cache"
    else:
        base = Path(__file__).resolve().parents[2] / ".cache"
    base.mkdir(parents=True, exist_ok=True)
    return base


def _path(key: str) -> Path:
    return cache_dir() / f"{_SAFE.sub('_', key)}.pkl"


def load(key: str, ttl_seconds: float):
    """Return the cached object, or None when absent/expired/unreadable."""
    path = _path(key)
    try:
        if time.time() - path.stat().st_mtime > ttl_seconds:
            return None
        with path.open("rb") as fh:
            return pickle.load(fh)
    except FileNotFoundError:
        return None
    except Exception as exc:  # corrupt file → treat as a miss, refetch
        log.warning("cache read failed for %s: %s", key, exc)
        try:
            path.unlink(missing_ok=True)
        except OSError:
            pass
        return None


def store(key: str, obj) -> None:
    """Best-effort write; a failed write must never break the request."""
    path = _path(key)
    tmp = path.with_suffix(".tmp")
    try:
        with tmp.open("wb") as fh:
            pickle.dump(obj, fh, protocol=pickle.HIGHEST_PROTOCOL)
        tmp.replace(path)  # atomic on POSIX — readers never see partial files
    except Exception as exc:
        log.warning("cache write failed for %s: %s", key, exc)
        try:
            tmp.unlink(missing_ok=True)
        except OSError:
            pass
