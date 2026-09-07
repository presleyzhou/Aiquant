"""Result cache for pipeline runs.

Key = normalised spec (minus the requester's trial count) + the panel's last
bar + a code version. Same configuration, same data, same day → the stored
report comes back in milliseconds instead of 3–10 s: repeated runs, shared
links and the daily monitor all benefit. The only per-requester field, the
Deflated Sharpe's trial count, is re-derived from the stored moments.
Backed by KV with a TTL when configured, an in-process LRU otherwise.
"""

from __future__ import annotations

import hashlib
import json
import logging
import time
from collections import OrderedDict

from app.services import kvstore, portfolio

log = logging.getLogger("aiquant.run_cache")

CODE_VERSION = "v7"           # bump when the report's numbers change meaning
TTL_SECONDS = 24 * 3600
_MEM: OrderedDict[str, tuple[float, dict]] = OrderedDict()
_MEM_MAX = 32
_EXCLUDE = {"prior_trials"}


def key_for(spec: dict, panel_date: str) -> str:
    body = {k: v for k, v in sorted(spec.items()) if k not in _EXCLUDE}
    digest = hashlib.sha1(json.dumps(body, sort_keys=True, default=str).encode()).hexdigest()[:24]
    return f"runcache:{CODE_VERSION}:{panel_date}:{digest}"


def _finite(obj):
    import math

    if isinstance(obj, float):
        return obj if math.isfinite(obj) else None
    if isinstance(obj, dict):
        return {k: _finite(v) for k, v in obj.items()}
    if isinstance(obj, list):
        return [_finite(v) for v in obj]
    return obj


def get(key: str) -> dict | None:
    hit = _MEM.get(key)
    if hit and time.time() - hit[0] < TTL_SECONDS:
        _MEM.move_to_end(key)
        return json.loads(json.dumps(hit[1]))  # a copy: callers patch the result
    if kvstore.mode() == "kv":
        try:
            raw = kvstore._kv("GET", key)
            if raw:
                doc = json.loads(raw)
                _remember(key, doc)
                return json.loads(json.dumps(doc))
        except Exception as exc:
            log.warning("run cache read failed: %s", exc)
    return None


def _remember(key: str, doc: dict) -> None:
    _MEM[key] = (time.time(), doc)
    _MEM.move_to_end(key)
    while len(_MEM) > _MEM_MAX:
        _MEM.popitem(last=False)


def put(key: str, result: dict) -> None:
    doc = _finite(result)
    _remember(key, doc)
    if kvstore.mode() == "kv":
        try:
            kvstore._kv("SET", key, json.dumps(doc), "EX", TTL_SECONDS)
        except Exception as exc:
            log.warning("run cache write failed: %s", exc)


def personalise(result: dict, prior_trials: int) -> dict:
    """Re-deflate the cached Sharpe for this requester's trial count and mark
    the result as served from cache."""
    over = result.get("backtest", {}).get("overfitting", {})
    moments = over.get("_moments")
    trials = over.get("_trial_sharpes") or []
    if moments:
        d = portfolio.deflated_sharpe_from(moments, trials, extra_trials=prior_trials)
        over["dsr"] = None if d["dsr"] is None else round(d["dsr"], 3)
        over["trials"] = d["trials"]
    result["spec"]["prior_trials"] = int(prior_trials)
    result["cached"] = True
    return result
