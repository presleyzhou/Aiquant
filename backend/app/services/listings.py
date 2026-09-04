"""Community listings (sell side) + order ledger + signed entitlements.

Sellers are identified by a secret their browser generates once; the server
stores only its SHA-256, so a leaked store reveals no credentials. A listing's
paid payload is never included in the public catalogue — it is released only
against a valid entitlement token, which the payments layer signs after the
provider confirms the money moved (or, in demo mode, a token that says so).
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import logging
import re
import secrets
import time
from typing import Any

from app.config import get_settings
from app.services import factor_dsl, kvstore

log = logging.getLogger(__name__)

_FALLBACK_SECRET = secrets.token_hex(32)
_STRATEGIES = {"sma_cross", "ema_cross", "rsi_reversion", "buy_and_hold", "kronos_signal"}
_PAYLOAD_KEYS = {
    "strategy", "fast", "slow", "rsi_period", "rsi_oversold", "rsi_overbought",
    "kronos_horizon", "period", "symbol",
}
MAX_PRICE_USD = 999.0


class ListingError(ValueError):
    pass


def _secret() -> bytes:
    s = get_settings().marketplace_secret
    if not s:
        log.warning("MARKETPLACE_SECRET unset — entitlement tokens will not survive restarts")
        return _FALLBACK_SECRET.encode()
    return s.encode()


def seller_hash(seller_secret: str) -> str:
    return hashlib.sha256(seller_secret.encode()).hexdigest()


# ----------------------------------------------------------- entitlements


def issue_entitlement(item_id: str, order_id: str, provider: str, *, demo: bool) -> str:
    body = {"item": item_id, "order": order_id, "provider": provider, "demo": demo, "ts": int(time.time())}
    raw = base64.urlsafe_b64encode(json.dumps(body, separators=(",", ":")).encode()).decode().rstrip("=")
    sig = hmac.new(_secret(), raw.encode(), hashlib.sha256).hexdigest()[:32]
    return f"{raw}.{sig}"


def verify_entitlement(token: str | None, item_id: str | None = None) -> dict | None:
    if not token or "." not in token:
        return None
    raw, sig = token.rsplit(".", 1)
    expected = hmac.new(_secret(), raw.encode(), hashlib.sha256).hexdigest()[:32]
    if not hmac.compare_digest(sig, expected):
        return None
    try:
        body = json.loads(base64.urlsafe_b64decode(raw + "=" * (-len(raw) % 4)))
    except ValueError:
        return None
    if item_id is not None and body.get("item") != item_id:
        return None
    return body


# --------------------------------------------------------------- listings


def _validate_payload(kind: str, payload: dict) -> dict:
    if kind == "factor":
        expr = str(payload.get("expression", "")).strip()
        if not expr:
            raise ListingError("factor listing needs an expression")
        try:
            factor_dsl.parse(expr)
        except factor_dsl.FactorError as exc:
            raise ListingError(f"invalid factor expression: {exc}") from exc
        market = str(payload.get("market", "us"))
        if market not in {"us", "crypto"}:
            raise ListingError("factor market must be us or crypto")
        horizon = int(payload.get("horizon", 10))
        if not 1 <= horizon <= 60:
            raise ListingError("factor horizon must be 1–60")
        out = {"expression": expr, "market": market, "horizon": horizon}
        for k in ("is_ic", "is_icir", "oos_ic", "hypothesis"):
            if k in payload and payload[k] is not None:
                out[k] = payload[k] if k == "hypothesis" else float(payload[k])
        return out
    strategy = str(payload.get("strategy", ""))
    if strategy not in _STRATEGIES:
        raise ListingError(f"unknown strategy {strategy!r}")
    clean = {k: v for k, v in payload.items() if k in _PAYLOAD_KEYS}
    for k in ("fast", "slow", "rsi_period", "kronos_horizon"):
        if k in clean:
            clean[k] = int(clean[k])
            if not 1 <= clean[k] <= 400:
                raise ListingError(f"{k} out of range")
    if strategy in {"sma_cross", "ema_cross"} and clean.get("fast", 0) >= clean.get("slow", 1):
        raise ListingError("fast window must be shorter than slow window")
    return clean


def _validate_payout(payout: dict, price: float) -> dict:
    method = str(payout.get("method", "none"))
    if price <= 0:
        return {"method": "none"}
    if method == "crypto":
        addr = str(payout.get("address", "")).strip()
        if not re.fullmatch(r"[A-Za-z0-9:_-]{20,120}", addr):
            raise ListingError("payout address looks malformed")
        asset = str(payout.get("asset", "USDC"))[:12]
        return {"method": "crypto", "address": addr, "asset": asset}
    if method == "stripe":
        acct = str(payout.get("stripe_account", "")).strip()
        if not re.fullmatch(r"acct_[A-Za-z0-9]{8,40}", acct):
            raise ListingError("stripe_account must look like acct_…")
        return {"method": "stripe", "stripe_account": acct}
    raise ListingError("paid listings need a payout method (crypto or stripe)")


def create(body: dict) -> dict:
    seller_secret = str(body.get("seller_secret", ""))
    if not 16 <= len(seller_secret) <= 128:
        raise ListingError("seller_secret must be 16–128 chars")
    kind = str(body.get("type", ""))
    if kind not in {"strategy", "factor"}:
        raise ListingError("type must be strategy or factor")
    name = str(body.get("name", "")).strip()
    if not 2 <= len(name) <= 60:
        raise ListingError("name must be 2–60 chars")
    tagline = str(body.get("tagline", "")).strip()[:120]
    description = str(body.get("description", "")).strip()[:2000]
    author = (str(body.get("author", "")).strip() or "社区卖家")[:40]
    tags = [str(t).strip()[:16] for t in (body.get("tags") or []) if str(t).strip()][:6]
    try:
        price = round(float(body.get("price_usd", 0) or 0), 2)
    except (TypeError, ValueError) as exc:
        raise ListingError("price_usd must be a number") from exc
    if not 0 <= price <= MAX_PRICE_USD:
        raise ListingError(f"price_usd must be 0–{MAX_PRICE_USD:.0f}")
    risk = body.get("risk")
    if risk not in (None, "low", "medium", "high"):
        raise ListingError("risk must be low|medium|high")

    listing = {
        "id": f"c_{secrets.token_hex(6)}",
        "type": kind,
        "name": name,
        "tagline": tagline or name,
        "description": description or tagline or name,
        "author": author,
        "version": "1.0",
        "tags": tags,
        "risk": risk if kind == "strategy" else None,
        "price_usd": price,
        "payload": _validate_payload(kind, dict(body.get("payload") or {})),
        "payout": _validate_payout(dict(body.get("payout") or {}), price),
        "seller": seller_hash(seller_secret),
        "created_at": int(time.time()),
        "status": "active",
    }
    kvstore.put(f"listing:{listing['id']}", listing)
    return listing


def get(listing_id: str) -> dict | None:
    if not listing_id.startswith("c_"):
        return None
    return kvstore.get(f"listing:{listing_id}")


def active() -> list[dict]:
    rows = [r for r in kvstore.list_prefix("listing") if r.get("status") == "active"]
    rows.sort(key=lambda r: -r.get("created_at", 0))
    return rows


def remove(listing_id: str, seller_secret: str) -> bool:
    row = get(listing_id)
    if row is None:
        return False
    if not hmac.compare_digest(row["seller"], seller_hash(seller_secret)):
        raise ListingError("not the owner of this listing")
    kvstore.delete(f"listing:{listing_id}")
    return True


def serialize(row: dict, *, unlocked: bool = False) -> dict:
    """Public shape (same as catalogue items). Paid payloads stay server-side
    until an entitlement is presented."""
    free = row["price_usd"] <= 0
    integration: dict[str, Any] = {}
    if free or unlocked:
        integration = {"backtest": row["payload"]} if row["type"] == "strategy" else {"factor": row["payload"]}
    return {
        "id": row["id"],
        "type": row["type"],
        "name": row["name"],
        "tagline": row["tagline"],
        "description": row["description"],
        "author": row["author"],
        "version": row["version"],
        "tags": row["tags"],
        "tier": "free" if free else "paid",
        "risk": row.get("risk"),
        "integration": integration,
        "price": None if free else {"amount": f"{row['price_usd']:.2f}", "currency": "USD"},
        "community": True,
        "locked": not (free or unlocked),
        "payout_method": row["payout"]["method"],
        "created_at": row["created_at"],
        "sales": sales_count(row["id"]),
    }


# ------------------------------------------------------------------ orders


def record_order(order: dict) -> None:
    order = dict(order)
    order.setdefault("at", int(time.time()))
    kvstore.put(f"order:{order['order_id']}", order)


def orders_for(item_id: str) -> list[dict]:
    return [o for o in kvstore.list_prefix("order") if o.get("item_id") == item_id]


def sales_count(item_id: str) -> int:
    return sum(1 for o in orders_for(item_id) if o.get("status") == "confirmed" and not o.get("demo"))


def seller_summary(seller_secret: str) -> list[dict]:
    h = seller_hash(seller_secret)
    fee = get_settings().platform_fee_pct / 100
    out = []
    for row in kvstore.list_prefix("listing"):
        if row.get("seller") != h:
            continue
        confirmed = [o for o in orders_for(row["id"]) if o.get("status") == "confirmed"]
        gross = sum(float(o.get("amount", 0)) for o in confirmed if not o.get("demo"))
        out.append({
            **serialize(row, unlocked=True),
            "status": row.get("status"),
            "payout": row["payout"],
            "sales": len([o for o in confirmed if not o.get("demo")]),
            "demo_sales": len([o for o in confirmed if o.get("demo")]),
            "gross_usd": round(gross, 2),
            "net_usd": round(gross * (1 - fee), 2),
        })
    out.sort(key=lambda r: -r["created_at"])
    return out
