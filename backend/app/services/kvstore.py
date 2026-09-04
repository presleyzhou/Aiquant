"""Tiny durable key-value store for marketplace listings and the order ledger.

Two backends, chosen by configuration and reported to the client:

- **kv** — Upstash Redis REST (the protocol Vercel KV speaks). Stateless
  serverless functions get durable state with two env vars and no driver.
- **file** — one JSON document in the cache dir. Fine for local dev and
  Docker; on Vercel it lives in /tmp and evaporates with the instance, which
  the marketplace UI says out loud instead of pretending otherwise.

Keys are namespaced ("listing:abc"); `list_prefix` uses an explicit index set
per namespace so we never SCAN.
"""

from __future__ import annotations

import json
import logging
import threading
from typing import Any

import httpx

from app.config import get_settings
from app.services.disk_cache import cache_dir

log = logging.getLogger(__name__)
_lock = threading.Lock()
_FILE = "marketplace-store.json"


def mode() -> str:
    s = get_settings()
    return "kv" if (s.kv_rest_api_url and s.kv_rest_api_token) else "file"


# ------------------------------------------------------------------ file


def _file_path():
    return cache_dir() / _FILE


def _file_read() -> dict[str, Any]:
    try:
        return json.loads(_file_path().read_text())
    except (OSError, ValueError):
        return {}


def _file_write(doc: dict[str, Any]) -> None:
    path = _file_path()
    tmp = path.with_suffix(".tmp")
    tmp.write_text(json.dumps(doc, ensure_ascii=False))
    tmp.replace(path)


# -------------------------------------------------------------------- kv


def _kv(*command: Any) -> Any:
    s = get_settings()
    resp = httpx.post(
        s.kv_rest_api_url.rstrip("/"),
        json=list(command),
        headers={"Authorization": f"Bearer {s.kv_rest_api_token}"},
        timeout=10,
    )
    resp.raise_for_status()
    body = resp.json()
    if "error" in body:
        raise RuntimeError(f"kv: {body['error']}")
    return body.get("result")


def _ns(key: str) -> str:
    return key.split(":", 1)[0]


# ------------------------------------------------------------------- api


def get(key: str) -> dict | None:
    if mode() == "kv":
        raw = _kv("GET", key)
        return json.loads(raw) if raw else None
    with _lock:
        return _file_read().get(key)


def put(key: str, value: dict) -> None:
    if mode() == "kv":
        _kv("SET", key, json.dumps(value, ensure_ascii=False))
        _kv("SADD", f"idx:{_ns(key)}", key)
        return
    with _lock:
        doc = _file_read()
        doc[key] = value
        _file_write(doc)


def delete(key: str) -> None:
    if mode() == "kv":
        _kv("DEL", key)
        _kv("SREM", f"idx:{_ns(key)}", key)
        return
    with _lock:
        doc = _file_read()
        if key in doc:
            del doc[key]
            _file_write(doc)


def list_prefix(namespace: str) -> list[dict]:
    if mode() == "kv":
        keys = _kv("SMEMBERS", f"idx:{namespace}") or []
        if not keys:
            return []
        raws = _kv("MGET", *keys) or []
        return [json.loads(r) for r in raws if r]
    with _lock:
        doc = _file_read()
    return [v for k, v in doc.items() if k.startswith(f"{namespace}:")]
