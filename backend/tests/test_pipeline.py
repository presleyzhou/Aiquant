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


# --------------------------------------------------- V2: construction schemes


def test_shrinkage_intensity_is_bounded_and_falls_with_more_data():
    rng = np.random.default_rng(2)
    corr_short = rng.normal(0, 0.01, (40, 10))
    corr_long = rng.normal(0, 0.01, (2000, 10))
    lam_short = portfolio.shrinkage_intensity(corr_short)
    lam_long = portfolio.shrinkage_intensity(corr_long)
    assert 0 <= lam_long <= lam_short <= 1


def test_hrp_weights_sum_to_one_and_favour_diversifiers():
    cov, _ = _cov()
    w = portfolio.hrp_weights(cov, cap=1.0)
    assert abs(w.sum() - 1) < 1e-9 and (w > 0).all()
    assert np.argmax(w) == 0  # lowest-vol name gets the most, as in inverse variance
    capped = portfolio.hrp_weights(cov, cap=0.3)
    assert capped.max() <= 0.3 + 1e-9


def test_single_linkage_groups_correlated_names():
    rng = np.random.default_rng(4)
    base = rng.normal(0, 0.01, 300)
    r = np.column_stack([base + rng.normal(0, 0.002, 300), rng.normal(0, 0.01, 300),
                         base + rng.normal(0, 0.002, 300), rng.normal(0, 0.01, 300)])
    corr = np.corrcoef(r, rowvar=False)
    order = portfolio._single_linkage_order(corr)
    assert sorted(order) == [0, 1, 2, 3]
    assert abs(order.index(0) - order.index(2)) == 1  # the twins sit next to each other


def test_grinold_alpha_and_mean_variance_tilt_toward_signal():
    cov, _ = _cov()
    scores = np.array([2.0, 1.0, -1.0, -2.0])
    alpha = portfolio.grinold_alpha(scores, np.sqrt(np.diag(cov)), ic=0.05)
    assert alpha[0] > 0 and alpha[1] > 0 > alpha[2] > alpha[3]  # sign follows the z-score, size the vol
    w = portfolio.mean_variance_weights(alpha, cov, cap=0.6)
    assert abs(w.sum() - 1) < 1e-6
    assert w[0] + w[1] > w[2] + w[3]  # positive-alpha names dominate
    assert w.max() <= 0.6 + 1e-9


# ------------------------------------------------- V2: overfitting statistics


def test_psr_is_high_for_a_strong_track_record_and_low_for_noise():
    rng = np.random.default_rng(0)
    strong = pd.Series(0.002 + rng.normal(0, 0.005, 400))
    noise = pd.Series(rng.normal(0, 0.01, 400))
    assert portfolio.probabilistic_sharpe(strong) > 0.99
    assert 0.05 < portfolio.probabilistic_sharpe(noise) < 0.95
    assert portfolio.probabilistic_sharpe(pd.Series([0.01] * 10)) is None  # too short


def test_deflated_sharpe_is_never_above_psr():
    rng = np.random.default_rng(1)
    r = pd.Series(0.0005 + rng.normal(0, 0.01, 500))
    psr = portfolio.probabilistic_sharpe(r)
    d = portfolio.deflated_sharpe(r, [0.01, 0.03, -0.02, 0.05, 0.02, 0.04])
    assert d["trials"] == 6 and d["expected_max_sharpe"] > 0
    assert d["dsr"] <= psr


def test_norm_ppf_matches_known_quantiles():
    assert portfolio.norm_ppf(0.975) == pytest.approx(1.959964, abs=1e-6)
    assert portfolio.norm_ppf(0.5) == pytest.approx(0.0, abs=1e-9)
    assert portfolio.norm_cdf(portfolio.norm_ppf(0.123)) == pytest.approx(0.123, abs=1e-7)


def test_capture_and_cvar():
    idx = pd.date_range("2023-01-01", periods=600, freq="D")
    rng = np.random.default_rng(3)
    bench = pd.Series(rng.normal(0.0004, 0.01, 600), index=idx)
    port = bench * 1.5  # levered clone: captures 150% up AND down
    cap = portfolio.capture_ratios(port, bench)
    assert cap["up"] > 1.2 and cap["down"] > 1.2
    assert portfolio.cvar(bench) < 0
    assert portfolio.cvar(port) < portfolio.cvar(bench)


# ------------------------------------------------- V2: simulation behaviour


def test_hold_buffer_and_trade_rate_reduce_turnover():
    panel = _panel(600, 30, seed=5)
    base = {**SPEC, "factors": ["rank(delta(close, 5))"], "scheme": "equal"}
    plain = pipeline.run_pipeline_blocking({**base, "hold_buffer": 0}, panel=panel)
    banded = pipeline.run_pipeline_blocking({**base, "hold_buffer": 8}, panel=panel)
    partial = pipeline.run_pipeline_blocking({**base, "hold_buffer": 0, "trade_rate": 0.5}, panel=panel)
    assert banded["portfolio"]["avg_turnover_pct"] < plain["portfolio"]["avg_turnover_pct"]
    assert partial["portfolio"]["avg_turnover_pct"] < plain["portfolio"]["avg_turnover_pct"]
    assert plain["portfolio"]["breakeven_cost_bps"] is not None


def test_select_keeps_held_names_within_band():
    scores = pd.Series({"A": 9, "B": 8, "C": 7, "D": 6, "E": 5, "F": 4})
    picked = pipeline._select(scores, top_n=2, buffer=2, held={"D", "F"})
    assert list(picked.index) == ["D", "A"]  # D (rank 4 ≤ 2+2) survives, F (rank 6) is dropped
    assert list(pipeline._select(scores, top_n=2, buffer=0, held={"D"}).index) == ["A", "B"]


def test_expanding_ic_weights_use_only_the_past():
    """Truncating the panel must not change the composite score on the shared
    prefix (minus the last horizon of days whose IC needs future returns)."""
    panel = _panel(600, 20, seed=9)
    spec = pipeline.normalize_spec({**SPEC, "signal_weighting": "ic_expanding"})
    full, _, _ = pipeline.build_signal(spec, panel)
    cut = {k: v.iloc[:450] for k, v in panel.items()}
    part, _, _ = pipeline.build_signal(spec, cut)
    overlap = part.index[:-40]
    pd.testing.assert_frame_equal(full.loc[overlap], part.loc[overlap], check_exact=False, atol=1e-9)


def test_v2_report_fields_and_all_schemes():
    panel = _panel(600, 30, seed=5)
    res = pipeline.run_pipeline_blocking({**SPEC, "scheme": "hrp", "compare": True}, panel=panel)
    json.dumps(res)
    assert {a["scheme"] for a in res["alternatives"]} == set(portfolio.SCHEMES)
    assert len(res["signal"]["ic_by_horizon"]) == len(pipeline.IC_HORIZONS)
    over = res["backtest"]["overfitting"]
    assert 0 <= over["psr"] <= 1 and over["trials"] >= len(portfolio.SCHEMES)
    assert over["dsr"] <= over["psr"] + 1e-9
    assert set(res["risk"]["capture"]) == {"up", "down", "up_periods", "down_periods"}
    assert res["risk"]["rolling_beta"] and res["risk"]["cvar_95_pct"] is not None
    for c in res["signal"]["components"]:
        assert "avg_weight" in c
    mv = pipeline.run_pipeline_blocking({**SPEC, "scheme": "mean_variance"}, panel=panel)
    assert sum(w["weight_pct"] for w in mv["target_weights"]["weights"]) == pytest.approx(100, abs=0.5)


# ------------------------------------------------- V3: honesty & attribution


def test_min_track_record_and_tstat():
    rng = np.random.default_rng(0)
    strong = pd.Series(0.002 + rng.normal(0, 0.005, 400))
    assert portfolio.min_track_record_length(strong) < 400  # already long enough
    assert portfolio.sharpe_tstat(strong) > 3
    losing = pd.Series(-0.001 + rng.normal(0, 0.01, 400))
    assert portfolio.min_track_record_length(losing) is None  # no length rescues a negative Sharpe


def test_regime_table_covers_vol_terciles_and_trend():
    idx = pd.date_range("2023-01-01", periods=600, freq="D")
    rng = np.random.default_rng(1)
    bench = pd.Series(rng.normal(0.0003, 0.01, 600), index=idx)
    port = bench * 0.8 + rng.normal(0.0002, 0.004, 600)
    rows = portfolio.regime_table(port, bench, 252)
    assert {r["regime"] for r in rows} == {"low_vol", "mid_vol", "high_vol", "uptrend", "downtrend"}
    assert sum(r["days"] for r in rows if r["regime"].endswith("_vol")) == 600 - 59  # after the 60-day warmup


def test_quantile_returns_are_monotone_for_an_oracle_signal():
    panel = _panel(500, 20, seed=3)
    ret = panel["close"].pct_change()
    q = portfolio.quantile_returns(ret.shift(-1), ret, 252)  # tomorrow's return as today's score
    assert q["monotonic"] is True and q["spread_ann_pct"] > 50
    noise = portfolio.quantile_returns(pd.DataFrame(np.random.default_rng(0).normal(size=ret.shape), index=ret.index, columns=ret.columns), ret, 252)
    assert abs(noise["spread_ann_pct"]) < 40


def test_brinson_effects_sum_to_active_return():
    idx = pd.date_range("2024-01-01", periods=5, freq="D")
    syms = ["A", "B", "C", "D"]
    groups = {"A": "g1", "B": "g1", "C": "g2", "D": "g2"}
    rng = np.random.default_rng(5)
    returns = pd.DataFrame(rng.normal(0, 0.01, (5, 4)), index=idx, columns=syms)
    bench_w = pd.DataFrame(0.25, index=idx, columns=syms)
    held = pd.DataFrame([[0.5, 0.1, 0.3, 0.1]] * 5, index=idx, columns=syms)
    out = portfolio.brinson(held, bench_w, returns, groups)
    active = float(((held - bench_w) * returns).sum().sum()) * 100
    assert out["allocation_pct"] + out["selection_pct"] + out["interaction_pct"] == pytest.approx(active, abs=0.01)
    assert {g["group"] for g in out["groups"]} == {"g1", "g2"}


def test_every_universe_symbol_has_a_sector():
    for market, symbols in pipeline.UNIVERSES.items():
        assert all(s in pipeline.SECTORS for s in symbols), market


def test_v3_report_fields_prior_trials_and_shrink():
    panel = _panel(600, 30, seed=5)
    real = pipeline.UNIVERSES["us"][:30]
    panel = {k: v.set_axis(real, axis=1) for k, v in panel.items()}
    res = pipeline.run_pipeline_blocking({**SPEC, "scheme": "score", "prior_trials": 40, "shrink_to_equal": 0.5}, panel=panel)
    json.dumps(res)
    over = res["backtest"]["overfitting"]
    assert over["trials"] >= 40 + 1 and over["hlz_hurdle"] == 3.0 and "t_stat" in over
    assert res["signal"]["quantiles"]["buckets"] and len(res["signal"]["quantiles"]["buckets"]) == 5
    assert res["risk"]["attribution"]["groups"] and res["risk"]["regimes"]
    assert res["target_weights"]["groups"] and all("group" in w for w in res["target_weights"]["weights"])
    # shrinking a score-weighted book halfway to 1/N flattens the weights
    plain = pipeline.run_pipeline_blocking({**SPEC, "scheme": "score", "shrink_to_equal": 0.0}, panel=panel)
    spread = lambda r: max(w["weight_pct"] for w in r["target_weights"]["weights"]) - min(w["weight_pct"] for w in r["target_weights"]["weights"])  # noqa: E731
    assert spread(res) < spread(plain)
    assert client.post("/api/pipeline/run", json={**SPEC, "prior_trials": -1}).status_code == 422
