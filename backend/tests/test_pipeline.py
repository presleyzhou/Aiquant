"""End-to-end pipeline: portfolio construction math, the simulation's
honesty invariants (no look-ahead, costs bite, drift between rebalances,
vol targeting never levers up) and the API/paper-trading contract. Offline
and deterministic — the panel is synthetic."""

from __future__ import annotations

import json

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import factor_dsl, pipeline, portfolio
from tests.test_factors import _panel

client = TestClient(app)

SPEC = {
    "market": "us",
    "factors": [{"expression": "rank(delta(close, 5))"}, {"expression": "neg(ts_std(returns, 20))"}],
    "scheme": "inverse_vol",
    "top_n": 6,
    "compare": False,
}


# ---------------------------------------------------------- construction


def test_apply_cap_water_fills_to_one():
    w = portfolio.apply_cap(np.array([10.0, 1.0, 1.0, 1.0]), cap=0.4)
    assert w.max() <= 0.4 + 1e-9
    assert abs(w.sum() - 1) < 1e-9
    # the excess flowed to the others proportionally (they were equal → stay equal)
    assert np.allclose(w[1:], w[1])


def test_apply_cap_infeasible_leaves_cash():
    w = portfolio.apply_cap(np.ones(3), cap=0.2)
    assert np.allclose(w, 0.2)
    assert w.sum() < 1  # 40% cash — the cap is never silently violated


def test_projection_respects_simplex_and_cap():
    w = portfolio.project_capped_simplex(np.array([5.0, -3.0, 0.2, 0.1]), cap=0.5)
    assert abs(w.sum() - 1) < 1e-6
    assert (w >= -1e-12).all() and (w <= 0.5 + 1e-9).all()


def _cov():
    rng = np.random.default_rng(3)
    vols = np.array([0.01, 0.02, 0.03, 0.04])
    corr = np.full((4, 4), 0.3) + np.eye(4) * 0.7
    cov = np.outer(vols, vols) * corr
    return cov, rng


def test_min_variance_beats_equal_weight_variance():
    cov, _ = _cov()
    w = portfolio.min_variance_weights(cov, cap=1.0)
    eq = np.full(4, 0.25)
    assert abs(w.sum() - 1) < 1e-6
    assert w @ cov @ w < eq @ cov @ eq
    assert np.argmax(w) == 0  # the lowest-vol name dominates


def test_risk_parity_equalises_risk_contributions():
    cov, _ = _cov()
    w = portfolio.risk_parity_weights(cov, cap=1.0)
    rc = w * (cov @ w)
    rc = rc / rc.sum()
    assert np.allclose(rc, 0.25, atol=0.01)


def test_inverse_vol_orders_by_volatility():
    rng = np.random.default_rng(1)
    r = np.column_stack([rng.normal(0, s, 200) for s in (0.01, 0.02, 0.04)])
    w = portfolio.inverse_vol_weights(r, cap=1.0)
    assert w[0] > w[1] > w[2]


def test_score_weights_are_rank_linear():
    w = portfolio.score_weights(np.array([0.1, 0.9, 0.5]), cap=1.0)
    assert np.allclose(w, np.array([1, 3, 2]) / 6)


def test_vol_scale_never_levers_up():
    rng = np.random.default_rng(0)
    quiet = rng.normal(0, 0.001, (60, 3))
    assert portfolio.vol_scale(np.ones(3) / 3, quiet, 0.15, 252) == 1.0
    wild = rng.normal(0, 0.05, (60, 3))
    assert 0 < portfolio.vol_scale(np.ones(3) / 3, wild, 0.15, 252) < 1


def test_drawdown_episodes_find_peak_trough_recovery():
    idx = pd.date_range("2024-01-01", periods=8, freq="D")
    eq = pd.Series([100, 110, 99, 90, 95, 112, 105, 108], index=idx, dtype=float)
    eps = portfolio.drawdown_episodes(eq)
    assert eps[0]["peak"] == "2024-01-02" and eps[0]["trough"] == "2024-01-04"
    assert eps[0]["recovery"] == "2024-01-06"
    assert eps[0]["depth_pct"] == pytest.approx(-18.18, abs=0.01)
    assert eps[1]["recovery"] is None  # still under water at the end


# ------------------------------------------------------------- simulation


def test_pipeline_runs_and_is_json_clean():
    panel = _panel(500, 20)
    res = pipeline.run_pipeline_blocking({**SPEC, "compare": True}, panel=panel)
    json.dumps(res)  # numpy scalars must not leak
    for key in ("spec", "universe", "signal", "portfolio", "backtest", "risk", "alternatives", "target_weights", "warnings"):
        assert key in res
    assert {a["scheme"] for a in res["alternatives"]} == set(portfolio.SCHEMES)
    assert len(res["signal"]["components"]) == 2
    assert res["backtest"]["equity_curve"][0]["value"] == pytest.approx(100_000, rel=0.05)
    assert len(res["target_weights"]["weights"]) == 6
    assert sum(w["weight_pct"] for w in res["target_weights"]["weights"]) == pytest.approx(100, abs=0.5)
    assert res["backtest"]["holdout"]["from"] > res["backtest"]["in_sample"]["to"]


def test_no_look_ahead_contemporaneous_signal_has_no_edge():
    """A score equal to TODAY's return must not earn today's return. With a
    correct one-bar lag it is just noise; an oracle (tomorrow's return) is
    the positive control that the lag is exactly one bar."""
    panel = _panel(500, 20, seed=11)
    ret = panel["close"].pct_change()
    spec = pipeline.normalize_spec({**SPEC, "factors": ["rank(close)"], "scheme": "equal", "rebalance": 1, "cost_bps": 0})
    same_day = pipeline.simulate(ret, panel, spec)
    oracle = pipeline.simulate(ret.shift(-1), panel, spec)
    assert oracle["net"].mean() > 10 * abs(same_day["net"].mean())
    assert abs(same_day["net"].mean()) < 0.003


def test_costs_reduce_returns_and_turnover_only_on_rebalance_days():
    panel = _panel(500, 20)
    scores, _, _ = pipeline.build_signal(pipeline.normalize_spec(SPEC), panel)
    free = pipeline.simulate(scores, panel, pipeline.normalize_spec({**SPEC, "cost_bps": 0}))
    paid = pipeline.simulate(scores, panel, pipeline.normalize_spec({**SPEC, "cost_bps": 50}))
    assert (1 + free["net"]).prod() > (1 + paid["net"]).prod()
    # weights drift between rebalances: trades happen only right after a decision
    assert int((paid["turnover"] > 0).sum()) == paid["rebalances"]


def test_vol_targeting_holds_cash_and_lowers_vol():
    panel = _panel(500, 20)
    full = pipeline.run_pipeline_blocking(SPEC, panel=panel)
    capped = pipeline.run_pipeline_blocking({**SPEC, "target_vol_pct": 5}, panel=panel)
    assert capped["portfolio"]["avg_exposure_pct"] < full["portfolio"]["avg_exposure_pct"]
    assert capped["backtest"]["stats"]["ann_vol_pct"] < full["backtest"]["stats"]["ann_vol_pct"]
    assert max(p["value"] for p in capped["backtest"]["exposure_curve"]) <= 100.0 + 1e-6


def test_max_weight_cap_is_honoured_in_targets():
    panel = _panel(500, 20)
    res = pipeline.run_pipeline_blocking({**SPEC, "scheme": "score", "max_weight": 0.2}, panel=panel)
    assert max(w["weight_pct"] for w in res["target_weights"]["weights"]) <= 20 + 0.01


def test_normalize_spec_clamps_and_validates():
    spec = pipeline.normalize_spec({"market": "nope", "factors": ["rank(close)"], "top_n": 99, "max_weight": 3, "target_vol_pct": 1})
    assert spec["market"] == "us" and spec["top_n"] == 20 and spec["max_weight"] == 1.0
    assert spec["target_vol_pct"] == 5
    with pytest.raises(factor_dsl.FactorError):
        pipeline.normalize_spec({"factors": []})
    with pytest.raises(factor_dsl.FactorError):
        pipeline.normalize_spec({"factors": ["__import__('os')"]})
    with pytest.raises(factor_dsl.FactorError):
        pipeline.normalize_spec({"factors": ["rank(close)"], "scheme": "kelly"})


# -------------------------------------------------------------------- API


def test_config_endpoint_lists_schemes_and_starters():
    body = client.get("/api/pipeline/config").json()
    assert [s["id"] for s in body["schemes"]] == list(portfolio.SCHEMES)
    assert body["starter_factors"]["us"] and body["starter_factors"]["crypto"]
    for f in body["starter_factors"]["us"] + body["starter_factors"]["crypto"]:
        factor_dsl.parse(f["expression"])  # starters must be valid DSL


def test_run_endpoint_contract(monkeypatch):
    panel = _panel(500, 20)
    monkeypatch.setattr(pipeline, "_load_panel_blocking", lambda market: panel)
    r = client.post("/api/pipeline/run", json={**SPEC, "compare": True})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["spec"]["scheme"] == "inverse_vol"
    assert body["backtest"]["stats"]["benchmark"]["sharpe"] is not None
    assert body["target_weights"]["as_of"]
    bad = client.post("/api/pipeline/run", json={**SPEC, "factors": [{"expression": "close ** 2"}]})
    assert bad.status_code == 400
    assert client.post("/api/pipeline/run", json={**SPEC, "scheme": "kelly"}).status_code == 422


def test_paper_tracks_pipeline_kind(monkeypatch):
    panel = _panel(500, 20)
    monkeypatch.setattr(pipeline, "_load_panel_blocking", lambda market: panel)
    started = str(panel["close"].index[-40].date())
    r = client.post("/api/paper/track", json={"kind": "pipeline", "started_at": started, "config": SPEC})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["kind"] == "pipeline"
    assert body["position"]["state"] == "holdings"
    assert len(body["position"]["symbols"]) == len(body["position"]["weights_pct"]) == 6
    assert body["equity_curve"][0]["value"] == 100_000
