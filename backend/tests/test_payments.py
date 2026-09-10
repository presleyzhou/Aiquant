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
    assert listings.verify_entitlement(out["token"][:-1] + "x", "trend-sniper-pro") is None  # 'x' is never a hex digit
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


# ------------------------------------------------------------------ wallet


BUYER = "b" * 32


def test_wallet_topup_purchase_and_seller_credit():
    from app.services import wallet

    client = TestClient(app)
    # empty wallet
    w = client.post("/api/wallet", json={"account_secret": BUYER}).json()
    assert (w["balance_usd"], w["demo_usd"], w["entries"], w["identity"]) == (0.0, 0.0, [], "browser")

    # demo top-up (no rails configured) lands in the DEMO balance only
    t = client.post("/api/wallet/topup", json={"account_secret": BUYER, "amount_usd": 20, "method": "card"}).json()
    assert t["demo"] is True and t["kind"] == "topup"
    c = client.post(f"/api/wallet/topup/demo/{t['order_id']}/confirm", json={"account_secret": BUYER, "amount_usd": 20}).json()
    assert c["wallet"]["demo_usd"] == 20.0 and c["wallet"]["balance_usd"] == 0.0
    # idempotent: confirming the same order twice does not double-credit
    c2 = client.post(f"/api/wallet/topup/demo/{t['order_id']}/confirm", json={"account_secret": BUYER, "amount_usd": 20}).json()
    assert c2["wallet"]["demo_usd"] == 20.0

    # list something, buy it with the wallet → demo entitlement, no seller credit
    item = client.post("/api/marketplace/listings", json=_listing()).json()["item"]
    p = client.post("/api/wallet/purchase", json={"account_secret": BUYER, "item_id": item["id"]})
    assert p.status_code == 200, p.text
    body = p.json()
    assert body["demo"] is True and body["wallet"]["demo_usd"] == 15.5
    assert listings.verify_entitlement(body["token"], item["id"])["demo"] is True
    seller_wallet = wallet.view(wallet.account_hash(SELLER))
    assert seller_wallet["balance_usd"] == 0.0  # demo money never reaches sellers

    # a REAL credit (as a confirmed Stripe order would produce) pays the seller net of fee
    wallet.credit(wallet.account_hash(BUYER), 10, demo=False, ref="cs_test_1")
    body = client.post("/api/wallet/purchase", json={"account_secret": BUYER, "item_id": item["id"]}).json()
    assert body["demo"] is False and body["wallet"]["balance_usd"] == 5.5
    assert wallet.view(wallet.account_hash(SELLER))["balance_usd"] == 4.05  # 4.50 minus 10 %

    # sellers cannot buy their own listing; insufficient funds is a 400
    assert client.post("/api/wallet/purchase", json={"account_secret": SELLER, "item_id": item["id"]}).status_code == 400
    wallet.debit(wallet.account_hash(BUYER), 5.5, ref="x", kind="purchase")
    wallet.debit(wallet.account_hash(BUYER), 15.5, ref="y", kind="purchase")  # drain demo too
    r = client.post("/api/wallet/purchase", json={"account_secret": BUYER, "item_id": item["id"]})
    assert r.status_code == 400 and "insufficient" in r.json()["detail"]

    # seller withdraws real balance; demo balance is never withdrawable
    wd = client.post("/api/wallet/withdraw", json={"account_secret": SELLER, "amount_usd": 4, "method": "crypto", "address": "0x" + "c" * 40})
    assert wd.status_code == 200 and wd.json()["status"] == "pending" and wd.json()["balance_usd"] == 0.05
    assert client.post("/api/wallet/withdraw", json={"account_secret": BUYER, "amount_usd": 5, "method": "crypto", "address": "0x" + "c" * 40}).status_code == 400


def test_settle_routes_topup_metadata_to_wallet():
    from app.services import wallet

    h = wallet.account_hash(BUYER)
    out = payments._settle({"kind": "topup", "account": h, "amount": "25.00"}, "cs_topup_1", "stripe", "25.00", None)
    assert out["kind"] == "topup" and out["wallet"]["balance_usd"] == 25.0
    # replayed webhook → no double credit
    payments._settle({"kind": "topup", "account": h, "amount": "25.00"}, "cs_topup_1", "stripe", "25.00", None)
    assert wallet.view(h)["balance_usd"] == 25.0
    # item metadata still confirms an item
    out = payments._settle({"item_id": "trend-sniper-pro"}, "cs_item_1", "stripe", "4.99", None)
    assert out["status"] == "confirmed" and "token" in out


# ----------------------------------------------------------------- accounts


def test_account_endpoints_without_login_and_claim(monkeypatch):
    from app.services import auth, wallet

    client = TestClient(app)
    cfg = client.get("/api/account/config").json()
    assert cfg["enabled"] is False and "aiquant.factors.zoo" in cfg["sync_keys"]
    assert cfg["supabase_url"] is None and cfg["anon_key"] is None  # only published when enabled
    assert client.get("/api/account/me").json() == {"signed_in": False}
    assert client.get("/api/account/state").status_code == 401
    assert client.post("/api/wallet", json={}).status_code == 401  # no token, no secret

    # simulate a signed-in user: bearer tokens resolve to a fixed user
    async def fake_verify(token):
        return {"id": "user-123", "email": "a@b.c"} if token == "good" else None

    monkeypatch.setattr(auth, "verify", fake_verify)
    monkeypatch.setattr(auth, "enabled", lambda: True)
    hdr = {"Authorization": "Bearer good"}
    me = client.get("/api/account/me", headers=hdr).json()
    assert me["signed_in"] is True and me["email"] == "a@b.c"

    # state round-trip keeps only whitelisted keys
    put = client.put("/api/account/state", headers=hdr, json={"data": {"aiquant.factors.zoo": [{"expression": "rank(close)"}], "evil": 1}})
    assert put.status_code == 200 and put.json()["saved"] == 1
    got = client.get("/api/account/state", headers=hdr).json()
    assert got["data"] == {"aiquant.factors.zoo": [{"expression": "rank(close)"}]}

    # browser wallet + listing get claimed into the user account
    wallet.credit(wallet.account_hash(BUYER), 7.5, demo=False, ref="cs_x")
    lid = client.post("/api/marketplace/listings", json=_listing(seller_secret=BUYER)).json()["item"]["id"]
    res = client.post("/api/account/claim", headers=hdr, json={"account_secret": BUYER}).json()
    assert res["wallet"]["balance_usd"] == 7.5 and res["listings_moved"] == 1
    # the user now sees the wallet and owns the listing; the browser wallet is empty
    assert client.post("/api/wallet", headers=hdr, json={}).json()["balance_usd"] == 7.5
    assert client.post("/api/wallet", json={"account_secret": BUYER}).json()["balance_usd"] == 0.0
    assert client.post(f"/api/marketplace/listings/{lid}/remove", headers=hdr, json={}).status_code == 200
    # bad token with no secret → 401
    assert client.post("/api/wallet", headers={"Authorization": "Bearer bad"}, json={}).status_code == 401


def test_admin_endpoints_require_token_and_recheck_writes_health(monkeypatch):
    from app.config import get_settings
    from app.services import factor_mine

    client = TestClient(app)
    assert client.get("/api/admin/overview").status_code == 403
    monkeypatch.setattr(get_settings(), "admin_token", "secret-admin")
    hdr = {"X-Admin-Token": "secret-admin"}
    assert client.get("/api/admin/overview", headers=hdr).status_code == 200

    # a pending withdrawal can be rejected → refunded
    from app.services import wallet
    h = wallet.account_hash(SELLER)
    wallet.credit(h, 20, demo=False, ref="cs_w")
    wd = client.post("/api/wallet/withdraw", json={"account_secret": SELLER, "amount_usd": 5, "method": "crypto", "address": "0x" + "d" * 40}).json()
    assert wallet.view(h)["balance_usd"] == 15.0
    r = client.post(f"/api/admin/withdrawals/{wd['id']}", headers=hdr, json={"status": "rejected", "note": "bad address"})
    assert r.status_code == 200 and wallet.view(h)["balance_usd"] == 20.0
    assert client.get("/api/admin/withdrawals?status=rejected", headers=hdr).json()["withdrawals"][0]["id"] == wd["id"]

    # recheck sweeps a listed factor with a synthetic panel and exposes health publicly
    import numpy as np
    import pandas as pd
    idx = pd.date_range("2024-01-01", periods=420, freq="B", tz="UTC"); rng = np.random.default_rng(1)
    close = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0, 0.01, (420, 12)), axis=0)), index=idx, columns=[f"S{i}" for i in range(12)])
    panel = {"close": close, "open": close, "high": close * 1.01, "low": close * 0.99, "volume": close * 1000}
    monkeypatch.setattr(factor_mine, "_load_panel_blocking", lambda market: panel)
    client.post("/api/marketplace/listings", json=_listing(type="factor", price_usd=0, payout={}, payload={"expression": "rank(delta(close, 5))", "market": "us", "horizon": 10}))
    meta = client.post("/api/admin/recheck", headers=hdr).json()
    assert meta["done"] >= 1
    health = client.post("/api/factors/health", json={"market": "us", "expressions": ["rank(delta(close, 5))"]}).json()
    assert "rank(delta(close, 5))" in health["health"] and "grades" in health["health"]["rank(delta(close, 5))"]
    assert health["meta"]["done"] >= 1


def test_integrations_and_version(monkeypatch):
    from app.config import get_settings

    client = TestClient(app)
    v = client.get("/api/version").json()
    assert v["version"] and "integrations" in v["features"]
    assert client.get("/api/admin/integrations").status_code == 403
    monkeypatch.setattr(get_settings(), "admin_token", "secret-admin")
    body = client.get("/api/admin/integrations", headers={"X-Admin-Token": "secret-admin"}).json()
    names = {r["name"]: r for r in body["integrations"]}
    assert {"kv", "supabase", "stripe", "coinbase", "sentry", "anthropic", "kronos_remote", "market_data", "admin_token", "marketplace_secret"} <= set(names)
    assert names["kv"]["status"] == "amber"          # file store in tests
    assert names["stripe"]["status"] == "off" and names["supabase"]["status"] == "off"
    assert all(r["status"] in {"green", "amber", "red", "off"} for r in body["integrations"])
    assert sum(body["counts"].values()) == len(body["integrations"])
    monkeypatch.setattr(get_settings(), "admin_token", None)


def test_admin_warm_reports_coverage_and_refresh_redownloads(monkeypatch):
    import numpy as np
    import pandas as pd

    from app.config import get_settings
    from app.services import factor_mine

    calls = {"downloads": 0}
    idx = pd.date_range("2024-01-01", periods=300, freq="B", tz=None)

    def fake_download(tickers, period, label, min_symbols=8, market=None):
        calls["downloads"] += 1
        cols = list(tickers)[:5]
        close = pd.DataFrame(np.cumsum(np.ones((300, len(cols))), axis=0) + 100, index=idx, columns=cols)
        close.attrs.update({"provider": "yahoo+stooq", "requested": len(tickers), "missing": list(tickers)[5:7]})
        return {"close": close, "open": close, "high": close, "low": close, "volume": close}

    monkeypatch.setattr(factor_mine, "download_panel", fake_download)
    factor_mine._PANEL_CACHE.clear()
    monkeypatch.setattr(get_settings(), "admin_token", "secret-admin")
    hdr = {"X-Admin-Token": "secret-admin"}
    client = TestClient(app)
    w1 = client.post("/api/admin/warm?markets=us", headers=hdr).json()["warmed"]["us"]
    assert w1["symbols"] == 5 and w1["requested"] == len(factor_mine.UNIVERSES["us"]) and len(w1["missing"]) == 2
    assert w1["provider"] == "yahoo+stooq" and "seconds" in w1
    n = calls["downloads"]
    client.post("/api/admin/warm?markets=us", headers=hdr)           # cached → no new download
    assert calls["downloads"] == n
    client.post("/api/admin/warm?markets=us&refresh=true", headers=hdr)  # forced → re-download
    assert calls["downloads"] == n + 1
    monkeypatch.setattr(get_settings(), "admin_token", None)
    factor_mine._PANEL_CACHE.clear()


def test_listing_health_badge_comes_from_recheck():
    from app.services import kvstore

    client = TestClient(app)
    item = client.post("/api/marketplace/listings", json=_listing(type="factor", price_usd=0, payout={},
                       payload={"expression": "rank(delta(close, 7))", "market": "us", "horizon": 10})).json()["item"]
    assert item["health"] is None and item["days_listed"] == 0
    kvstore.put(listings.health_key("us", "rank(delta(close, 7))"), {
        "is_ic": -0.02, "oos_ic": -0.015, "recent_ic": -0.018, "as_of": "2026-09-01", "checked_at": 1_800_000_000,
        "grades": {"predictive": "B", "stability": "B", "robustness": "A", "tradability": "C", "significance": "B"}, "decayed": False, "best_horizon": 20,
    })
    pub = next(i for i in client.get("/api/marketplace/items?type=factor").json()["items"] if i["id"] == item["id"])
    assert pub["health"]["recent_ic"] == 0.018            # sign-aligned: the factor was accepted inverted
    assert pub["health"]["grades"]["robustness"] == "A" and pub["health"]["decayed"] is False
