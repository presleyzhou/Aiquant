"""Deployment monitor: rules, change detection, webhook hygiene, batch run."""

from __future__ import annotations

import asyncio
import os

import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import kvstore, monitor

client = TestClient(app)


def _track(dd=-2.0, decay="holding", symbols=("AAPL", "MSFT"), as_of=None):
    from datetime import date

    return {
        "as_of": as_of or date.today().isoformat(), "days_live": 30,
        "stats": {"return_pct": 3.0, "excess_pct": 1.0, "current_drawdown_pct": dd, "sharpe": 1.1},
        "decay": {"verdict": decay, "sharpe_delta": -0.7, "excess_delta": -3.0},
        "position": {"state": "holdings", "symbols": list(symbols), "since": "2026-09-01"},
    }


DEP = {"id": "pp_1", "kind": "factor", "name": "反转", "startedAt": "2026-08-01", "config": {"expression": "rank(close)"}}


def test_rules_fire_on_drawdown_decay_rebalance_and_stale():
    quiet = monitor.evaluate(DEP, _track(), None, None, 10.0)
    assert quiet["alerts"] == [] and quiet["position"]["symbols"] == ["AAPL", "MSFT"]
    loud = monitor.evaluate(DEP, _track(dd=-12.5, decay="degraded", as_of="2026-01-01"), quiet, None, 10.0)
    codes = [a["code"] for a in loud["alerts"]]
    assert codes == ["drawdown", "decay", "stale"]
    moved = monitor.evaluate(DEP, _track(symbols=("AAPL", "NVDA")), quiet, None, 10.0)
    assert [a["code"] for a in moved["alerts"]] == ["rebalance"]
    assert "+NVDA" in moved["alerts"][0]["detail"] and "-MSFT" in moved["alerts"][0]["detail"]
    broken = monitor.evaluate(DEP, None, None, "no bars since the deployment date yet", 10.0)
    assert broken["alerts"][0]["code"] == "error"


def test_new_alerts_only_reports_changes():
    prev = {"items": [{"id": "pp_1", "alerts": [{"code": "drawdown"}]}]}
    cur = {"items": [{"id": "pp_1", "name": "x", "alerts": [{"code": "drawdown"}, {"code": "decay"}]}]}
    fresh = monitor.new_alerts(cur, prev)
    assert [a["code"] for a in fresh] == ["decay"]
    assert len(monitor.new_alerts(cur, None)) == 2


@pytest.mark.parametrize("url,ok", [
    ("https://hooks.slack.com/services/T/B/x", True),
    ("https://api.telegram.org/bot123:abc/sendMessage?chat_id=1", True),
    ("http://hooks.slack.com/x", False),
    ("https://localhost/x", False),
    ("https://127.0.0.1/x", False),
    ("https://10.0.0.5/x", False),
    ("https://169.254.169.254/latest", False),
    ("https://metadata.google.internal/x", False),
    ("not a url", False),
])
def test_webhook_hygiene(url, ok):
    assert monitor.webhook_ok(url) is ok


def test_run_all_stores_reports_and_notifies_on_new_alerts(monkeypatch, tmp_path):
    monkeypatch.setenv("AIQUANT_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(kvstore, "_file_path", lambda: tmp_path / "store.json")
    monkeypatch.setattr(kvstore, "mode", lambda: "file")
    kvstore.put("state:acct1", {"data": {"aiquant.paper": [DEP], "aiquant.notify": {"webhook_url": "https://hooks.example.com/x"}}})
    kvstore.put("state:acct2", {"data": {"aiquant.paper": []}})
    posted = []
    monkeypatch.setattr(monitor, "post_webhook", lambda url, text: posted.append((url, text)) or True)

    async def fake_track(kind, started, config):
        return _track(dd=-15.0)

    import app.api.paper as paper_api
    monkeypatch.setattr(paper_api, "compute_track", fake_track)
    out = asyncio.run(monitor.run_all())
    assert out["processed"] == 1 and out["alerts"] == 1 and out["notified"] == 1 and out["remaining"] == 0
    report = kvstore.get("monitor:acct1")
    assert report["items"][0]["alerts"][0]["code"] == "drawdown" and report["new_alerts"] == 1
    assert posted and "回撤" in posted[0][1] and "/?view=paper" in posted[0][1]
    # second pass within 20h is skipped; forced pass re-evaluates but finds nothing new → no webhook
    again = asyncio.run(monitor.run_all())
    assert again["skipped"] == 1 and again["processed"] == 0
    forced = asyncio.run(monitor.run_all(force=True))
    assert forced["processed"] == 1 and len(posted) == 1


def test_monitor_endpoints_require_credentials(monkeypatch):
    assert client.get("/api/paper/monitor").status_code == 401
    assert client.post("/api/paper/monitor/run").status_code == 403
    from app.config import get_settings
    monkeypatch.setattr(get_settings(), "admin_token", "s3cret")
    monkeypatch.setattr(kvstore, "list_prefix_items", lambda ns: [])
    r = client.post("/api/paper/monitor/run", headers={"x-admin-token": "s3cret"})
    assert r.status_code == 200 and r.json()["processed"] == 0
