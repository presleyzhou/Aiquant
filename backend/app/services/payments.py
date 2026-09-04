"""Checkout for paid marketplace items — two rails, one order model.

- **card** → Stripe Checkout (cards, Apple Pay / Google Pay; Alipay and
  WeChat Pay when enabled in the Stripe dashboard and listed in
  STRIPE_PAYMENT_METHODS). Community listings whose seller onboarded through
  Stripe Connect Express are paid out directly with the platform fee taken as
  an application fee.
- **crypto** → Coinbase Commerce hosted checkout (BTC, ETH, USDC, …).

Both are stateless: status is polled from the provider, so nothing has to
persist for a purchase to complete. Confirmed orders are additionally written
to the ledger (kvstore) so sellers can see their sales. Webhooks are verified
with the providers' HMAC schemes and feed the same ledger.

Without keys a rail is simply absent; with no rail at all the flow runs in a
clearly-labelled **demo** mode where nothing can be paid and the buyer's
"confirmation" is a button. Demo tokens are marked demo forever.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time
import uuid
from typing import Any

import httpx

from app.config import get_settings
from app.services import listings, marketplace, wallet

log = logging.getLogger(__name__)

COINBASE_API = "https://api.commerce.coinbase.com"
STRIPE_API = "https://api.stripe.com/v1"

_CB_STATUS = {
    "NEW": "pending", "PENDING": "pending", "SIGNED": "pending",
    "COMPLETED": "confirmed", "RESOLVED": "confirmed",
    "EXPIRED": "failed", "CANCELED": "failed", "UNRESOLVED": "pending",
}


class PaymentError(RuntimeError):
    pass


# ------------------------------------------------------------ providers


def card_enabled() -> bool:
    return bool(get_settings().stripe_secret_key)


def crypto_enabled() -> bool:
    return bool(get_settings().coinbase_commerce_api_key)


def provider_name() -> str:
    """Legacy single-provider label kept for the older /charges endpoints."""
    return "coinbase_commerce" if crypto_enabled() else "demo"


def config() -> dict[str, Any]:
    from app.services import kvstore

    card, crypto = card_enabled(), crypto_enabled()
    demo = not (card or crypto)
    if demo:
        note = "未配置支付通道（STRIPE_SECRET_KEY / COINBASE_COMMERCE_API_KEY），当前为演示流程：不会发生任何真实转账。"
    else:
        rails = [r for r, on in (("银行卡 / Apple Pay / Google Pay（Stripe）", card), ("加密货币（Coinbase Commerce）", crypto)) if on]
        note = "支持 " + " 与 ".join(rails) + "，均在供应商托管页面完成支付。"
    s = get_settings()
    return {
        "methods": {"card": card, "crypto": crypto},
        "providers": {"card": "stripe" if card else None, "crypto": "coinbase_commerce" if crypto else None},
        "demo": demo,
        "connect": card,  # Stripe Connect onboarding available whenever Stripe is
        "platform_fee_pct": s.platform_fee_pct,
        "persistence": kvstore.mode(),
        "note": note,
        # legacy fields
        "provider": provider_name(),
        "real": not demo,
    }


def _resolve_item(item_id: str) -> tuple[dict, dict | None]:
    """(public item dict, community listing row | None)."""
    row = listings.get(item_id)
    if row is not None:
        return listings.serialize(row), row
    item = marketplace.get_item(item_id)
    if item is None:
        raise PaymentError(f"no marketplace item {item_id!r}")
    return item, None


# ------------------------------------------------------------- checkout


async def create_checkout(item_id: str, method: str, return_url: str | None) -> dict[str, Any]:
    item, row = _resolve_item(item_id)
    price = item.get("price")
    if not price:
        raise PaymentError(f"item {item_id!r} is free — nothing to charge")
    if method not in {"card", "crypto"}:
        raise PaymentError("method must be card or crypto")
    base = {
        "item_id": item_id, "method": method, "amount": price["amount"], "currency": price["currency"],
        "status": "pending",
    }
    meta = {"item_id": item["id"], "kind": "item"}
    ret = f"provider={{provider}}&item={item['id']}&order={{order}}"
    if method == "card" and card_enabled():
        return {**base, **await _stripe_session(item, row, return_url, meta, ret)}
    if method == "crypto" and crypto_enabled():
        return {**base, **await _coinbase_charge(item, meta)}
    if card_enabled() or crypto_enabled():
        raise PaymentError(f"payment method {method!r} is not configured on this site")
    return {**base, "order_id": f"demo_{uuid.uuid4().hex[:16]}", "provider": "demo", "demo": True, "hosted_url": None}


async def create_topup(amount_usd: float, method: str, account_secret: str, return_url: str | None) -> dict[str, Any]:
    """Fund the site wallet. Same rails as an item purchase; the order's
    metadata says it is a top-up for a given account hash."""
    if not wallet.MIN_TOPUP_USD <= amount_usd <= wallet.MAX_TOPUP_USD:
        raise PaymentError(f"top-up must be ${wallet.MIN_TOPUP_USD:.0f}–${wallet.MAX_TOPUP_USD:.0f}")
    if method not in {"card", "crypto"}:
        raise PaymentError("method must be card or crypto")
    h = wallet.account_hash(account_secret)
    amount = f"{amount_usd:.2f}"
    product = {"id": f"topup_{h[:8]}", "name": f"AIQUANT 钱包充值 ${amount}", "tagline": "Wallet top-up",
               "price": {"amount": amount, "currency": "USD"}}
    base = {"kind": "topup", "method": method, "amount": amount, "currency": "USD", "status": "pending"}
    meta = {"kind": "topup", "account": h, "amount": amount}
    ret = f"provider={{provider}}&topup={amount}&order={{order}}"
    if method == "card" and card_enabled():
        return {**base, **await _stripe_session(product, None, return_url, meta, ret)}
    if method == "crypto" and crypto_enabled():
        return {**base, **await _coinbase_charge(product, meta)}
    if card_enabled() or crypto_enabled():
        raise PaymentError(f"payment method {method!r} is not configured on this site")
    return {**base, "order_id": f"demo_{uuid.uuid4().hex[:16]}", "provider": "demo", "demo": True, "hosted_url": None}


async def _stripe_session(item: dict, row: dict | None, return_url: str | None, meta: dict[str, str], ret: str) -> dict:
    s = get_settings()
    site = (return_url or s.site_url).split("#")[0]
    sep = "&" if "?" in site else "?"
    success = f"{site}{sep}view=market&" + ret.format(provider="stripe", order="{CHECKOUT_SESSION_ID}")
    cancel = f"{site}{sep}view=market&cancelled=1"
    cents = round(float(item["price"]["amount"]) * 100)
    form: dict[str, str] = {
        "mode": "payment",
        "success_url": success,
        "cancel_url": cancel,
        "line_items[0][quantity]": "1",
        "line_items[0][price_data][currency]": item["price"]["currency"].lower(),
        "line_items[0][price_data][unit_amount]": str(cents),
        "line_items[0][price_data][product_data][name]": item["name"][:120],
        "line_items[0][price_data][product_data][description]": (item.get("tagline") or item["name"])[:200],
    }
    for k, v in meta.items():
        form[f"metadata[{k}]"] = v
    for i, pm in enumerate(p.strip() for p in s.stripe_payment_methods.split(",") if p.strip()):
        form[f"payment_method_types[{i}]"] = pm
        if pm == "wechat_pay":
            form["payment_method_options[wechat_pay][client]"] = "web"
    if row and row["payout"]["method"] == "stripe":
        fee = round(cents * s.platform_fee_pct / 100)
        form["payment_intent_data[application_fee_amount]"] = str(fee)
        form["payment_intent_data[transfer_data][destination]"] = row["payout"]["stripe_account"]
    data = await _stripe("POST", "/checkout/sessions", form)
    return {"order_id": data["id"], "provider": "stripe", "demo": False, "hosted_url": data["url"],
            "expires_at": data.get("expires_at")}


async def _coinbase_charge(item: dict, meta: dict[str, str]) -> dict:
    s = get_settings()
    payload = {
        "name": item["name"],
        "description": (item.get("tagline") or item["name"])[:200],
        "pricing_type": "fixed_price",
        "local_price": {"amount": item["price"]["amount"], "currency": item["price"]["currency"]},
        "metadata": meta,
    }
    headers = {"X-CC-Api-Key": s.coinbase_commerce_api_key, "Content-Type": "application/json"}
    async with httpx.AsyncClient(timeout=20) as client:
        resp = await client.post(f"{COINBASE_API}/charges", json=payload, headers=headers)
        body = resp.json()
    if resp.status_code >= 400:
        message = body.get("error", {}).get("message", str(body)[:200])
        raise PaymentError(f"Coinbase Commerce rejected the charge: {message}")
    data = body["data"]
    return {"order_id": data["code"], "provider": "coinbase_commerce", "demo": False,
            "hosted_url": data["hosted_url"], "expires_at": data.get("expires_at")}


async def _stripe(method: str, path: str, form: dict[str, str] | None = None) -> dict:
    s = get_settings()
    async with httpx.AsyncClient(timeout=20, auth=(s.stripe_secret_key or "", "")) as client:
        resp = await client.request(method, f"{STRIPE_API}{path}", data=form)
        body = resp.json()
    if resp.status_code >= 400:
        message = body.get("error", {}).get("message", str(body)[:200])
        raise PaymentError(f"Stripe: {message}")
    return body


# --------------------------------------------------------------- status


def _confirm_topup(order_id: str, provider: str, account: str, amount: str | None, *, demo: bool) -> dict:
    amt = float(amount or 0)
    w = wallet.credit(account, amt, demo=demo, ref=order_id, kind="topup", note=provider)
    try:
        listings.record_order({"order_id": order_id, "provider": provider, "item_id": None, "kind": "topup",
                               "account": account, "amount": amount, "currency": "USD", "status": "confirmed", "demo": demo})
    except Exception as exc:  # noqa: BLE001
        log.warning("order ledger write failed: %s", exc)
    return {"order_id": order_id, "provider": provider, "status": "confirmed", "demo": demo, "kind": "topup",
            "amount": amount, "wallet": w}


def _settle(meta: dict, order_id: str, provider: str, amount: str | None, fallback_item: str | None) -> dict | None:
    """Dispatch a confirmed provider order by its metadata."""
    if meta.get("kind") == "topup" and meta.get("account"):
        return _confirm_topup(order_id, provider, meta["account"], meta.get("amount") or amount, demo=False)
    item = meta.get("item_id") or fallback_item
    if item:
        return _confirm(order_id, provider, item, amount, demo=False)
    return None


def _confirm(order_id: str, provider: str, item_id: str, amount: str | None, *, demo: bool) -> dict:
    token = listings.issue_entitlement(item_id, order_id, provider, demo=demo)
    try:
        listings.record_order({
            "order_id": order_id, "provider": provider, "item_id": item_id,
            "amount": amount, "currency": "USD", "status": "confirmed", "demo": demo,
        })
    except Exception as exc:
        log.warning("order ledger write failed: %s", exc)
    return {"order_id": order_id, "provider": provider, "status": "confirmed", "demo": demo,
            "item_id": item_id, "token": token}


async def order_status(provider: str, order_id: str, item_id: str | None = None) -> dict[str, Any]:
    if provider == "demo" or order_id.startswith("demo_"):
        # The server never fabricates a settled demo payment; the client must
        # call confirm_demo explicitly (and the token carries demo=True).
        return {"order_id": order_id, "provider": "demo", "status": "pending", "demo": True}
    if provider == "stripe":
        if not card_enabled():
            raise PaymentError("Stripe is not configured")
        data = await _stripe("GET", f"/checkout/sessions/{order_id}")
        meta = data.get("metadata") or {}
        item = meta.get("item_id") or item_id
        paid = data.get("payment_status") == "paid"
        status = "confirmed" if paid else ("failed" if data.get("status") == "expired" else "pending")
        amount = f"{(data.get('amount_total') or 0) / 100:.2f}"
        if status == "confirmed":
            settled = _settle(meta, order_id, "stripe", amount, item_id)
            if settled:
                return settled
        return {"order_id": order_id, "provider": "stripe", "status": status, "demo": False, "item_id": item}
    if provider == "coinbase_commerce":
        if not crypto_enabled():
            raise PaymentError("Coinbase Commerce is not configured")
        headers = {"X-CC-Api-Key": get_settings().coinbase_commerce_api_key}
        async with httpx.AsyncClient(timeout=20) as client:
            resp = await client.get(f"{COINBASE_API}/charges/{order_id}", headers=headers)
            body = resp.json()
        if resp.status_code >= 400:
            raise PaymentError(f"charge {order_id!r} not found at provider")
        data = body["data"]
        timeline = data.get("timeline") or [{}]
        status = _CB_STATUS.get(timeline[-1].get("status", "NEW"), "pending")
        meta = data.get("metadata") or {}
        item = meta.get("item_id") or item_id
        amount = (data.get("pricing") or {}).get("local", {}).get("amount")
        if status == "confirmed":
            settled = _settle(meta, order_id, "coinbase_commerce", amount, item_id)
            if settled:
                return settled
        return {"order_id": order_id, "provider": "coinbase_commerce", "status": status, "demo": False,
                "item_id": item, "provider_status": timeline[-1].get("status")}
    raise PaymentError(f"unknown provider {provider!r}")


def confirm_demo(order_id: str, item_id: str) -> dict:
    if card_enabled() or crypto_enabled():
        raise PaymentError("demo confirmation is disabled when a real payment rail is configured")
    if not order_id.startswith("demo_"):
        raise PaymentError("not a demo order")
    item, _ = _resolve_item(item_id)
    return _confirm(order_id, "demo", item_id, (item.get("price") or {}).get("amount"), demo=True)


def confirm_demo_topup(order_id: str, account_secret: str, amount_usd: float) -> dict:
    if card_enabled() or crypto_enabled():
        raise PaymentError("demo top-ups are disabled when a real payment rail is configured")
    if not order_id.startswith("demo_"):
        raise PaymentError("not a demo order")
    if not wallet.MIN_TOPUP_USD <= amount_usd <= wallet.MAX_TOPUP_USD:
        raise PaymentError("amount out of range")
    return _confirm_topup(order_id, "demo", wallet.account_hash(account_secret), f"{amount_usd:.2f}", demo=True)


def purchase_with_wallet(item_id: str, account_secret: str) -> dict:
    """Pay for an item from the site balance. Real balance → real
    entitlement + seller credit; demo balance → demo entitlement only."""
    item, row = _resolve_item(item_id)
    price = item.get("price")
    if not price:
        raise PaymentError(f"item {item_id!r} is free — nothing to charge")
    h = wallet.account_hash(account_secret)
    if row is not None and row["seller"] == h:
        raise PaymentError("you cannot buy your own listing")
    amount = float(price["amount"])
    order_id = f"wal_{uuid.uuid4().hex[:16]}"
    try:
        w, demo = wallet.debit(h, amount, ref=order_id, kind="purchase", note=item["name"][:60])
    except wallet.WalletError as exc:
        raise PaymentError(str(exc)) from exc
    out = _confirm(order_id, "wallet", item_id, price["amount"], demo=demo)
    if row is not None and not demo:
        try:
            wallet.seller_credit_for_sale(row["seller"], amount, ref=order_id, item_name=item["name"])
        except Exception as exc:  # noqa: BLE001 - never fail the buyer for a seller-ledger hiccup
            log.warning("seller credit failed: %s", exc)
    return {**out, "wallet": w}


# ------------------------------------------------------------- webhooks


def verify_stripe_signature(payload: bytes, header: str | None, tolerance: int = 300) -> bool:
    secret = get_settings().stripe_webhook_secret
    if not secret or not header:
        return False
    parts = dict(p.split("=", 1) for p in header.split(",") if "=" in p)
    ts, v1 = parts.get("t"), parts.get("v1")
    if not ts or not v1:
        return False
    if abs(time.time() - int(ts)) > tolerance:
        return False
    expected = hmac.new(secret.encode(), f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, v1)


def verify_coinbase_signature(payload: bytes, header: str | None) -> bool:
    secret = get_settings().coinbase_webhook_secret
    if not secret or not header:
        return False
    expected = hmac.new(secret.encode(), payload, hashlib.sha256).hexdigest()
    return hmac.compare_digest(expected, header)


def handle_stripe_event(event: dict) -> str:
    if event.get("type") != "checkout.session.completed":
        return "ignored"
    obj = event.get("data", {}).get("object", {})
    if obj.get("payment_status") != "paid":
        return "ignored"
    settled = _settle(obj.get("metadata") or {}, obj["id"], "stripe", f"{(obj.get('amount_total') or 0) / 100:.2f}", None)
    return "recorded" if settled else "ignored"


def handle_coinbase_event(event: dict) -> str:
    ev = event.get("event", {})
    if ev.get("type") not in {"charge:confirmed", "charge:resolved"}:
        return "ignored"
    data = ev.get("data", {})
    amount = (data.get("pricing") or {}).get("local", {}).get("amount")
    settled = _settle(data.get("metadata") or {}, data["code"], "coinbase_commerce", amount, None)
    return "recorded" if settled else "ignored"


# ------------------------------------------------------- stripe connect


async def connect_onboard(email: str | None, return_url: str | None) -> dict:
    if not card_enabled():
        raise PaymentError("Stripe is not configured — sellers can still receive crypto payouts")
    s = get_settings()
    form = {"type": "express", "capabilities[transfers][requested]": "true"}
    if email:
        form["email"] = email
    acct = await _stripe("POST", "/accounts", form)
    site = return_url or s.site_url
    link = await _stripe("POST", "/account_links", {
        "account": acct["id"], "type": "account_onboarding",
        "return_url": f"{site}{'&' if '?' in site else '?'}view=market&connect={acct['id']}",
        "refresh_url": f"{site}{'&' if '?' in site else '?'}view=market&connect_refresh={acct['id']}",
    })
    return {"account_id": acct["id"], "url": link["url"]}


async def connect_status(account_id: str) -> dict:
    if not card_enabled():
        raise PaymentError("Stripe is not configured")
    acct = await _stripe("GET", f"/accounts/{account_id}")
    return {"account_id": account_id, "charges_enabled": bool(acct.get("charges_enabled")),
            "payouts_enabled": bool(acct.get("payouts_enabled")),
            "details_submitted": bool(acct.get("details_submitted"))}


# -------------------------------------------------------------- legacy


async def create_charge(item_id: str) -> dict[str, Any]:
    """Older crypto-only entry point; kept so existing clients keep working."""
    out = await create_checkout(item_id, "crypto" if crypto_enabled() else ("card" if card_enabled() else "crypto"), None)
    return {**out, "charge_id": out["order_id"]}


async def charge_status(charge_id: str) -> dict[str, Any]:
    provider = "demo" if charge_id.startswith("demo_") else ("stripe" if charge_id.startswith("cs_") else "coinbase_commerce")
    out = await order_status(provider, charge_id)
    return {**out, "charge_id": charge_id}
