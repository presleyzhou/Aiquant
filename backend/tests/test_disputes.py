"""Refunds / disputes and the audit trail — offline, file-backed KV."""

import time

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.services import audit, disputes, kvstore, listings, payments, wallet
from tests.test_payments import BUYER, SELLER, _listing

ADMIN = {"X-Admin-Token": "secret-admin"}


@pytest.fixture(autouse=True)
def _isolated_store(tmp_path, monkeypatch):
    monkeypatch.setenv("AIQUANT_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(get_settings(), "admin_token", "secret-admin")
    from app.services import ratelimit

    ratelimit._BUCKETS.clear()  # listings are limited per IP per process; these tests create several
    yield
    ratelimit._BUCKETS.clear()


def _buy_real(client) -> tuple[dict, dict]:
    item = client.post("/api/marketplace/listings", json=_listing()).json()["item"]
    wallet.credit(wallet.account_hash(BUYER), 10, demo=False, ref="cs_seed")
    body = client.post("/api/wallet/purchase", json={"account_secret": BUYER, "item_id": item["id"]}).json()
    assert body["demo"] is False and body["wallet"]["balance_usd"] == 5.5
    return item, body


def test_wallet_purchase_refund_makes_buyer_whole_claws_back_seller_and_revokes_token():
    client = TestClient(app)
    item, body = _buy_real(client)
    order_id, token = body["order_id"], body["token"]
    seller_h = wallet.account_hash(SELLER)
    assert wallet.view(seller_h)["balance_usd"] == 4.05
    # payload unlocks before the refund
    assert client.get(f"/api/marketplace/listings/{item['id']}/payload", params={"token": token}).status_code == 200

    # stranger cannot open; the paying account can; second attempt is rejected
    r = client.post("/api/wallet/disputes", json={"account_secret": "z" * 32, "order_id": order_id, "reason": "not mine"})
    assert r.status_code == 400 and "own" in r.json()["detail"]
    r = client.post("/api/wallet/disputes", json={"account_secret": BUYER, "order_id": order_id, "reason": "strategy does not load"})
    assert r.status_code == 200, r.text
    dp = r.json()
    assert dp["status"] == "open" and dp["provider"] == "wallet" and dp["amount"] == "4.50" and dp["id"] == f"dp_{order_id}"
    assert client.post("/api/wallet/disputes", json={"account_secret": BUYER, "order_id": order_id, "reason": "again"}).status_code == 400
    mine = client.post("/api/wallet/disputes/mine", json={"account_secret": BUYER}).json()
    assert [d["order_id"] for d in mine["disputes"]] == [order_id] and mine["refund_window_days"] == 14

    # admin sees it, refunds it
    lst = client.get("/api/admin/disputes", headers=ADMIN).json()
    assert lst["disputes"][0]["status"] == "open"
    assert client.get("/api/admin/overview", headers=ADMIN).json()["counts"]["disputes_open"] == 1
    res = client.post(f"/api/admin/disputes/{order_id}", headers=ADMIN, json={"action": "refund", "note": "verified broken"})
    assert res.status_code == 200, res.text
    row = res.json()
    assert row["status"] == "refunded" and row["refund"]["mode"] == "wallet" and row["refund"]["amount"] == 4.5
    assert row["refund"]["clawback"] == {"status": "done", "amount": 4.05}
    # money moved back, token dead, order marked
    assert wallet.view(wallet.account_hash(BUYER))["balance_usd"] == 10.0
    assert wallet.view(seller_h)["balance_usd"] == 0.0
    assert listings.verify_entitlement(token, item["id"]) is None
    assert listings.verify_entitlement(token, item["id"], check_revoked=False)["order"] == order_id
    assert client.get(f"/api/marketplace/listings/{item['id']}/payload", params={"token": token}).status_code == 402
    assert kvstore.get(f"order:{order_id}")["status"] == "refunded"
    # idempotent: resolving again does nothing more
    again = client.post(f"/api/admin/disputes/{order_id}", headers=ADMIN, json={"action": "refund"}).json()
    assert again["resolved_at"] == row["resolved_at"]
    assert wallet.view(wallet.account_hash(BUYER))["balance_usd"] == 10.0
    # ledger kinds are explicit
    kinds = {e["kind"] for e in wallet.view(wallet.account_hash(BUYER))["entries"]}
    assert "refund" in kinds
    assert "clawback" in {e["kind"] for e in wallet.view(seller_h)["entries"]}


def test_reject_keeps_entitlement_and_money():
    client = TestClient(app)
    item, body = _buy_real(client)
    order_id = body["order_id"]
    disputes.open_dispute(order_id, reason="changed my mind", account_hash=wallet.account_hash(BUYER))
    row = client.post(f"/api/admin/disputes/{order_id}", headers=ADMIN, json={"action": "reject", "note": "outside policy"}).json()
    assert row["status"] == "rejected" and row["note"] == "outside policy"
    assert listings.verify_entitlement(body["token"], item["id"]) is not None
    assert wallet.view(wallet.account_hash(BUYER))["balance_usd"] == 5.5
    assert wallet.view(wallet.account_hash(SELLER))["balance_usd"] == 4.05


def test_token_holder_can_dispute_anonymous_checkout_and_clawback_failure_is_reported():
    client = TestClient(app)
    item = client.post("/api/marketplace/listings", json=_listing()).json()["item"]
    # a demo checkout has no account on the order; the entitlement token is the proof
    conf = payments.confirm_demo("demo_dp1", item["id"])
    r = client.post("/api/wallet/disputes", json={"order_id": "demo_dp1", "reason": "does not run"})
    assert r.status_code == 400 and "own" in r.json()["detail"]
    r = client.post("/api/wallet/disputes", json={"order_id": "demo_dp1", "reason": "does not run", "token": conf["token"]})
    assert r.status_code == 200, r.text
    look = client.post("/api/wallet/disputes/lookup", json={"order_id": "demo_dp1", "token": conf["token"]}).json()
    assert look["dispute"]["status"] == "open"
    assert client.post("/api/wallet/disputes/lookup", json={"order_id": "demo_dp1"}).status_code == 403
    row = disputes.resolve("demo_dp1", "refund")
    assert row["refund"]["mode"] == "none" and row["refund"]["clawback"]["status"] == "skipped"
    assert listings.verify_entitlement(conf["token"], item["id"]) is None

    # real sale whose seller already withdrew: clawback fails loudly, buyer still refunded
    _, body = _buy_real(client)
    seller_h = wallet.account_hash(SELLER)
    wallet.request_withdrawal(seller_h, 4.0, "crypto", "0x" + "c" * 40)
    disputes.open_dispute(body["order_id"], reason="broken", account_hash=wallet.account_hash(BUYER))
    row = disputes.resolve(body["order_id"], "refund")
    assert row["refund"]["clawback"]["status"] == "failed" and "insufficient" in row["refund"]["clawback"]["note"]
    assert wallet.view(wallet.account_hash(BUYER))["balance_usd"] == 10.0


def test_dispute_guards_window_topups_and_unknown_orders(monkeypatch):
    client = TestClient(app)
    _, body = _buy_real(client)
    h = wallet.account_hash(BUYER)
    with pytest.raises(disputes.DisputeError, match="not found"):
        disputes.open_dispute("nope", reason="xxxx", account_hash=h)
    with pytest.raises(disputes.DisputeError, match="reason"):
        disputes.open_dispute(body["order_id"], reason="x", account_hash=h)
    # top-ups are not disputable
    t = client.post("/api/wallet/topup", json={"account_secret": BUYER, "amount_usd": 5, "method": "card"}).json()
    client.post(f"/api/wallet/topup/demo/{t['order_id']}/confirm", json={"account_secret": BUYER, "amount_usd": 5})
    with pytest.raises(disputes.DisputeError, match="top-ups"):
        disputes.open_dispute(t["order_id"], reason="want it back", account_hash=h)
    # window
    order = kvstore.get(f"order:{body['order_id']}")
    order["at"] = int(time.time()) - 15 * 86_400
    kvstore.put(f"order:{body['order_id']}", order)
    with pytest.raises(disputes.DisputeError, match="window"):
        disputes.open_dispute(body["order_id"], reason="too late", account_hash=h)
    monkeypatch.setattr(get_settings(), "refund_window_days", 30)
    assert disputes.open_dispute(body["order_id"], reason="in time now", account_hash=h)["status"] == "open"
    assert client.post("/api/admin/disputes/nope", headers=ADMIN, json={"action": "reject"}).status_code == 404
    assert client.get("/api/admin/disputes").status_code == 403


def test_audit_trail_records_money_and_admin_events():
    client = TestClient(app)
    item, body = _buy_real(client)
    disputes.open_dispute(body["order_id"], reason="broken", account_hash=wallet.account_hash(BUYER))
    client.post(f"/api/admin/disputes/{body['order_id']}", headers=ADMIN, json={"action": "refund", "note": "ok"})
    wd = wallet.request_withdrawal(wallet.account_hash(BUYER), 2, "crypto", "0x" + "d" * 40)
    client.post(f"/api/admin/withdrawals/{wd['id']}", headers=ADMIN, json={"status": "paid", "note": "tx 0xabc"})
    client.post(f"/api/marketplace/listings/{item['id']}/remove", json={"seller_secret": SELLER})

    log = client.get("/api/admin/audit", headers=ADMIN).json()
    actions = [e["action"] for e in log["entries"]]
    for expected in ("listing.created", "order.confirmed", "dispute.opened", "dispute.refunded", "order.refunded",
                     "withdrawal.requested", "withdrawal.paid", "listing.removed"):
        assert expected in actions, (expected, actions)
    # newest first, actors coarse, no secrets
    assert actions[0] == "listing.removed"
    assert all(len(e["actor"]) <= 64 and BUYER not in str(e) and SELLER not in str(e) for e in log["entries"])
    confirmed = next(e for e in log["entries"] if e["action"] == "order.confirmed")
    assert confirmed["actor"].startswith("account:") and confirmed["detail"]["amount"] == "4.50"
    # filters
    only = client.get("/api/admin/audit", headers=ADMIN, params={"action": "withdrawal."}).json()["entries"]
    assert {e["action"] for e in only} == {"withdrawal.requested", "withdrawal.paid"}
    by_target = client.get("/api/admin/audit", headers=ADMIN, params={"target": body["order_id"]}).json()["entries"]
    assert {e["action"] for e in by_target} == {"order.confirmed", "dispute.opened", "dispute.refunded", "order.refunded"}


def test_audit_prune_keeps_newest():
    for i in range(30):
        audit.record("t.tick", target=str(i))
    assert audit.prune(cap=10) == 20
    left = audit.recent(100, action_prefix="t.")
    assert len(left) == 10 and left[0]["target"] == "29" and left[-1]["target"] == "20"
    # detail is sanitised: long strings clipped, None dropped
    e = audit.record("t.detail", detail={"a": None, "b": "x" * 500, "n": 3})
    assert "a" not in e["detail"] and len(e["detail"]["b"]) == 160 and e["detail"]["n"] == 3
