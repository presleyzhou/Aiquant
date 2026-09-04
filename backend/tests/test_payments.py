"""Payment + sell-side invariants — offline; no keys configured means demo mode."""

import hashlib
import hmac
import json
import time

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import kvstore, listings, marketplace, payments


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv("AIQUANT_CACHE_DIR", str(tmp_path))
    yield


def test_config_reports_demo_without_keys():
    cfg = payments.config()
    assert cfg["demo"] is True
    assert cfg["methods"] == {"card": False, "crypto": False}
    assert cfg["persistence"] == "file"
    assert "演示" in cfg["note"]
    # legacy fields still present for old clients
    assert cfg["provider"] == "demo" and cfg["real"] is False


async def test_demo_checkout_shape_and_no_server_side_settlement():
    priced = [i for i in marketplace.list_items() if i.get("price")]
    assert priced
    out = await payments.create_checkout(priced[0]["id"], "card", None)
    json.dumps(out)
    assert out["demo"] is True and out["provider"] == "demo"
    assert out["hosted_url"] is None and out["order_id"].startswith("demo_")
    status = await payments.order_status("demo", out["order_id"])
    assert status["status"] == "pending"  # never auto-confirmed


async def test_free_and_unknown_items_cannot_be_charged():
    with pytest.raises(payments.PaymentError, match="free"):
        await payments.create_checkout("golden-cross", "card", None)
    with pytest.raises(payments.PaymentError, match="no marketplace item"):
        await payments.create_checkout("nope", "crypto", None)


def test_demo_confirm_issues_demo_token_and_ledger_entry():
    out = payments.confirm_demo("demo_abc123", "trend-sniper-pro")
    assert out["status"] == "confirmed" and out["demo"] is True
    body = listings.verify_entitlement(out["token"], "trend-sniper-pro")
    assert body and body["demo"] is True and body["order"] == "demo_abc123"
    # wrong item → invalid; tampered → invalid
    assert listings.verify_entitlement(out["token"], "golden-cross") is None
    assert listings.verify_entitlement(out["token"][:-1] + "0", "trend-sniper-pro") is None
    assert listings.sales_count("trend-sniper-pro") == 0  # demo sales never count


def test_stripe_signature_verification(monkeypatch):
    from app.config import get_settings

    monkeypatch.setattr(get_settings(), "stripe_webhook_secret", "whsec_test")
    payload = b'{"type":"checkout.session.completed"}'
    ts = str(int(time.time()))
    sig = hmac.new(b"whsec_test", f"{ts}.".encode() + payload, hashlib.sha256).hexdigest()
    assert payments.verify_stripe_signature(payload, f"t={ts},v1={sig}")
    assert not payments.verify_stripe_signature(payload, f"t={ts},v1={'0' * 64}")
    assert not payments.verify_stripe_signature(payload, f"t={int(time.time()) - 10_000},v1={sig}")
    monkeypatch.setattr(get_settings(), "stripe_webhook_secret", None)


def test_kvstore_file_roundtrip():
    kvstore.put("listing:x1", {"id": "x1", "v": 1})
    kvstore.put("order:o1", {"order_id": "o1"})
    assert kvstore.get("listing:x1") == {"id": "x1", "v": 1}
    assert [r["id"] for r in kvstore.list_prefix("listing")] == ["x1"]
    kvstore.delete("listing:x1")
    assert kvstore.get("listing:x1") is None and kvstore.list_prefix("listing") == []


SELLER = "s" * 32


def _listing(**over):
    body = {
        "seller_secret": SELLER, "type": "strategy", "name": "均线突破 Pro", "tagline": "测试",
        "price_usd": 4.5, "payload": {"strategy": "sma_cross", "fast": 10, "slow": 30},
        "payout": {"method": "crypto", "address": "0x" + "a" * 40, "asset": "USDC"},
    }
    body.update(over)
    return body


def test_listing_lifecycle_and_payload_gating():
    client = TestClient(app)
    r = client.post("/api/marketplace/listings", json=_listing())
    assert r.status_code == 200, r.text
    item = r.json()["item"]
    assert item["community"] is True and item["price"] == {"amount": "4.50", "currency": "USD"}

    # public catalogue lists it but hides the payload
    items = client.get("/api/marketplace/items").json()["items"]
    pub = next(i for i in items if i["id"] == item["id"])
    assert pub["locked"] is True and pub["integration"] == {}

    # payload needs an entitlement
    assert client.get(f"/api/marketplace/listings/{item['id']}/payload").status_code == 402
    token = payments.confirm_demo("demo_z9", item["id"])["token"]
    ok = client.get(f"/api/marketplace/listings/{item['id']}/payload", params={"token": token})
    assert ok.status_code == 200 and ok.json()["integration"]["backtest"]["fast"] == 10

    # seller dashboard sees it; a stranger cannot remove it; the owner can
    mine = client.post("/api/marketplace/listings/mine", json={"seller_secret": SELLER}).json()["listings"]
    assert len(mine) == 1 and mine[0]["demo_sales"] == 1 and mine[0]["sales"] == 0
    assert client.post(f"/api/marketplace/listings/{item['id']}/remove", json={"seller_secret": "x" * 32}).status_code == 403
    assert client.post(f"/api/marketplace/listings/{item['id']}/remove", json={"seller_secret": SELLER}).status_code == 200
    assert client.get("/api/marketplace/items?type=community").json()["count"] == 0


def test_listing_validation_rejects_bad_input():
    with pytest.raises(listings.ListingError, match="fast window"):
        listings.create(_listing(payload={"strategy": "sma_cross", "fast": 50, "slow": 20}))
    with pytest.raises(listings.ListingError, match="payout"):
        listings.create(_listing(payout={}))
    with pytest.raises(listings.ListingError, match="invalid factor"):
        listings.create(_listing(type="factor", payload={"expression": "rank(close +", "market": "us"}))
    free_factor = listings.create(_listing(type="factor", price_usd=0, payout={},
                                           payload={"expression": "rank(delta(close, 5))", "market": "us", "horizon": 10}))
    assert listings.serialize(free_factor)["integration"]["factor"]["expression"] == "rank(delta(close, 5))"


def test_priced_catalog_items_are_fully_functional():
    from app.api.analytics import BacktestRequest

    strategy = marketplace.get_item("trend-sniper-pro")
    assert strategy["price"] == {"amount": "4.99", "currency": "USD"}
    BacktestRequest(symbol="SPY", **strategy["integration"]["backtest"])
    skill = marketplace.get_item("deep-due-diligence")
    assert "{symbol}" in skill["integration"]["prompt_template"]
