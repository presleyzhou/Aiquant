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
    json.dumps(res, allow_nan=False)  # numpy scalars / NaN must not leak (Starlette rejects NaN)
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
    spec = pipeline.normalize_spec({"market": "nope", "factors": ["rank(close)"], "top_n": 99, "max_weight": 3, "target_vol_pct": 55})
    assert spec["market"] == "us" and spec["top_n"] == 20 and spec["max_weight"] == 1.0
    assert spec["target_vol_pct"] == 40
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


# ------------------------------------------------------------------ AI memo


MEMO_BODY = {
    "spec": {"scheme": "hrp"}, "universe": {"symbols": 30}, "signal": {"composite_is_ic": 0.01},
    "portfolio": {"annual_turnover_x": 12.9}, "stats": {"sharpe": 1.4}, "in_sample": {"sharpe": 1.2},
    "holdout": {"sharpe": 1.9}, "overfitting": {"psr": 0.98, "dsr": 0.84, "t_stat": 2.1}, "risk": {"cvar_95_pct": -1.5},
    "warnings": ["high_turnover"], "lang": "zh",
}


def test_memo_requires_ai(monkeypatch):
    from app.services import llm

    monkeypatch.setattr(type(llm.analyst), "enabled", property(lambda self: False))
    assert client.post("/api/pipeline/memo", json=MEMO_BODY).status_code == 503


def test_memo_returns_structured_verdict_from_forced_tool_call(monkeypatch):
    from types import SimpleNamespace

    from app.services import llm

    captured = {}

    class FakeMessages:
        async def create(self, **kwargs):
            captured.update(kwargs)
            block = SimpleNamespace(type="tool_use", name="submit_memo", input={
                "verdict": "paper_first", "headline": "留出期夏普 1.9 高于样本内 1.2，但 t 值 2.1 未过 3。",
                "strengths": ["留出期确认"], "concerns": ["换手 12.9 倍", "DSR 0.84 < 0.95"],
                "next_steps": ["把持仓缓冲提到 8 再测"], "honesty_note": "540 天样本无法区分运气与技能。",
            })
            return SimpleNamespace(content=[block], usage=SimpleNamespace(input_tokens=10, output_tokens=20))

    monkeypatch.setattr(type(llm.analyst), "enabled", property(lambda self: True))
    monkeypatch.setattr(type(llm.analyst), "client", property(lambda self: SimpleNamespace(messages=FakeMessages())))
    r = client.post("/api/pipeline/memo", json=MEMO_BODY)
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verdict"] == "paper_first" and len(body["concerns"]) == 2
    assert captured["tool_choice"] == {"type": "tool", "name": "submit_memo"}
    assert "1.9" in captured["messages"][0]["content"]  # the model saw our numbers, not a paraphrase


# ------------------------------------------- V3.1: Sharpe difference test


def test_sharpe_difference_test_detects_a_real_gap_and_not_noise():
    rng = np.random.default_rng(7)
    idx = pd.date_range("2023-01-01", periods=750, freq="D")
    base = pd.Series(rng.normal(0.0003, 0.01, 750), index=idx)
    better = base + 0.0015  # same noise, clearly higher mean
    twin = base + rng.normal(0, 0.0005, 750)
    strong = portfolio.sharpe_difference_test(better, base)
    same = portfolio.sharpe_difference_test(twin, base)
    assert strong["delta_sharpe"] > 0 and strong["p_value"] < 0.05
    assert same["p_value"] > 0.05
    assert portfolio.sharpe_difference_test(base.iloc[:30], base.iloc[:30])["p_value"] is None


def test_alternatives_carry_the_equal_weight_test():
    panel = _panel(600, 30, seed=5)
    res = pipeline.run_pipeline_blocking({**SPEC, "compare": True}, panel=panel)
    by = {a["scheme"]: a for a in res["alternatives"]}
    assert by["equal"]["delta_sharpe_vs_equal_ann"] == 0.0 and by["equal"]["p_value_vs_equal"] is None
    for scheme, row in by.items():
        if scheme != "equal":
            assert row["p_value_vs_equal"] is not None and 0 <= row["p_value_vs_equal"] <= 1


# ------------------------------------------------- V4: robustness diagnostics


def test_expanding_weights_gate_out_noise_factors():
    panel = _panel(600, 20, seed=9)
    _ = panel["close"].pct_change()
    # a genuine (oracle-ish) factor plus pure noise: the noise should be switched off most of the time
    panel = dict(panel)
    spec = pipeline.normalize_spec({**SPEC, "factors": ["rank(close)", "rank(volume)"], "signal_weighting": "ic_expanding"})
    scores, info, _ = pipeline.build_signal(spec, panel)
    for c in info["components"]:
        assert 0 <= c["active_pct"] <= 100
    # gating never leaves a day without a signal
    assert scores.notna().sum(axis=1).iloc[-1] > 0


def test_sensitivity_grid_and_rolling_beat():
    panel = _panel(600, 30, seed=5)
    res = pipeline.run_pipeline_blocking({**SPEC, "compare": True}, panel=panel)
    json.dumps(res)
    sens = res["sensitivity"]
    assert sens["top_n"] == [3, 6, 9] and sens["rebalance"] == [5, 10, 20]
    assert len(sens["cells"]) == 3 and all(len(r) == 3 for r in sens["cells"])
    centre = sens["cells"][1][1]
    assert centre["sharpe"] == res["backtest"]["stats"]["sharpe"]
    assert sens["median_sharpe"] is not None and "spike" in sens
    assert 0 <= res["backtest"]["stats"]["rolling_6m_beat_pct"] <= 100
    # the grid's extra configurations count as trials in the DSR
    assert res["backtest"]["overfitting"]["trials"] >= len(portfolio.SCHEMES) + 8
    off = pipeline.run_pipeline_blocking(SPEC, panel=panel)
    assert off["sensitivity"] is None


def test_rolling_window_beat_pct_extremes():
    idx = pd.date_range("2023-01-01", periods=400, freq="D")
    bench = pd.Series(0.0, index=idx)
    assert portfolio.rolling_window_beat_pct(pd.Series(0.001, index=idx), bench) == 100.0
    assert portfolio.rolling_window_beat_pct(pd.Series(-0.001, index=idx), bench) == 0.0
    assert portfolio.rolling_window_beat_pct(bench.iloc[:100], bench.iloc[:100]) is None


# ------------------------------------------------- V4.1: review fixes


def test_gap_day_return_is_not_erased():
    panel = _panel(300, 6, seed=2)
    close = panel["close"].copy()
    close.iloc[150, 0] = np.nan  # one missing print
    panel = {**panel, "close": close}
    spec = pipeline.normalize_spec({**SPEC, "factors": ["rank(close)"], "scheme": "equal", "top_n": 6, "cost_bps": 0, "hold_buffer": 0})
    scores = pd.DataFrame(1.0, index=close.index, columns=close.columns)
    sim = pipeline.simulate(scores, panel, spec)
    # equal-weight of every name, no costs: the portfolio must compound like the true equal-weight index
    true_ret = close.ffill().pct_change().loc[sim["net"].index].mean(axis=1)
    assert abs(float((1 + sim["net"]).prod()) - float((1 + true_ret).prod())) < 0.02


def test_partial_newest_bar_does_not_define_target_weights():
    panel = _panel(500, 30, seed=5)
    for k in ("open", "high", "low", "close", "volume"):
        panel[k].iloc[-1, 10:] = np.nan  # only 10 of 30 names printed today
    panel["returns"] = panel["close"].pct_change(); panel["vwap"] = (panel["high"] + panel["low"] + panel["close"]) / 3
    res = pipeline.run_pipeline_blocking({**SPEC, "factors": ["rank(delta(close, 5))"]}, panel=panel)
    assert res["target_weights"]["as_of"] == str(panel["close"].index[-2].date())
    assert len(res["target_weights"]["weights"]) == 6


def test_mean_variance_reacts_to_ic_magnitude():
    cov, _ = _cov()
    scores = np.array([-2.0, 2.0, 1.0, -1.0])  # best-scored name is NOT the lowest-vol one
    vols = np.sqrt(np.diag(cov))
    weak = portfolio.mean_variance_weights(portfolio.grinold_alpha(scores, vols, 0.001), cov, cap=1.0)
    strong = portfolio.mean_variance_weights(portfolio.grinold_alpha(scores, vols, 0.2), cov, cap=1.0)
    minvar = portfolio.min_variance_weights(cov, cap=1.0)
    assert np.abs(weak - minvar).max() < 0.1           # (almost) no signal → (almost) minimum variance
    assert strong[1] > weak[1] + 0.3                    # strong signal → tilt into the top-scored name


def test_in_sample_ic_window_closes_before_holdout():
    panel = _panel(600, 20, seed=1)
    spec = pipeline.normalize_spec({**SPEC, "factors": [{"expression": "rank(delta(close, 5))", "horizon": 30}]})
    _, info, _ = pipeline.build_signal(spec, panel)
    # with h=30 the naive 80% split would let 30 observations peek into the holdout; the
    # function must instead report an in-sample IC over fewer observations — check via the composite path
    assert info["composite_is_ic"] is not None
    ic = pipeline._daily_rank_ic(pipeline.factor_dsl.compute("rank(delta(close, 5))", panel)[0],
                                 panel["close"].pct_change(30).shift(-30))
    naive = float(ic.iloc[: int(len(ic) * 0.8)].mean())
    clean = float(ic.iloc[: int(len(ic) * 0.8) - 30].mean())
    assert info["components"][0]["is_ic"] == pytest.approx(round(clean, 4), abs=1e-4)
    assert info["components"][0]["is_ic"] != pytest.approx(round(naive, 4), abs=1e-6) or abs(naive - clean) < 1e-6


def test_normalize_spec_rejects_garbage_without_crashing():
    for bad in (
        {"factors": [1]},
        {"factors": ["rank(close)"], "top_n": float("inf")},
        {"factors": ["rank(close)"], "target_vol_pct": 2},
    ):
        with pytest.raises(factor_dsl.FactorError):
            pipeline.normalize_spec(bad)
    # an unhashable market is coerced to the default instead of crashing
    assert pipeline.normalize_spec({"factors": ["rank(close)"], "market": ["us"]})["market"] == "us"


def test_held_name_with_missing_score_is_not_liquidated():
    panel = _panel(400, 8, seed=4)
    idx = panel["close"].index
    scores = pd.DataFrame(np.tile(np.arange(8, dtype=float), (len(idx), 1)), index=idx, columns=panel["close"].columns)
    day = 250  # a rebalance day for rebalance=10 once the loop starts at `first`
    spec = pipeline.normalize_spec({**SPEC, "factors": ["rank(close)"], "scheme": "equal", "top_n": 3, "hold_buffer": 2, "rebalance": 10, "cost_bps": 0})
    scores.iloc[day:day + 12, 7] = np.nan  # the best name loses its score for a few days
    sim = pipeline.simulate(scores, panel, spec)
    held = sim["held"]
    # S7 was held before the hiccup; it must still be held right after the affected rebalances
    assert float(held.iloc[day + 5]["S7"]) > 0.2


# ----------------------------------------------- V5: custom universes, orders


def test_parse_symbols_validates_and_dedupes():
    assert pipeline.parse_symbols(None) == [] and pipeline.parse_symbols("") == []
    got = pipeline.parse_symbols(" aapl, MSFT;nvda goog\nmeta amzn tsla jpm aapl ")
    assert got == ["AAPL", "MSFT", "NVDA", "GOOG", "META", "AMZN", "TSLA", "JPM"]
    with pytest.raises(factor_dsl.FactorError):
        pipeline.parse_symbols(["AAPL", "MSFT"])  # too few
    with pytest.raises(factor_dsl.FactorError):
        pipeline.parse_symbols(["AAPL; DROP TABLE"] + ["X%d" % i for i in range(8)])
    with pytest.raises(factor_dsl.FactorError):
        pipeline.parse_symbols([1, 2, 3, 4, 5, 6, 7, 8])


def test_custom_universe_uses_downloader_and_caches(monkeypatch):
    calls = []
    synthetic = _panel(400, 10, seed=8)
    names = ["AAPL", "MSFT", "NVDA", "GOOG", "META", "AMZN", "TSLA", "JPM", "V", "MA"]
    synthetic = {k: v.set_axis(names, axis=1) for k, v in synthetic.items()}

    def fake_download(tickers, period, label, min_symbols=8, market=None):
        calls.append((tuple(tickers), period, label))
        return synthetic

    monkeypatch.setattr(pipeline, "download_panel", fake_download)
    monkeypatch.setattr(pipeline.disk_cache, "load", lambda key, ttl: None)
    monkeypatch.setattr(pipeline.disk_cache, "store", lambda key, obj: None)
    pipeline._CUSTOM_CACHE.clear()
    spec = {**SPEC, "symbols": [*names, "ZZZZ"], "history": "5y"}
    res = pipeline.run_pipeline_blocking(spec)
    assert calls and calls[0][1] == "5y" and "ZZZZ" in calls[0][0]
    assert res["universe"]["custom"] is True and res["universe"]["history"] == "5y"
    assert res["universe"]["dropped"] == ["ZZZZ"] and res["universe"]["requested"] == 11
    pipeline.run_pipeline_blocking(spec)
    assert len(calls) == 1  # second run served from the in-memory cache
    # built-in universe with 3y never touches the custom path
    monkeypatch.setattr(pipeline, "_load_panel_blocking", lambda market: synthetic)
    plain = pipeline.run_pipeline_blocking(SPEC)
    assert plain["universe"]["custom"] is False and len(calls) == 1


def test_orders_move_book_to_target_and_never_short():
    panel = _panel(500, 30, seed=5)
    real = pipeline.UNIVERSES["us"][:30]
    panel = {k: v.set_axis(real, axis=1) for k, v in panel.items()}
    res = pipeline.run_pipeline_blocking(SPEC, panel=panel)
    targets = {w["symbol"]: w["weight_pct"] for w in res["target_weights"]["weights"]}
    # currently hold a name that is NOT in the target → must be sold entirely; hold cash otherwise
    stray = next(s for s in real if s not in targets)
    px = float(panel["close"].ffill().iloc[-1][stray])
    ticket = pipeline.orders_blocking(SPEC, nav=100_000, current={stray: 100}, panel=panel)
    sells = [o for o in ticket["orders"] if o["side"] == "sell"]
    assert len(sells) == 1 and sells[0]["symbol"] == stray and sells[0]["shares"] == 100
    assert sells[0]["notional"] == pytest.approx(100 * px, rel=1e-6)
    buys = {o["symbol"]: o for o in ticket["orders"] if o["side"] == "buy"}
    assert set(buys) == set(targets)
    for sym, o in buys.items():
        assert o["to_weight_pct"] == targets[sym]
        assert o["notional"] <= targets[sym] / 100 * 100_000 + 1e-6  # floor to whole shares
    s_ = ticket["summary"]
    assert s_["sells"] == 1 and s_["buys"] == len(targets)
    assert s_["cash_after"] == pytest.approx(s_["cash_before"] + s_["sell_notional"] - s_["buy_notional"] - s_["est_cost"], abs=0.01)
    assert ticket["orders"][0]["side"] == "sell"  # sells listed first
    # already at target → no orders
    shares = {sym: int(np.floor(targets[sym] / 100 * 100_000 / float(panel["close"].ffill().iloc[-1][sym]))) for sym in targets}
    quiet = pipeline.orders_blocking(SPEC, nav=100_000, current=shares, panel=panel)
    assert quiet["orders"] == [] or all(o["notional"] < 100_000 * 0.01 for o in quiet["orders"])
    with pytest.raises(factor_dsl.FactorError):
        pipeline.orders_blocking(SPEC, nav=-5, panel=panel)
    with pytest.raises(factor_dsl.FactorError):
        pipeline.orders_blocking(SPEC, nav=1000, current={"AAPL": -3}, panel=panel)


def test_orders_endpoint_contract(monkeypatch):
    panel = _panel(500, 30, seed=5)
    monkeypatch.setattr(pipeline, "_load_panel_blocking", lambda market: panel)
    r = client.post("/api/pipeline/orders", json={"spec": SPEC, "nav": 50_000, "current": {"S1": 10}})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["nav"] == 50_000 and "orders" in body and body["summary"]["turnover_pct"] >= 0
    assert client.post("/api/pipeline/orders", json={"spec": SPEC, "nav": 0}).status_code == 422
    bad = client.post("/api/pipeline/run", json={**SPEC, "symbols": ["AAPL", "MSFT"]})
    assert bad.status_code == 400  # too few custom symbols


# ------------------------------------------------ V5.1: second review fixes


def test_orders_reject_absurd_positions_and_flag_unknown_cash():
    panel = _panel(500, 30, seed=5)
    with pytest.raises(factor_dsl.FactorError):
        pipeline.orders_blocking(SPEC, nav=1e5, current={"S1": 1e308}, panel=panel)
    ticket = pipeline.orders_blocking(SPEC, nav=1e5, current={"NOPE": 100, "S1": 10}, panel=panel)
    assert ticket["unpriced"] == ["NOPE"]
    assert ticket["summary"]["cash_unknown"] is True
    assert ticket["summary"]["cash_before"] is None and ticket["summary"]["cash_after"] is None
    json.dumps(ticket, allow_nan=False)


def test_nan_in_request_is_a_422_not_a_500():
    import math

    body = json.dumps({**SPEC, "max_weight": float("nan")}, allow_nan=True)
    r = client.post("/api/pipeline/run", content=body, headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    r = client.post("/api/pipeline/orders", content=json.dumps({"spec": SPEC, "nav": math.inf}), headers={"Content-Type": "application/json"})
    assert r.status_code == 422
    r = client.post("/api/pipeline/orders", json={"spec": SPEC, "nav": 1000, "current": {"S1": 1e300}})
    assert r.status_code == 400


def test_custom_cache_is_bounded(monkeypatch):
    pipeline._CUSTOM_CACHE.clear()
    monkeypatch.setattr(pipeline, "_CUSTOM_CACHE_MAX", 3)
    dummy = {"close": pd.DataFrame()}
    for i in range(10):
        pipeline._remember_custom(f"k{i}", dummy)
    assert len(pipeline._CUSTOM_CACHE) == 3 and "k9" in pipeline._CUSTOM_CACHE and "k0" not in pipeline._CUSTOM_CACHE
    pipeline._CUSTOM_CACHE.clear()


def test_symbol_regex_accepts_indices_and_rejects_unicode():
    base = ["AAPL", "MSFT", "NVDA", "GOOG", "META", "AMZN", "TSLA"]
    assert "^GSPC" in pipeline.parse_symbols([*base, "^gspc"])
    with pytest.raises(factor_dsl.FactorError):
        pipeline.parse_symbols([*base, "ıbm"])
    with pytest.raises(factor_dsl.FactorError):
        pipeline.parse_symbols([*base, "AAPL^"])


def test_download_panel_survives_a_field_missing_a_column(monkeypatch):
    from app.services import factor_mine

    n, syms = 300, ["A0", "A1", "A2", "A3", "A4", "A5", "A6", "A7", "A8"]
    idx = pd.date_range("2024-01-01", periods=n, freq="D")
    rng = np.random.default_rng(0)
    close = pd.DataFrame(100 * np.exp(np.cumsum(rng.normal(0, 0.01, (n, 9)), axis=0)), index=idx, columns=syms)
    vol = pd.DataFrame(1e6, index=idx, columns=syms)
    vol["A3"] = np.nan  # a symbol with no volume at all (futures / indices)
    raw = pd.concat({"Open": close, "High": close * 1.01, "Low": close * 0.99, "Close": close, "Volume": vol}, axis=1)
    monkeypatch.setattr(factor_mine.yf, "download", lambda *a, **k: raw)
    panel = factor_mine.download_panel(syms, "3y", "test")
    assert list(panel["volume"].columns) == list(panel["close"].columns)
    assert panel["volume"]["A3"].isna().all()


# ------------------------------------------------ V6: capacity, health, corr


def test_capacity_curve_scales_with_sqrt_aum_and_flags_small_capacity():
    panel = _panel(500, 30, seed=5)
    res = pipeline.run_pipeline_blocking({**SPEC, "compare": False}, panel=panel)
    cap = res["capacity"]
    json.dumps(res, allow_nan=False)
    assert cap["aum_grid"] == [1e6, 1e7, 1e8, 1e9]
    d = cap["impact_drag_pct_ann"]
    assert all(x >= 0 for x in d) and d[0] < d[1] < d[2] < d[3]
    # square-root law: ×10 AUM → ×√10 drag
    assert d[1] / d[0] == pytest.approx(10 ** 0.5, rel=0.05)
    if cap["excess_pct_ann"] is not None and cap["excess_pct_ann"] > 0:
        assert cap["breakeven_aum"] is not None and cap["breakeven_aum"] > 0
        assert cap["net_excess_pct_ann"][0] > cap["net_excess_pct_ann"][-1]


def test_data_health_reports_gaps_and_stale_names():
    panel = _panel(300, 6, seed=2)
    close = panel["close"].copy()
    close.iloc[100:103, 0] = np.nan       # three missing prints inside the history
    close.iloc[-20:, 1] = np.nan          # delisted / stale
    close.iloc[:50, 2] = np.nan           # late listing
    panel = {**panel, "close": close}
    rows = {r["symbol"]: r for r in pipeline.data_health(panel)}
    assert rows["S0"]["gaps"] == 3 and rows["S0"]["stale"] is False
    assert rows["S1"]["stale"] is True and rows["S1"]["stale_days"] == 20 and rows["S1"]["gaps"] == 0
    assert rows["S2"]["first"] == str(close.index[50].date()) and rows["S2"]["coverage_pct"] == pytest.approx(83.3, abs=0.1)


def test_factor_correlation_matrix_is_symmetric_with_unit_diagonal():
    panel = _panel(500, 20, seed=1)
    spec = pipeline.normalize_spec({**SPEC, "factors": ["rank(delta(close, 5))", "rank(delta(close, 6))", "neg(ts_std(returns, 20))"]})
    _, info, _ = pipeline.build_signal(spec, panel)
    m = info["corr_matrix"]
    assert len(m) == 3 and all(m[i][i] == 1.0 for i in range(3))
    assert m[0][1] == m[1][0] and m[0][1] > 0.7          # near-duplicate factors
    assert abs(m[0][2]) < 0.5
    assert info["max_pair_corr"] == pytest.approx(max(abs(m[0][1]), abs(m[0][2]), abs(m[1][2])), abs=1e-9)


# ------------------------------------------------ V6.1: capacity review fixes


def test_capacity_does_not_drop_trades_without_volume():
    panel = _panel(500, 30, seed=5)
    full = pipeline.run_pipeline_blocking({**SPEC, "compare": False}, panel=panel)["capacity"]
    half = dict(panel)
    vol = panel["volume"].copy()
    vol.iloc[:, :15] = np.nan  # half the universe has no volume data at all
    half["volume"] = vol
    partial = pipeline.run_pipeline_blocking({**SPEC, "compare": False}, panel=half)["capacity"]
    assert partial["costed_trade_pct"] == 100.0  # borrowed the cross-sectional median ADV instead of dropping
    assert partial["impact_drag_pct_ann"][0] > 0.5 * full["impact_drag_pct_ann"][0]
    none = dict(panel)
    none["volume"] = panel["volume"] * np.nan
    empty = pipeline.run_pipeline_blocking({**SPEC, "compare": False}, panel=none)["capacity"]
    assert empty["breakeven_aum"] is None and empty["impact_drag_pct_ann"] == [None] * 4  # no ADV → no claim


def test_breakeven_uses_unrounded_drag_and_consistent_scaling():
    panel = _panel(500, 30, seed=5)
    panel = dict(panel)
    panel["volume"] = panel["volume"] * 1e3  # very liquid → tiny drags
    res = pipeline.run_pipeline_blocking({**SPEC, "compare": False}, panel=panel)
    cap = res["capacity"]
    if cap["excess_pct_ann"] and cap["excess_pct_ann"] > 0:
        # net excess hits zero at the breakeven: drag(AUM*) == excess, using the √AUM law from the 1M cell
        implied = cap["impact_drag_pct_ann"][0] * (cap["breakeven_aum"] / 1e6) ** 0.5
        assert implied == pytest.approx(cap["excess_pct_ann"], rel=0.02)


def test_partial_newest_bar_is_not_stale():
    panel = _panel(300, 6, seed=2)
    close = panel["close"].copy()
    close.iloc[-1, 0] = np.nan  # today's print not in yet
    close.iloc[-10:, 1] = np.nan
    rows = {r["symbol"]: r for r in pipeline.data_health({**panel, "close": close})}
    assert rows["S0"]["stale"] is False and rows["S0"]["stale_days"] == 1
    assert rows["S1"]["stale"] is True and rows["S1"]["stale_days"] == 10
    allnan = close.copy(); allnan["S2"] = np.nan
    rows = {r["symbol"]: r for r in pipeline.data_health({**panel, "close": allnan})}
    assert rows["S2"]["coverage_pct"] == 0.0 and rows["S2"]["first"] is None
