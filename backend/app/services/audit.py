"""Append-only audit trail for money- and trust-relevant events.

Every entry is one KV document (`audit:<ms>-<rand>`) so the operator can
answer "who did what, when" after the fact: order settlements, refunds,
withdrawals and their approval, listing create/remove, admin actions and
account claims. Writes never raise into the caller — losing an audit line
must not fail a payment — but the failure is reported to Sentry.

Actors are coarse on purpose: `admin`, `webhook`, `system`, or
`account:<first 12 hex of the account hash>`; no e-mails, no raw secrets.
"""

from __future__ import annotations

import itertools
import json
import logging
import secrets
import time

from app.services import kvstore

log = logging.getLogger("aiquant.audit")

CAP = 2000          # newest kept; older lines are pruned opportunistically
_DETAIL_MAX = 600   # chars of JSON per entry
_seq = itertools.count()  # keeps same-millisecond entries in write order within a process


def actor_for_account(account_hash: str | None) -> str:
    return f"account:{account_hash[:12]}" if account_hash else "anonymous"


def _safe_detail(detail: dict | None) -> dict:
    if not detail:
        return {}
    out: dict = {}
    for k, v in detail.items():
        if v is None:
            continue
        if isinstance(v, (int, float, bool)):
            out[str(k)] = v
        else:
            out[str(k)] = str(v)[:160]
    if len(json.dumps(out, ensure_ascii=False)) > _DETAIL_MAX:
        out = {"truncated": True, **dict(list(out.items())[:6])}
    return out


def record(action: str, *, actor: str = "system", target: str = "", detail: dict | None = None) -> dict | None:
    """`action` is dotted: order.confirmed, order.refunded, dispute.opened,
    withdrawal.requested, withdrawal.paid, listing.created, admin.recheck …"""
    now_ms = int(time.time() * 1000)
    entry = {
        "id": f"{now_ms:013d}-{next(_seq) % 10_000:04d}-{secrets.token_hex(2)}",
        "at": now_ms // 1000,
        "action": action[:64],
        "actor": actor[:64],
        "target": str(target)[:120],
        "detail": _safe_detail(detail),
    }
    try:
        kvstore.put(f"audit:{entry['id']}", entry)
        if secrets.randbelow(50) == 0:
            prune()
    except Exception as exc:
        log.warning("audit write failed: %s", exc)
        try:
            from app.services.observe import capture

            capture(exc, "audit.record", action=action)
        except Exception:
            log.debug("audit capture skipped")
        return None
    return entry


def recent(limit: int = 200, *, action_prefix: str | None = None, target: str | None = None) -> list[dict]:
    rows = kvstore.list_prefix("audit")
    if action_prefix:
        rows = [r for r in rows if str(r.get("action", "")).startswith(action_prefix)]
    if target:
        rows = [r for r in rows if r.get("target") == target]
    rows.sort(key=lambda r: r.get("id", ""), reverse=True)
    return rows[: max(1, min(limit, 1000))]


def prune(cap: int = CAP) -> int:
    items = kvstore.list_prefix_items("audit")
    if len(items) <= cap:
        return 0
    items.sort(key=lambda kv: kv[1].get("id", ""))
    victims = items[: len(items) - cap]
    for key, _ in victims:
        kvstore.delete(key)
    return len(victims)
