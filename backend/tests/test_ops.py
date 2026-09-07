"""Operations layer: run-result cache, provider health counters, the merged
ops pass and admin token rotation."""

from __future__ import annotations

import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.services import kvstore, pipeline, portfolio, provider_health, run_cache
from app.services.pipeline import normalize_spec
from tests.test_factors import _panel
from tests.test_panel_cache import FakeKV
from tests.test_pipeline import SPEC

client = TestClient(app)


def _file_store(monkeypatch, tmp_path):
    monkeypatch.setattr(kvstore, "_file_path", lambda: tmp_path / "store.json")
    monkeypatch.setattr(kvstore, "mode", lambda: "file")


# ------------------------------------------------------------- run cache


def test_key_ignores_trial_count_but_not_config_or_date():
    a = normalize_spec(SPEC)
    b = normalize_spec({**SPEC, "prior_trials": 40})
    c = normalize_spec({**SPEC, "top_n": 7})
    assert run_cache.key_for(a, "2026-09-05") == run_cache.key_for(b, "2026-09-05")
    assert run_cache.key_for(a, "2026-09-05") != run_cache.key_for(c, "2026-09-05")
    assert run_cache.key_for(a, "2026-09-05") != run_cache.key_for(a, "2026-09-06")
    assert run_cache.key_for(a, "2026-09-05").startswith(f"runcache:{run_cache.CODE_VERSION}:2026-09-05:")


def test_put_get_round_trip_through_kv_and_memory(monkeypatch):
    fake = FakeKV()
    monkeypatch.setattr(run_cache.kvstore, "_kv", fake)
    monkeypatch.setattr(run_cache.kvstore, "mode", lambda: "kv")
    run_cache._MEM.clear()
    run_cache.put("runcache:t:1", {"x": [1.0, float("nan")], "spec": {}})
    assert "runcache:t:1" in fake.store          # shared across instances
    got = run_cache.get("runcache:t:1")
    assert got == {"x": [1.0, None], "spec": {}}  # NaN sanitised, a copy
    got["x"].append(9)
    assert run_cache.get("runcache:t:1")["x"] == [1.0, None]
    run_cache._MEM.clear()                        # cold instance: served from KV
    assert run_cache.get("runcache:t:1")["x"] == [1.0, None]
    assert run_cache.get("runcache:t:missing") is None


def test_run_endpoint_serves_second_call_from_cache_and_redeflates(monkeypatch):
    panel = _panel(500, 20)
    monkeypatch.setattr(pipeline, "_load_panel_blocking", lambda market: panel)
    run_cache._MEM.clear()
    calls = {"n": 0}
    real = pipeline.run_pipeline_blocking

    def counting(spec, panel=None):
        calls["n"] += 1
        return real(spec, panel=panel)

    monkeypatch.setattr("app.api.pipeline.run_pipeline_blocking", counting)
    first = client.post("/api/pipeline/run", json={**SPEC, "compare": True}).json()
    second = client.post("/api/pipeline/run", json={**SPEC, "compare": True, "prior_trials": 500}).json()
    assert calls["n"] == 1
    assert first["cached"] is False and second["cached"] is True
    assert second["spec"]["prior_trials"] == 500
    o1, o2 = first["backtest"]["overfitting"], second["backtest"]["overfitting"]
    assert o2["trials"] == o1["trials"] + 500
    if o1["dsr"] is not None and o2["dsr"] is not None:
        assert o2["dsr"] <= o1["dsr"] + 1e-9   # more trials never make the DSR better
    # everything the requester did not change is byte-identical
    assert second["backtest"]["stats"] == first["backtest"]["stats"]
    assert second["target_weights"] == first["target_weights"]


def test_moment_based_psr_matches_direct_computation():
    import numpy as np
    import pandas as pd

    r = pd.Series(np.random.default_rng(1).normal(0.0005, 0.01, 400))
    m = portfolio.sharpe_moments(r)
    assert m is not None and set(m) == {"sr", "t", "skew", "kurt"}
    assert portfolio.psr_from_moments(m) == pytest.approx(portfolio.probabilistic_sharpe(r))
    d0 = portfolio.deflated_sharpe_from(m, [0.02, 0.03], extra_trials=0)
    d9 = portfolio.deflated_sharpe_from(m, [0.02, 0.03], extra_trials=9)
    assert d9["trials"] == d0["trials"] + 9
    assert d9["expected_max_sharpe"] >= d0["expected_max_sharpe"]
    assert d9["dsr"] <= d0["dsr"]


# ------------------------------------------------------- provider health


def test_provider_health_counts_fallbacks_and_aggregates(monkeypatch, tmp_path):
    _file_store(monkeypatch, tmp_path)
    provider_health.record("crypto", "binance", ["binance", "coingecko"], 4.0)
    provider_health.record("crypto", "binance", ["yahoo"], 12.0)
    provider_health.record("us", "yahoo", ["yahoo"], 3.0)          # yahoo expected → not a fallback
    provider_health.record("us", "akshare", ["yahoo"], 5.0)        # akshare expected → fallback
    s = provider_health.summary(7)
    c, u = s["markets"]["crypto"], s["markets"]["us"]
    assert c["calls"] == 2 and c["fallbacks"] == 1 and c["fallback_rate_pct"] == 50.0
    assert c["served"] == {"binance": 1, "yahoo": 1} and c["avg_seconds"] == 8.0
    assert u["calls"] == 2 and u["fallbacks"] == 1
    assert provider_health.summary(0)["markets"] == {}


def test_effective_us_provider_resolves_auto():
    from app.services import panel_providers

    monkeyless = panel_providers.effective_us_provider
    assert monkeyless("yahoo") == "yahoo"
    assert monkeyless("akshare") == "akshare"
    assert monkeyless("auto") in ("akshare", "yahoo")
    assert monkeyless("auto") == ("akshare" if panel_providers.akshare_available() else "yahoo")


def test_download_panel_records_health(monkeypatch, tmp_path):
    from app.services import panel_providers

    _file_store(monkeypatch, tmp_path)
    panel = _panel(300, 10)
    frames = {c: panel["close"][[c]].rename(columns={c: "Close"}).assign(
        Open=panel["open"][c], High=panel["high"][c], Low=panel["low"][c], Volume=panel["volume"][c]
    ) for c in panel["close"].columns}
    monkeypatch.setattr(panel_providers, "_equity_frames", lambda syms, period, prov, mn: (frames, ["yahoo"]))
    monkeypatch.setattr(panel_providers, "clean_panel", lambda p, label, mn: p)
    out = panel_providers.download_panel(list(frames), "3y", "us", market="us")
    assert panel_providers.provider_of(out) == "yahoo"
    assert provider_health.summary(1)["markets"]["us"]["calls"] == 1


# ------------------------------------------------------------- ops pass


def _admin(monkeypatch, token="tok-a", nxt=None):
    s = get_settings()
    monkeypatch.setattr(s, "admin_token", token)
    monkeypatch.setattr(s, "admin_token_next", nxt)
    return {"x-admin-token": token}


def test_ops_runs_steps_isolated_and_stores_report(monkeypatch, tmp_path):
    from app.api import admin as admin_api
    from app.services import monitor

    _file_store(monkeypatch, tmp_path)
    hdr = _admin(monkeypatch)

    async def fake_warm(markets="us,crypto"):
        return {"warmed": {"us": {"symbols": 100, "provider": "yahoo", "seconds": 1.0}}, "kv": "file"}

    def boom(n):
        raise RuntimeError("recheck exploded")

    async def fake_run_all(force=False, limit=10):
        return {"processed": 2, "skipped": 0, "remaining": 3, "alerts": 1, "notified": 0}

    monkeypatch.setattr(admin_api, "warm", fake_warm)
    monkeypatch.setattr(admin_api, "_recheck_blocking", boom)
    monkeypatch.setattr(monitor, "run_all", fake_run_all)
    r = client.post("/api/admin/ops?monitor_limit=5", headers=hdr)
    assert r.status_code == 200, r.text
    rep = r.json()
    assert [s["step"] for s in rep["steps"]] == ["warm", "recheck", "monitor"]
    assert rep["steps"][0]["ok"] and rep["steps"][0]["result"]["us"]["symbols"] == 100
    assert rep["steps"][1]["ok"] is False and "recheck exploded" in rep["steps"][1]["error"]
    assert rep["steps"][2]["ok"] and rep["monitor_remaining"] == 3
    assert rep["ok"] is False
    assert kvstore.get("ops:last")["monitor_remaining"] == 3
    assert len(kvstore.get("ops:history")["runs"]) == 1
    over = client.get("/api/admin/overview", headers=hdr).json()
    assert over["ops_last"]["monitor_remaining"] == 3
    assert "provider_health" in over and over["provider_health"]["days"] == 7


def test_admin_token_rotation_accepts_both_values(monkeypatch, tmp_path):
    _file_store(monkeypatch, tmp_path)
    _admin(monkeypatch, "old-token", "new-token")
    assert client.get("/api/admin/overview", headers={"x-admin-token": "old-token"}).status_code == 200
    assert client.get("/api/admin/overview", headers={"x-admin-token": "new-token"}).status_code == 200
    assert client.get("/api/admin/overview", headers={"x-admin-token": "wrong"}).status_code == 403
    assert client.get("/api/admin/overview").status_code == 403
    _admin(monkeypatch, None, None)
    assert client.get("/api/admin/overview", headers={"x-admin-token": ""}).status_code == 403
