"""Cross-instance cache for cleaned OHLCV panels.

Serverless instances do not share /tmp, so every cold instance used to pay
the 10–30 s provider download. When the KV store (Upstash / Vercel KV) is
configured, a downloaded panel is also written there — one gzip-pickled
blob per field, base64 for the JSON transport, with a manifest — and any
instance can pull it back in well under a second. File mode (local / Docker)
skips this layer: the disk cache already covers a single machine.

Blobs are kept under ~900 KB each (Upstash's 1 MB request cap); a panel whose
fields do not fit is simply not shared.
"""

from __future__ import annotations

import base64
import gzip
import json
import logging
import pickle
import time

import pandas as pd

from app.services import kvstore

log = logging.getLogger("aiquant.panel_cache")

FIELDS = ("open", "high", "low", "close", "volume")
DERIVED = ("returns", "vwap")           # recomputed on load, never stored
MAX_BLOB_BYTES = 900_000
DEFAULT_TTL = 6 * 3600


def enabled() -> bool:
    return kvstore.mode() == "kv"


def _encode(df: pd.DataFrame) -> str:
    return base64.b64encode(gzip.compress(pickle.dumps(df, protocol=pickle.HIGHEST_PROTOCOL), compresslevel=6)).decode()


def _decode(blob: str) -> pd.DataFrame:
    return pickle.loads(gzip.decompress(base64.b64decode(blob)))


def store(key: str, panel: dict[str, pd.DataFrame], ttl: int = DEFAULT_TTL) -> bool:
    """Best effort; returns True when the whole panel was shared."""
    if not enabled():
        return False
    try:
        blobs = {f: _encode(panel[f]) for f in FIELDS if f in panel}
        if len(blobs) < len(FIELDS):
            return False
        if any(len(b) > MAX_BLOB_BYTES for b in blobs.values()):
            log.info("panel %s too large to share (%s)", key, {f: len(b) for f, b in blobs.items()})
            return False
        for f, b in blobs.items():
            kvstore._kv("SET", f"panel:{key}:{f}", b, "EX", int(ttl))
        provider = str(panel["close"].attrs.get("provider") or "")
        manifest = {"fields": list(blobs), "created": int(time.time()), "provider": provider,
                    "symbols": int(panel["close"].shape[1]), "bars": int(len(panel["close"]))}
        kvstore._kv("SET", f"panel:{key}:manifest", json.dumps(manifest), "EX", int(ttl))
        return True
    except Exception as exc:  # the cache must never break a request
        log.warning("panel cache store failed for %s: %s", key, exc)
        return False


def load(key: str) -> dict[str, pd.DataFrame] | None:
    if not enabled():
        return None
    try:
        raw = kvstore._kv("GET", f"panel:{key}:manifest")
        if not raw:
            return None
        manifest = json.loads(raw)
        fields = manifest.get("fields") or []
        if set(fields) != set(FIELDS):
            return None
        blobs = kvstore._kv("MGET", *[f"panel:{key}:{f}" for f in FIELDS]) or []
        if len(blobs) != len(FIELDS) or any(not b for b in blobs):
            return None
        panel = {f: _decode(b) for f, b in zip(FIELDS, blobs, strict=True)}
        close = panel["close"]
        panel["returns"] = close.pct_change()
        panel["vwap"] = (panel["high"] + panel["low"] + close) / 3
        provider = manifest.get("provider") or ""
        for frame in panel.values():
            frame.attrs["provider"] = provider
        return panel
    except Exception as exc:
        log.warning("panel cache load failed for %s: %s", key, exc)
        return None


def describe(key: str) -> dict | None:
    """Manifest only — for the admin warm endpoint's report."""
    if not enabled():
        return None
    try:
        raw = kvstore._kv("GET", f"panel:{key}:manifest")
        return json.loads(raw) if raw else None
    except Exception:
        return None
