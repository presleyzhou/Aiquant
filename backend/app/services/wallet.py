"""Site wallet: prepaid balance per account, funded by Stripe / Coinbase top-ups.

Accounts are the same browser-held secret the sell side uses; the server keeps
only its SHA-256, and every mutation is a ledger entry so a balance is always
the sum of its history. Two balances are tracked side by side and never mix:

- `balance_usd`  — funded by confirmed real payments; spends produce real
  entitlements and credit the seller's wallet net of the platform fee.
- `demo_usd`     — funded by demo top-ups when no payment rail is configured;
  spends produce demo entitlements and never credit a seller.

Withdrawals debit immediately and sit as a pending request the operator
settles by hand (crypto payout to the address given); the ledger shows it.
"""

from __future__ import annotations

import hashlib
import secrets
import time

from app.config import get_settings
from app.services import kvstore

MAX_TOPUP_USD = 2000.0
MIN_TOPUP_USD = 1.0
LEDGER_CAP = 200


class WalletError(ValueError):
    pass


def account_hash(secret: str) -> str:
    if not 16 <= len(secret) <= 128:
        raise WalletError("account secret must be 16–128 chars")
    return hashlib.sha256(secret.encode()).hexdigest()


def _key(h: str) -> str:
    return f"wallet:{h}"


def _load(h: str) -> dict:
    return kvstore.get(_key(h)) or {"account": h, "balance_usd": 0.0, "demo_usd": 0.0, "entries": []}


def _save(doc: dict) -> None:
    doc["entries"] = doc["entries"][-LEDGER_CAP:]
    doc["balance_usd"] = round(doc["balance_usd"], 2)
    doc["demo_usd"] = round(doc["demo_usd"], 2)
    kvstore.put(_key(doc["account"]), doc)


def _entry(kind: str, amount: float, *, demo: bool, ref: str, note: str = "") -> dict:
    return {"id": secrets.token_hex(4), "kind": kind, "amount": round(amount, 2), "demo": demo,
            "ref": ref, "note": note, "at": int(time.time())}


def view(h: str) -> dict:
    doc = _load(h)
    return {"balance_usd": doc["balance_usd"], "demo_usd": doc["demo_usd"],
            "entries": list(reversed(doc["entries"][-50:]))}


# ------------------------------------------------------------------ moves


def credit(h: str, amount: float, *, demo: bool, ref: str, kind: str = "topup", note: str = "") -> dict:
    if amount <= 0:
        raise WalletError("credit must be positive")
    # idempotent on ref: a webhook and a poll may both confirm the same order
    doc = _load(h)
    if any(e["ref"] == ref and e["kind"] == kind for e in doc["entries"]):
        return view(h)
    doc["demo_usd" if demo else "balance_usd"] += amount
    doc["entries"].append(_entry(kind, amount, demo=demo, ref=ref, note=note))
    _save(doc)
    return view(h)


def debit(h: str, amount: float, *, ref: str, kind: str, note: str = "", allow_demo: bool = True) -> tuple[dict, bool]:
    """Spend `amount`. Real balance first; falls back to the demo balance
    (flagging the spend as demo) only when the real one can't cover it.
    Returns (wallet view, spent_from_demo)."""
    if amount <= 0:
        raise WalletError("debit must be positive")
    doc = _load(h)
    if doc["balance_usd"] + 1e-9 >= amount:
        doc["balance_usd"] -= amount
        demo = False
    elif allow_demo and doc["demo_usd"] + 1e-9 >= amount:
        doc["demo_usd"] -= amount
        demo = True
    else:
        raise WalletError(
            f"insufficient balance: need ${amount:.2f}, have ${doc['balance_usd']:.2f} (demo ${doc['demo_usd']:.2f})"
        )
    doc["entries"].append(_entry(kind, -amount, demo=demo, ref=ref, note=note))
    _save(doc)
    return view(h), demo


def request_withdrawal(h: str, amount: float, method: str, address: str) -> dict:
    if amount < 1:
        raise WalletError("minimum withdrawal is $1")
    if method not in {"crypto", "bank"}:
        raise WalletError("method must be crypto or bank")
    address = address.strip()
    if not 6 <= len(address) <= 160:
        raise WalletError("payout destination looks malformed")
    wid = f"wd_{secrets.token_hex(6)}"
    # holds the funds immediately — never from the demo balance
    doc = _load(h)
    if doc["balance_usd"] + 1e-9 < amount:
        raise WalletError(f"insufficient real balance: ${doc['balance_usd']:.2f}")
    doc["balance_usd"] -= amount
    doc["entries"].append(_entry("withdraw", -amount, demo=False, ref=wid, note=f"{method}:{address[:24]}"))
    _save(doc)
    kvstore.put(f"withdraw:{wid}", {
        "id": wid, "account": h, "amount": round(amount, 2), "method": method, "address": address,
        "status": "pending", "at": int(time.time()),
    })
    return {"id": wid, "status": "pending", "amount": round(amount, 2), **view(h)}


def seller_credit_for_sale(seller_hash: str, gross: float, *, ref: str, item_name: str) -> None:
    fee = get_settings().platform_fee_pct / 100
    net = round(gross * (1 - fee), 2)
    if net > 0:
        credit(seller_hash, net, demo=False, ref=ref, kind="sale", note=item_name[:60])


def merge_into(old: str, new: str) -> dict:
    """Fold the browser-secret wallet `old` into the user wallet `new`
    (balances add, ledgers concatenate); `old` is emptied. Idempotent."""
    if old == new:
        return view(new)
    src = kvstore.get(_key(old))
    if not src:
        return view(new)
    dst = _load(new)
    dst["balance_usd"] += src.get("balance_usd", 0.0)
    dst["demo_usd"] += src.get("demo_usd", 0.0)
    dst["entries"] = sorted(dst["entries"] + src.get("entries", []), key=lambda e: e.get("at", 0))
    dst["entries"].append(_entry("topup", 0.0, demo=False, ref=f"claim:{old[:12]}", note="merged browser wallet"))
    _save(dst)
    kvstore.delete(_key(old))
    return view(new)
