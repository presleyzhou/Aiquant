"""Crypto checkout for paid marketplace items.

Two modes, chosen by configuration and reported honestly to the client:

- **coinbase_commerce** — when `COINBASE_COMMERCE_API_KEY` is set, charges are
  created through Coinbase Commerce and the buyer pays crypto on Coinbase's
  hosted checkout page. Status is polled from the provider, so nothing needs
  to persist server-side (works on stateless serverless deploys).

- **demo** — without a key, the flow runs end-to-end but is explicitly
  labelled a demo: no address is shown (a fake-but-plausible address would be
  a scam waiting to happen), nothing can be paid, and "confirmation" is a
  button the buyer clicks. The UI badges every demo purchase as 演示.

Entitlements live in the buyer's browser (localStorage). That is a deliberate
scope cut and documented in the README: real per-account entitlements need a
database and auth, which this site doesn't have yet.
"""

from __future__ import annotations

import logging
import uuid
from typing import Any

import aiohttp

from app.config import get_settings
from app.services import marketplace

log = logging.getLogger(__name__)

COINBASE_API = "https://api.commerce.coinbase.com"

# Coinbase Commerce charge statuses → our three-state machine.
_STATUS_MAP = {
    "NEW": "pending",
    "PENDING": "pending",
    "SIGNED": "pending",
    "COMPLETED": "confirmed",
    "RESOLVED": "confirmed",
    "EXPIRED": "failed",
    "CANCELED": "failed",
    "UNRESOLVED": "pending",  # over/underpaid — needs merchant action, not final
}


class PaymentError(RuntimeError):
    pass


def provider_name() -> str:
    return "coinbase_commerce" if get_settings().coinbase_commerce_api_key else "demo"


def config() -> dict[str, Any]:
    real = provider_name() == "coinbase_commerce"
    return {
        "provider": provider_name(),
        "real": real,
        "note": (
            "通过 Coinbase Commerce 托管页面以加密货币支付。"
            if real
            else "未配置 COINBASE_COMMERCE_API_KEY，当前为演示流程：不展示收款地址，不会发生任何真实转账。"
        ),
    }


async def create_charge(item_id: str) -> dict[str, Any]:
    item = marketplace.get_item(item_id)
    if item is None:
        raise PaymentError(f"no marketplace item {item_id!r}")
    price = item.get("price")
    if not price:
        raise PaymentError(f"item {item_id!r} is free — nothing to charge")

    if provider_name() == "demo":
        return {
            "charge_id": f"demo_{uuid.uuid4().hex[:16]}",
            "provider": "demo",
            "status": "pending",
            "demo": True,
            "item_id": item_id,
            "amount": price["amount"],
            "currency": price["currency"],
            "hosted_url": None,
        }

    settings = get_settings()
    payload = {
        "name": item["name"],
        "description": item["tagline"][:200],
        "pricing_type": "fixed_price",
        "local_price": {"amount": price["amount"], "currency": price["currency"]},
        "metadata": {"item_id": item_id},
    }
    headers = {
        "X-CC-Api-Key": settings.coinbase_commerce_api_key,
        "Content-Type": "application/json",
    }

    async with aiohttp.ClientSession() as session:
        async with session.post(
            f"{COINBASE_API}/charges", json=payload, headers=headers,
            timeout=aiohttp.ClientTimeout(total=20),
        ) as resp:
            body = await resp.json()
            if resp.status >= 400:
                message = body.get("error", {}).get("message", str(body)[:200])
                raise PaymentError(f"Coinbase Commerce rejected the charge: {message}")

    data = body["data"]
    return {
        "charge_id": data["code"],
        "provider": "coinbase_commerce",
        "status": "pending",
        "demo": False,
        "item_id": item_id,
        "amount": price["amount"],
        "currency": price["currency"],
        "hosted_url": data["hosted_url"],
        "expires_at": data.get("expires_at"),
    }


async def charge_status(charge_id: str) -> dict[str, Any]:
    """Current status of a charge.

    Demo charges are never confirmed server-side — the client owns the
    simulation and labels it accordingly. Real charges are looked up at the
    provider on every call (stateless by design).
    """
    if charge_id.startswith("demo_"):
        return {"charge_id": charge_id, "provider": "demo", "status": "pending", "demo": True}

    settings = get_settings()
    if not settings.coinbase_commerce_api_key:
        raise PaymentError("payment provider is not configured")

    headers = {"X-CC-Api-Key": settings.coinbase_commerce_api_key}
    async with aiohttp.ClientSession() as session:
        async with session.get(
            f"{COINBASE_API}/charges/{charge_id}", headers=headers,
            timeout=aiohttp.ClientTimeout(total=20),
        ) as resp:
            body = await resp.json()
            if resp.status >= 400:
                raise PaymentError(f"charge {charge_id!r} not found at provider")

    data = body["data"]
    timeline = data.get("timeline") or [{}]
    provider_status = timeline[-1].get("status", "NEW")
    return {
        "charge_id": charge_id,
        "provider": "coinbase_commerce",
        "status": _STATUS_MAP.get(provider_status, "pending"),
        "provider_status": provider_status,
        "demo": False,
        "hosted_url": data.get("hosted_url"),
    }
