"""Refunds and disputes for marketplace purchases.

A buyer who can prove they own an order — the account that paid from its
wallet, or the holder of the order's signed entitlement token — may open one
dispute per order inside the refund window. The operator resolves it from
the admin console:

* refund → the entitlement is revoked (payload downloads stop unlocking),
  the order is marked refunded, the buyer is made whole and the seller's
  credit for that sale is clawed back. How the buyer is made whole depends
  on the rail: wallet purchases are credited back to the wallet (real or
  demo, matching what was spent); Stripe orders are refunded at the
  provider; Coinbase Commerce charges cannot be reversed on-chain, so the
  amount is credited to the buyer's wallet when the account is known and
  otherwise flagged `manual` for the operator to settle by hand.
* reject → the dispute closes with the operator's note; the entitlement
  stays valid.

Everything is a KV document (`dispute:<order_id>`, `revoked:<order_id>`)
and every transition writes an audit line.
"""

from __future__ import annotations

import logging
import time

from app.config import get_settings
from app.services import audit, kvstore, listings, wallet

log = logging.getLogger("aiquant.disputes")

REASON_MAX = 500


class DisputeError(ValueError):
    pass


def refund_window_days() -> int:
    return int(get_settings().refund_window_days)


def _key(order_id: str) -> str:
    return f"dispute:{order_id}"


def get(order_id: str) -> dict | None:
    return kvstore.get(_key(order_id))


def is_revoked(order_id: str | None) -> bool:
    return bool(order_id) and kvstore.get(f"revoked:{order_id}") is not None


def _owns(order: dict, account_hash: str | None, token: str | None) -> bool:
    if account_hash and order.get("account") == account_hash:
        return True
    body = listings.verify_entitlement(token, order.get("item_id"), check_revoked=False) if token else None
    return bool(body and body.get("order") == order.get("order_id"))


def open_dispute(order_id: str, *, reason: str, account_hash: str | None = None, token: str | None = None) -> dict:
    reason = (reason or "").strip()
    if not 4 <= len(reason) <= REASON_MAX:
        raise DisputeError(f"reason must be 4–{REASON_MAX} characters")
    order = kvstore.get(f"order:{order_id}")
    if not order:
        raise DisputeError("order not found")
    if order.get("kind") == "topup":
        raise DisputeError("top-ups are not disputable here — withdraw the balance instead")
    if order.get("status") != "confirmed":
        raise DisputeError(f"order is {order.get('status')}, not confirmed")
    if not _owns(order, account_hash, token):
        raise DisputeError("you do not own this order")
    if time.time() - float(order.get("at", 0)) > refund_window_days() * 86_400:
        raise DisputeError(f"refund window of {refund_window_days()} days has passed")
    existing = get(order_id)
    if existing:
        raise DisputeError(f"a dispute for this order already exists ({existing['status']})")
    row = {
        "id": f"dp_{order_id}",
        "order_id": order_id,
        "item_id": order.get("item_id"),
        "account": order.get("account") or account_hash,
        "provider": order.get("provider"),
        "amount": order.get("amount"),
        "currency": order.get("currency", "USD"),
        "demo": bool(order.get("demo")),
        "reason": reason,
        "status": "open",
        "at": int(time.time()),
        "resolved_at": None,
        "resolution": None,
        "note": "",
        "refund": None,
    }
    kvstore.put(_key(order_id), row)
    audit.record("dispute.opened", actor=audit.actor_for_account(row["account"]), target=order_id,
                 detail={"item": row["item_id"], "amount": row["amount"], "provider": row["provider"], "reason": reason[:120]})
    return row


def list_all(status: str | None = None) -> list[dict]:
    rows = kvstore.list_prefix("dispute")
    if status:
        rows = [r for r in rows if r.get("status") == status]
    rows.sort(key=lambda r: -r.get("at", 0))
    return rows


def for_account(account_hash: str) -> list[dict]:
    return [r for r in list_all() if r.get("account") == account_hash]


def lookup(order_id: str, *, account_hash: str | None, token: str | None) -> dict | None:
    row = get(order_id)
    if row is None:
        return None
    order = kvstore.get(f"order:{order_id}") or {}
    if not _owns(order, account_hash, token):
        raise DisputeError("you do not own this order")
    return row


def reassign_account(old: str, new: str) -> int:
    """Disputes opened from the browser identity follow the claimed account."""
    n = 0
    if old == new:
        return 0
    for row in kvstore.list_prefix("dispute"):
        if row.get("account") == old:
            row["account"] = new
            kvstore.put(_key(row["order_id"]), row)
            n += 1
    return n


# ---------------------------------------------------------------- operator


def _seller_of(item_id: str | None) -> tuple[str | None, str]:
    row = listings.get(item_id) if item_id else None
    if row is None:
        return None, ""
    return row.get("seller"), str(row.get("name", ""))


def _make_whole(row: dict, order: dict) -> dict:
    """Return the buyer's money. Returns a description of what happened."""
    amount = float(row.get("amount") or 0)
    provider = row.get("provider")
    account = row.get("account")
    ref = f"refund:{row['order_id']}"
    if amount <= 0:
        return {"mode": "none", "amount": 0.0}
    if provider == "wallet":
        wallet.credit(account, amount, demo=row["demo"], ref=ref, kind="refund", note=(row.get("item_id") or "")[:60])
        return {"mode": "wallet", "amount": amount, "demo": row["demo"]}
    if provider == "demo":
        return {"mode": "none", "amount": 0.0, "note": "demo order — nothing was charged"}
    if provider == "stripe":
        # resolved asynchronously by the API layer (network call); mark intent here
        return {"mode": "provider", "amount": amount, "pending": True}
    # coinbase_commerce (irreversible on-chain) or unknown rail
    if account:
        wallet.credit(account, amount, demo=False, ref=ref, kind="refund", note=f"{provider}:{row.get('item_id') or ''}"[:60])
        return {"mode": "wallet", "amount": amount, "demo": False, "note": f"{provider} cannot be reversed; credited to wallet"}
    return {"mode": "manual", "amount": amount, "note": f"{provider} cannot be reversed and the buyer has no wallet — settle by hand"}


def _claw_back(row: dict) -> dict:
    if row.get("demo"):
        return {"status": "skipped", "note": "demo sale — seller was never credited"}
    seller, name = _seller_of(row.get("item_id"))
    if not seller:
        return {"status": "skipped", "note": "catalogue item — no seller credit"}
    fee = get_settings().platform_fee_pct / 100
    net = round(float(row.get("amount") or 0) * (1 - fee), 2)
    if net <= 0:
        return {"status": "skipped", "note": "nothing to claw back"}
    try:
        wallet.debit(seller, net, ref=f"clawback:{row['order_id']}", kind="clawback", note=name[:60], allow_demo=False)
        return {"status": "done", "amount": net}
    except wallet.WalletError as exc:
        return {"status": "failed", "amount": net, "note": str(exc)}


def resolve(order_id: str, action: str, note: str = "") -> dict:
    """Blocking. `action` is refund | reject. Idempotent on a closed dispute."""
    row = get(order_id)
    if row is None:
        raise DisputeError("dispute not found")
    if row["status"] != "open":
        return row
    if action not in {"refund", "reject"}:
        raise DisputeError("action must be refund or reject")
    now = int(time.time())
    if action == "reject":
        row.update({"status": "rejected", "resolution": "reject", "note": note[:300], "resolved_at": now})
        kvstore.put(_key(order_id), row)
        audit.record("dispute.rejected", actor="admin", target=order_id, detail={"note": note[:120]})
        return row
    order = kvstore.get(f"order:{order_id}") or {}
    # 1. entitlement stops working immediately, whatever the money path is
    kvstore.put(f"revoked:{order_id}", {"order_id": order_id, "at": now, "reason": "refund"})
    # 2. order ledger reflects the reversal
    if order:
        order.update({"status": "refunded", "refunded_at": now})
        kvstore.put(f"order:{order_id}", order)
    # 3. buyer made whole, seller credit reversed
    refund = _make_whole(row, order)
    refund["clawback"] = _claw_back(row)
    row.update({"status": "refunded", "resolution": "refund", "note": note[:300], "resolved_at": now, "refund": refund})
    kvstore.put(_key(order_id), row)
    audit.record("dispute.refunded", actor="admin", target=order_id,
                 detail={"mode": refund.get("mode"), "amount": refund.get("amount"), "clawback": refund["clawback"].get("status"), "note": note[:120]})
    audit.record("order.refunded", actor="admin", target=order_id, detail={"item": row.get("item_id"), "provider": row.get("provider")})
    return row


def mark_provider_refund(order_id: str, result: dict) -> dict:
    """Called by the API layer after the Stripe refund call returns."""
    row = get(order_id)
    if row is None:
        raise DisputeError("dispute not found")
    refund = dict(row.get("refund") or {})
    refund.update({"pending": False, **result})
    row["refund"] = refund
    kvstore.put(_key(order_id), row)
    audit.record("refund.provider", actor="admin", target=order_id, detail=result)
    return row
