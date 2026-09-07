"""V4 pipeline features: L1 turnover penalty (aim portfolio), long-short
mode, CPCV path distribution, point-in-time fundamentals, survivorship note."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.config import get_settings
from app.main import app
from app.services import factor_dsl, fundamentals, pipeline, portfolio
from tests.test_factors import _panel
from tests.test_pipeline import SPEC

client = TestClient(app)


# ------------------------------------------------------- turnover penalty


def test_prox_reduces_to_projection_and_shrinks_trades_monotonically():
    rng = np.random.default_rng(0)
    v = rng.normal(size=8)
    cur = np.full(8, 1 / 8)
    assert np.allclose(portfolio.prox_l1_capped_simplex(v, cur, 0.0, 0.3), portfolio.project_capped_simplex(v, 0.3))
    last = None
    for kappa in (0.0, 0.05, 0.2, 1.0, 5.0):
        w = portfolio.prox_l1_capped_simplex(v, cur, kappa, 0.3)
        assert abs(w.sum() - 1) < 1e-6 and (w >= -1e-12).all() and (w <= 0.3 + 1e-9).all()
        traded = np.abs(w - cur).sum() / 2
        assert last is None or traded <= last + 1e-9
        last = traded
    assert last < 1e-6  # a huge penalty means: do not trade


def test_mean_variance_penalty_trades_less_but_keeps_the_tilt():
    rng = np.random.default_rng(3)
    R = rng.normal(0, 0.02, (300, 8))
    cov = portfolio.shrink_cov(R)
    alpha = portfolio.grinold_alpha(rng.normal(size=8), np.sqrt(np.diag(cov)), 0.05)
    cur = np.full(8, 1 / 8)
    plain = portfolio.mean_variance_weights(alpha, cov, 0.3)
    assert np.allclose(portfolio.mean_variance_weights(alpha, cov, 0.3, current=cur, turnover_penalty=0.0), plain)
    pen = portfolio.mean_variance_weights(alpha, cov, 0.3, current=cur, turnover_penalty=1e-3)
    assert np.abs(pen - cur).sum() < np.abs(plain - cur).sum()
    assert alpha @ pen > alpha @ cur  # still tilted toward the signal


def test_pipeline_turnover_penalty_lowers_mean_variance_turnover():
    panel = _panel(600, 30, seed=5)
    base = {**SPEC, "scheme": "mean_variance", "compare": False}
    plain = pipeline.run_pipeline_blocking(base, panel=panel)
    pen = pipeline.run_pipeline_blocking({**base, "turnover_penalty_bps": 40}, panel=panel)
    assert pen["portfolio"]["turnover_penalty_bps"] == 40
    assert pen["portfolio"]["avg_turnover_pct"] < plain["portfolio"]["avg_turnover_pct"]
    # other schemes ignore the knob (nothing to trade the cost off against)
    iv = pipeline.run_pipeline_blocking({**SPEC, "compare": False, "turnover_penalty_bps": 40}, panel=panel)
    assert iv["portfolio"]["avg_turnover_pct"] == pipeline.run_pipeline_blocking({**SPEC, "compare": False}, panel=panel)["portfolio"]["avg_turnover_pct"]


# --------------------------------------------------------------- long-short


def test_long_short_is_dollar_neutral_pays_borrow_and_labels_sides():
    panel = _panel(600, 30, seed=5)
    out = pipeline.run_pipeline_blocking({**SPEC, "compare": False, "long_short": True, "borrow_bps": 200}, panel=panel)
    tw = out["target_weights"]
    assert abs(tw["exposure_pct"]) < 1.0 and abs(tw["gross_pct"] - 200) < 2
    assert tw["long_pct"] == pytest.approx(100, abs=1) and tw["short_pct"] == pytest.approx(100, abs=1)
    sides = {w["side"] for w in tw["weights"]}
    assert sides == {"long", "short"} and len(tw["weights"]) == 12
    assert all((w["weight_pct"] < 0) == (w["side"] == "short") for w in tw["weights"])
    p = out["portfolio"]
    assert p["long_short"] is True and p["borrow_bps"] == 200 and p["borrow_cost_pct"] > 0
    assert abs(p["avg_net_exposure_pct"]) < 5 and p["avg_exposure_pct"] > 150
    assert "long_short_caveats" in out["warnings"]
    assert abs(out["backtest"]["stats"]["beta"]) < 0.3  # market-neutral by construction
    cheaper = pipeline.run_pipeline_blocking({**SPEC, "compare": False, "long_short": True, "borrow_bps": 0}, panel=panel)
    assert cheaper["backtest"]["stats"]["total_return_pct"] > out["backtest"]["stats"]["total_return_pct"]
    with pytest.raises(factor_dsl.FactorError, match="long-only"):
        pipeline.orders_blocking({**SPEC, "long_short": True}, 100_000.0, panel=panel)


def test_long_short_oracle_signal_makes_money_on_both_legs():
    panel = _panel(500, 20, seed=3)
    # tomorrow's return as today's score: the long leg rises, the short leg falls
    oracle = panel["close"].pct_change().shift(-1)
    spec = pipeline.normalize_spec({**SPEC, "long_short": True, "top_n": 4, "rebalance": 1, "cost_bps": 0, "borrow_bps": 0})
    sim = pipeline.simulate(oracle, panel, spec, ic=0.3)
    assert sim["long_short"] and float(sim["net"].mean()) > 0
    longs = (sim["held"] > 0).sum(axis=1)
    shorts = (sim["held"] < 0).sum(axis=1)
    assert longs.iloc[-1] == 4 and shorts.iloc[-1] == 4


def test_run_endpoint_accepts_v4_fields(monkeypatch):
    panel = _panel(500, 20)
    monkeypatch.setattr(pipeline, "_load_panel_blocking", lambda market: panel)
    r = client.post("/api/pipeline/run", json={**SPEC, "long_short": True, "turnover_penalty_bps": 10, "borrow_bps": 50})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["spec"]["long_short"] is True and body["spec"]["borrow_bps"] == 50
    assert client.post("/api/pipeline/run", json={**SPEC, "borrow_bps": 9999}).status_code == 422
    o = client.post("/api/pipeline/orders", json={"spec": {**SPEC, "long_short": True}, "nav": 50_000})
    assert o.status_code == 400 and "long-only" in o.json()["detail"]


# ------------------------------------------------------------------- CPCV


def test_cpcv_paths_cover_the_history_once_and_report_a_distribution():
    panel = _panel(600, 30, seed=5)
    out = pipeline.run_pipeline_blocking({**SPEC, "compare": True}, panel=panel)
    c = out["cpcv"]
    assert c["groups"] == 6 and c["k"] == 2 and c["splits"] == 15 and c["paths"] == 5
    assert c["complete"] and len(c["path_sharpes"]) == 5
    span_days = len(out["backtest"]["equity_curve"])
    assert all(abs(d - span_days) <= 2 for d in c["path_days"])   # each path is a full out-of-sample history
    assert c["min_sharpe"] <= c["median_sharpe"] <= c["max_sharpe"]
    assert c["purge_days"] == 10 and c["embargo_days"] >= c["purge_days"]
    assert pipeline.run_pipeline_blocking({**SPEC, "compare": False}, panel=panel)["cpcv"] is None


def test_cpcv_oracle_is_positive_on_every_path_and_noise_is_not():
    panel = _panel(500, 20, seed=3)
    close = panel["close"]
    spec = pipeline.normalize_spec({**SPEC, "top_n": 4, "rebalance": 1, "cost_bps": 0})
    oracle_rank = close.pct_change().shift(-1).rank(axis=1, pct=True)
    fwd = close.pct_change(1).shift(-1)
    ic = pipeline._daily_rank_ic(oracle_rank, fwd)
    c = pipeline.cpcv([oracle_rank], [ic], {**spec, "factors": [{"expression": "x", "invert": False, "horizon": 1}]}, panel)
    assert c["pct_paths_positive"] == 100.0 and c["min_sharpe"] > 3


# ------------------------------------------------------------ fundamentals


def test_dsl_knows_fundamental_fields_and_reports_missing_data():
    node = factor_dsl.parse("rank(ep) + neg(pb)")
    assert factor_dsl.fields_used(node) == {"ep", "pb"}
    with pytest.raises(factor_dsl.FactorError, match="fundamentals"):
        factor_dsl.compute("rank(ep)", _panel(100, 5))
    with pytest.raises(factor_dsl.FactorError, match="unknown field"):
        factor_dsl.parse("rank(eps_growth)")


def test_frames_from_rows_apply_publication_lag_and_forward_fill():
    idx = pd.date_range("2024-01-01", periods=200, freq="D")
    rows = {"AAA": [{"date": "2024-03-31", "mcap": 1e9, "pe": 20.0, "pb": 4.0, "roe": 0.3},
                    {"date": "2023-12-31", "mcap": 9e8, "pe": 25.0, "pb": 5.0, "roe": 0.2}]}
    f = fundamentals.frames_from_rows(rows, idx, ["AAA", "BBB"], lag_days=60)
    pe = f["pe"]["AAA"]
    assert np.isnan(pe.loc["2024-02-28"])                 # Q4 not yet public (Dec 31 + 60d = Feb 29)
    assert pe.loc["2024-03-01"] == 25.0                    # Q4 visible, Q1 not yet
    assert pe.loc["2024-05-29"] == 25.0 and pe.loc["2024-05-30"] == 20.0   # Q1 lands Mar 31 + 60d
    assert f["ep"]["AAA"].loc["2024-06-30"] == pytest.approx(1 / 20)
    assert f["bp"]["AAA"].loc["2024-06-30"] == pytest.approx(1 / 4)
    assert f["pe"]["BBB"].isna().all()


def test_attach_refuses_without_key_or_on_crypto_and_runs_with_provider(monkeypatch):
    panel = _panel(500, 20)
    s = get_settings()
    monkeypatch.setattr(s, "fmp_api_key", None)
    assert pipeline.config()["fundamentals"]["enabled"] is False
    with pytest.raises(factor_dsl.FactorError, match="FMP_API_KEY"):
        pipeline.run_pipeline_blocking({**SPEC, "compare": False, "factors": [{"expression": "rank(ep)"}]}, panel=panel)
    monkeypatch.setattr(s, "fmp_api_key", "k")
    with pytest.raises(factor_dsl.FactorError, match="US market"):
        fundamentals.attach(panel, "crypto")
    rng = np.random.default_rng(1)
    quarters = pd.date_range("2023-09-30", periods=6, freq="QE")
    rows = {str(c): [{"date": str(q.date()), "mcap": float(rng.uniform(1e9, 1e11)), "pe": float(rng.uniform(8, 40)),
                      "pb": float(rng.uniform(1, 8)), "roe": float(rng.uniform(-0.1, 0.4))} for q in quarters]
            for c in panel["close"].columns}
    monkeypatch.setattr(fundamentals, "_raw_rows", lambda market, symbols: rows)
    out = pipeline.run_pipeline_blocking({**SPEC, "compare": False, "factors": [{"expression": "rank(ep)"}, {"expression": "roe"}]}, panel=panel)
    assert out["signal"]["components"][0]["expression"] == "rank(ep)"
    assert "ep" not in panel  # the shared panel was not mutated
    assert pipeline.config()["fundamentals"] == {"enabled": True, "provider": "fmp", "market": "us",
                                                 "fields": ["mcap", "pe", "pb", "roe", "ep", "bp"], "lag_days": 60}


def test_fundamentals_cache_is_per_universe(monkeypatch, tmp_path):
    monkeypatch.setenv("AIQUANT_CACHE_DIR", str(tmp_path))
    monkeypatch.setattr(fundamentals, "kvstore", type("KV", (), {"mode": staticmethod(lambda: "file")}))
    fundamentals._MEM.clear()
    calls = []
    monkeypatch.setattr(fundamentals, "_download", lambda syms: (calls.append(list(syms)) or {s: [{"date": "2024-03-31", "pe": 10.0}] for s in syms}))
    small = fundamentals._raw_rows("us", ["A", "B"])
    big = fundamentals._raw_rows("us", ["A", "B", "C", "D"])
    assert set(small) == {"A", "B"} and set(big) == {"A", "B", "C", "D"} and len(calls) == 2
    assert fundamentals._raw_rows("us", ["B", "A"]) == small and len(calls) == 2   # order-insensitive hit


def test_download_survives_html_bodies_and_worker_errors(monkeypatch):
    class Resp:
        status_code = 200

        def json(self):
            raise ValueError("not json")

    class Client:
        def __init__(self, *a, **k):
            pass

        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def get(self, url, params=None):
            if params.get("symbol") == "BOOM" or "BOOM" in url:
                raise RuntimeError("worker died")
            return Resp()

    monkeypatch.setattr(fundamentals.httpx, "Client", Client)
    monkeypatch.setattr(get_settings(), "fmp_api_key", "k")
    assert fundamentals._download(["AAA", "BOOM"]) == {}


def test_attach_fails_loudly_on_thin_coverage(monkeypatch):
    panel = _panel(300, 20)
    monkeypatch.setattr(get_settings(), "fmp_api_key", "k")
    monkeypatch.setattr(fundamentals, "_raw_rows", lambda market, symbols: {"S0": [{"date": "2024-03-31", "pe": 10.0}]})
    with pytest.raises(factor_dsl.FactorError, match="cover only"):
        fundamentals.attach(panel, "us")


def test_fetch_symbol_reads_stable_then_v3(monkeypatch):
    class Resp:
        def __init__(self, code, body):
            self.status_code, self._b = code, body

        def json(self):
            return self._b

    class Client:
        def __init__(self):
            self.calls = []

        def get(self, url, params=None):
            self.calls.append(url)
            if "stable" in url:
                return Resp(403, {"Error Message": "legacy"})
            return Resp(200, [{"date": "2024-03-31", "marketCap": 5e9, "peRatio": 12.5, "pbRatio": 2.0, "roe": 0.15}])

    c = Client()
    rows = fundamentals.fetch_symbol("AAPL", "k", c)
    assert len(c.calls) == 2 and rows == [{"date": "2024-03-31", "mcap": 5e9, "pe": 12.5, "pb": 2.0, "roe": 0.15}]


# ------------------------------------------------------------ survivorship


def test_universe_carries_survivorship_note():
    panel = _panel(400, 12)
    panel["close"].iloc[:100, 0] = np.nan  # one late listing
    out = pipeline.run_pipeline_blocking({**SPEC, "compare": False}, panel=panel)
    surv = out["universe"]["survivorship"]
    assert surv["current_constituents_only"] is True and surv["delisted_included"] is False
    assert surv["late_listings"] == 1
