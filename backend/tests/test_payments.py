"""Payment flow invariants — offline; no key configured means demo mode."""

import json

import pytest

from app.services import marketplace, payments


def test_provider_defaults_to_demo_without_key():
    cfg = payments.config()
    assert cfg["provider"] == "demo"
    assert cfg["real"] is False
    assert "演示" in cfg["note"]


async def test_demo_charge_shape():
    priced = [i for i in marketplace.list_items() if i.get("price")]
    assert priced, "catalog should contain at least one priced item"

    charge = await payments.create_charge(priced[0]["id"])
    json.dumps(charge)
    assert charge["demo"] is True
    assert charge["provider"] == "demo"
    assert charge["status"] == "pending"
    assert charge["charge_id"].startswith("demo_")
    # No address and no hosted URL in demo mode — nothing that could be paid.
    assert charge["hosted_url"] is None
    assert "address" not in charge


async def test_demo_charge_is_never_confirmed_server_side():
    """The server must not fabricate a settled payment."""
    charge = await payments.create_charge("trend-sniper-pro")
    status = await payments.charge_status(charge["charge_id"])
    assert status["status"] == "pending"
    assert status["demo"] is True


async def test_free_item_cannot_be_charged():
    with pytest.raises(payments.PaymentError, match="free"):
        await payments.create_charge("golden-cross")


async def test_unknown_item_cannot_be_charged():
    with pytest.raises(payments.PaymentError, match="no marketplace item"):
        await payments.create_charge("nope")


def test_priced_items_are_fully_functional():
    """Paid items must integrate exactly like free ones once unlocked."""
    from app.api.analytics import BacktestRequest

    strategy = marketplace.get_item("trend-sniper-pro")
    assert strategy["price"] == {"amount": "4.99", "currency": "USD"}
    BacktestRequest(symbol="SPY", **strategy["integration"]["backtest"])

    skill = marketplace.get_item("deep-due-diligence")
    assert skill["price"] == {"amount": "2.99", "currency": "USD"}
    assert "{symbol}" in skill["integration"]["prompt_template"]


def test_free_items_have_no_price():
    for item in marketplace.list_items():
        if item["id"] in {"trend-sniper-pro", "deep-due-diligence"}:
            continue
        assert item.get("price") is None, f"{item['id']} unexpectedly priced"
