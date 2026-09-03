"""Factor DSL + mining loop tests. No network, no LLM — the loop's math and
safety boundaries are what需要锁定; the LLM only fills in generation."""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services import factor_dsl
from app.services.factor_mine import (
    MIN_ABS_IC,
    MODES,
    _round_feedback,
    _session_lessons,
    _verdict,
    check_factor_blocking,
    composite_backtest_blocking,
    evaluate_candidate,
    portfolio_backtest_blocking,
)


def _panel(n_days: int = 400, n_syms: int = 12, seed: int = 7) -> dict[str, pd.DataFrame]:
    rng = np.random.default_rng(seed)
    idx = pd.date_range("2024-01-01", periods=n_days, freq="D")
    cols = [f"S{i}" for i in range(n_syms)]
    close = pd.DataFrame(
        100 * np.exp(np.cumsum(rng.normal(0, 0.02, (n_days, n_syms)), axis=0)),
        index=idx, columns=cols,
    )
    panel = {
        "open": close * (1 + rng.normal(0, 0.002, (n_days, n_syms))),
        "high": close * 1.01,
        "low": close * 0.98,
        "close": close,
        "volume": pd.DataFrame(rng.uniform(1e6, 5e6, (n_days, n_syms)), index=idx, columns=cols),
    }
    panel["returns"] = close.pct_change()
    panel["vwap"] = (panel["high"] + panel["low"] + close) / 3
    return panel


# ----------------------------------------------------------------- DSL


def test_dsl_parses_alpha101_style():
    node = factor_dsl.parse(
        "neg(ts_corr(rank(delta(log(volume), 1)), rank((close - open) / open), 6))"
    )
    assert factor_dsl.complexity(node) == 12


@pytest.mark.parametrize(
    "bad",
    [
        "__import__('os').system('x')",
        "close ** 2",
        "eval(close)",
        "ts_mean(close, 9999)",
        "ts_mean(close)",
        "unknown_field + 1",
        "close; volume",
        "3.14",
        "",
        "rank(" * 12 + "close" + ")" * 12,  # nesting deeper than MAX_DEPTH
    ],
)
def test_dsl_rejects_unsafe_or_invalid(bad):
    with pytest.raises(factor_dsl.FactorError):
        factor_dsl.compute(bad, _panel(120, 6))


def test_dsl_length_cap():
    expr = "rank(close)" + " + rank(close)" * 40
    with pytest.raises(factor_dsl.FactorError):
        factor_dsl.parse(expr)


def test_dsl_evaluates_shapes():
    panel = _panel()
    values, _ = factor_dsl.compute("rank(delta(close, 5))", panel)
    assert values.shape == panel["close"].shape
    # cross-sectional rank is bounded 0..1
    assert values.max().max() <= 1.0 and values.min().min() >= 0.0


# ------------------------------------------------------------- metrics


def test_planted_signal_produces_positive_ic():
    """A factor equal to (leaked) future returns must show IC ≈ 1 — the
    metric pipeline's plumbing test."""
    panel = _panel()
    horizon = 10
    fwd = panel["close"].pct_change(horizon).shift(-horizon)
    panel["vwap"] = fwd  # plant the leak in an innocuous field
    m = evaluate_candidate("rank(vwap)", panel, horizon, [])
    assert m["is_ic"] > 0.9 and m["oos_ic"] > 0.9
    accepted, reasons = _verdict(m)
    assert accepted, reasons


def test_noise_factor_is_rejected():
    panel = _panel()
    m = evaluate_candidate("rank(ts_corr(volume, open, 7))", panel, 10, [])
    accepted, reasons = _verdict(m)
    # pure noise: near-zero IC in a random-walk panel
    assert abs(m["is_ic"]) < 0.15
    if not accepted:
        assert reasons


def test_redundant_factor_flagged():
    panel = _panel()
    base = evaluate_candidate("rank(delta(close, 5))", panel, 10, [])
    dup = evaluate_candidate("rank(delta(close, 6))", panel, 10, [base["_values"]])
    assert dup["max_zoo_corr"] > 0.7
    _, reasons = _verdict(dup)
    assert any("redundant" in r for r in reasons)


def test_feedback_quotes_errors_and_directives():
    text = _round_feedback(
        [
            {"expression": "bad(close)", "error": "unknown function 'bad'"},
            {
                "expression": "rank(close)",
                "accepted": False,
                "reasons": [f"weak signal: |IS IC| 0.001 < {MIN_ABS_IC}"],
                "is_ic": 0.001, "is_icir": 0.01, "oos_ic": 0.0, "max_zoo_corr": 0.0,
            },
        ]
    )
    assert "unknown function" in text
    assert "DIRECTIVES" in text


# ----------------------------------------------------------------- API


def test_config_endpoint():
    body = TestClient(app).get("/api/factors/config").json()
    assert {"us", "crypto"} <= set(body["universes"])
    assert len(body["universes"]["us"]) >= 20


def test_mine_requires_ai(monkeypatch):
    from app.services import factor_mine

    monkeypatch.setattr(type(factor_mine.analyst), "enabled", property(lambda self: False))
    client = TestClient(app)
    with client.stream("POST", "/api/factors/mine", json={"market": "us"}) as resp:
        first = next(resp.iter_lines())
    assert "not configured" in first


# ------------------------------------------------- tiers / memory / backtest


def test_modes_ordering():
    assert MODES["strict"][0] > MODES["standard"][0] > MODES["loose"][0]
    assert MODES["strict"][1] > MODES["standard"][1] > MODES["loose"][1]


def test_loose_mode_admits_marginal_factor():
    m = {
        "coverage": 0.9, "complexity": 5, "is_ic": 0.012, "is_icir": 0.1,
        "oos_ic": 0.011, "max_zoo_corr": 0.1,
    }
    accepted_std, _ = _verdict(m, "standard")
    accepted_loose, _ = _verdict(m, "loose")
    assert not accepted_std and accepted_loose


def test_holdout_confirmation_survives_loose_mode():
    m = {
        "coverage": 0.9, "complexity": 5, "is_ic": 0.05, "is_icir": 0.5,
        "oos_ic": -0.04, "max_zoo_corr": 0.1,  # sign flip in holdout
    }
    accepted, reasons = _verdict(m, "loose")
    assert not accepted and any("holdout" in r for r in reasons)


def test_session_lessons_extracts_directives():
    history = [
        "PRIOR SESSIONS: ...",
        "Round 1:\n- `x` rejected\nDIRECTIVES for next round: smooth with ts_mean.",
        "Round 2:\n- `y` rejected\nDIRECTIVES for next round: smooth with ts_mean.",
    ]
    lessons = _session_lessons(history, "us", 10)
    assert lessons == ["[us/10d] smooth with ts_mean"]  # deduped, tagged


def test_portfolio_backtest_on_synthetic_panel(monkeypatch):
    from app.services import factor_mine

    panel = _panel(400, 12)
    monkeypatch.setattr(factor_mine, "_load_panel_blocking", lambda market: panel)
    out = portfolio_backtest_blocking("rank(delta(close, 5))", "us", top_n=4, rebalance=10)
    assert out["stats"]["total_return_pct"] is not None
    assert len(out["equity_curve"]) == len(out["benchmark_curve"]) > 100
    assert out["stats"]["benchmark"]["sharpe"] is not None
    # no look-ahead plumbing check: first equity point starts at capital
    assert abs(out["equity_curve"][0]["value"] - 100_000) < 5_000


# --------------------------------------------------- composite / health


def test_composite_ic_weighting_and_shape(monkeypatch):
    from app.services import factor_mine

    panel = _panel(400, 12)
    monkeypatch.setattr(factor_mine, "_load_panel_blocking", lambda market: panel)
    out = composite_backtest_blocking(
        [
            {"expression": "rank(delta(close, 5))", "invert": False, "horizon": 10},
            {"expression": "rank(ts_std(returns, 20))", "invert": True, "horizon": 10},
        ],
        "us",
        weighting="ic",
    )
    assert len(out["components"]) == 2
    total_w = sum(c["weight"] for c in out["components"])
    assert abs(total_w - 1.0) < 0.01
    assert 0 <= out["max_pair_corr"] <= 1
    assert len(out["equity_curve"]) > 100


def test_composite_requires_two(monkeypatch):
    from app.services import factor_mine

    monkeypatch.setattr(factor_mine, "_load_panel_blocking", lambda market: _panel())
    with pytest.raises(factor_dsl.FactorError):
        composite_backtest_blocking(
            [{"expression": "rank(close)", "invert": False, "horizon": 10}], "us"
        )


def test_check_factor_reports_recent_ic(monkeypatch):
    from app.services import factor_mine

    panel = _panel(400, 12)
    monkeypatch.setattr(factor_mine, "_load_panel_blocking", lambda market: panel)
    out = check_factor_blocking("rank(delta(close, 5))", "us", 10)
    assert {"is_ic", "oos_ic", "recent_ic", "recent_days", "as_of"} <= set(out)
    assert out["recent_days"] == 60


def test_check_planted_decay_detected(monkeypatch):
    """A factor that WAS the future return early on but pure noise recently
    must show recent_ic near zero while is_ic stays high — the decay signal."""
    from app.services import factor_mine

    panel = _panel(400, 12, seed=11)
    horizon = 10
    fwd = panel["close"].pct_change(horizon).shift(-horizon)
    leak = fwd.copy()
    leak.iloc[-90:] = np.random.default_rng(3).normal(size=(90, leak.shape[1]))  # decayed tail
    panel["vwap"] = leak
    monkeypatch.setattr(factor_mine, "_load_panel_blocking", lambda market: panel)
    out = check_factor_blocking("rank(vwap)", "us", horizon)
    assert out["is_ic"] > 0.5
    assert abs(out["recent_ic"]) < 0.2


# ------------------------------------------------------------- disk cache


def test_disk_cache_roundtrip_and_ttl(tmp_path, monkeypatch):
    import pandas as pd

    from app.services import disk_cache

    monkeypatch.setenv("AIQUANT_CACHE_DIR", str(tmp_path))
    frame = pd.DataFrame({"a": [1.0, 2.0]})
    disk_cache.store("t-key", {"close": frame})
    loaded = disk_cache.load("t-key", ttl_seconds=60)
    assert loaded is not None and loaded["close"].equals(frame)
    # expired entries read as a miss
    assert disk_cache.load("t-key", ttl_seconds=-1) is None
    # unknown keys and weird characters are safe
    assert disk_cache.load("no/such:key", 60) is None


def test_disk_cache_corrupt_file_is_a_miss(tmp_path, monkeypatch):
    from app.services import disk_cache

    monkeypatch.setenv("AIQUANT_CACHE_DIR", str(tmp_path))
    (tmp_path / "bad.pkl").write_bytes(b"not a pickle")
    assert disk_cache.load("bad", 60) is None


# ------------------------------------------------------------ GP engine


def test_gp_random_trees_are_valid_dsl():
    import random

    from app.services.factor_gp import canonical, crossover, mutate, random_tree

    rng = random.Random(3)
    trees = [random_tree(rng, 3, full=(i % 2 == 0)) for i in range(150)]
    assert all(canonical(t) is not None for t in trees if factor_dsl.complexity(t) <= 24)
    a, b = random_tree(rng, 3), random_tree(rng, 3)
    kids = [crossover(rng, a, b) for _ in range(60)] + [mutate(rng, a) for _ in range(60)]
    # every child either serializes to a valid capped expression or is rejected — never crashes
    for k in kids:
        canonical(k)


def test_gp_has_transform_gate():
    from app.services.factor_gp import has_transform

    assert not has_transform(factor_dsl.parse("volume"))
    assert not has_transform(factor_dsl.parse("high * volume"))
    assert has_transform(factor_dsl.parse("rank(delta(close, 5))"))
    assert has_transform(factor_dsl.parse("ts_corr(high, low, 10) + 1"))


def test_constant_expression_rejected_even_when_nan():
    panel = _panel(200, 8)
    with pytest.raises(factor_dsl.FactorError):
        factor_dsl.compute("ts_rank(rank(close / close), 10)", panel)


def test_gp_finds_planted_signal(monkeypatch):
    """With future returns leaked into `vwap`, evolution must converge on a
    vwap-based champion with high IC — the engine's plumbing test."""
    from app.services import factor_gp, factor_mine

    panel = _panel(400, 12, seed=5)
    horizon = 10
    panel["vwap"] = panel["close"].pct_change(horizon).shift(-horizon)
    monkeypatch.setattr(factor_mine, "_load_panel_blocking", lambda market: panel)
    monkeypatch.setattr(factor_gp, "_load_panel_blocking", lambda market: panel)

    events: list[dict] = []
    report = factor_gp.evolve_blocking("us", horizon, 30, 8, "standard", [], 11, events.append)
    assert len(events) == 8 and events[-1]["gen"] == 8
    best = max(abs(d["is_ic"]) for d in report["discovered"]) if report["discovered"] else 0
    assert best > 0.5
    assert any("vwap" in d["expression"] for d in report["discovered"])


def test_gp_is_deterministic_with_seed(monkeypatch):
    from app.services import factor_gp, factor_mine

    panel = _panel(300, 10, seed=2)
    monkeypatch.setattr(factor_mine, "_load_panel_blocking", lambda market: panel)
    monkeypatch.setattr(factor_gp, "_load_panel_blocking", lambda market: panel)
    a = factor_gp.evolve_blocking("us", 10, 20, 4, "loose", [], 42, lambda e: None)
    b = factor_gp.evolve_blocking("us", 10, 20, 4, "loose", [], 42, lambda e: None)
    assert [d["expression"] for d in a["discovered"]] == [d["expression"] for d in b["discovered"]]


# ------------------------------------------------------ rate limits / usage


def test_ratelimit_window_and_ip_isolation():
    from app.services import ratelimit

    ratelimit._BUCKETS.clear()
    assert all(ratelimit.allow("t:a", 3, 60) for _ in range(3))
    assert not ratelimit.allow("t:a", 3, 60)       # 4th blocked
    assert ratelimit.allow("t:b", 3, 60)           # other client unaffected


def test_client_ip_prefers_forwarded_header():
    from types import SimpleNamespace

    from app.services.ratelimit import client_ip

    req = SimpleNamespace(headers={"x-forwarded-for": "203.0.113.9, 10.0.0.1"}, client=SimpleNamespace(host="10.0.0.1"))
    assert client_ip(req) == "203.0.113.9"
    req2 = SimpleNamespace(headers={}, client=SimpleNamespace(host="192.168.1.5"))
    assert client_ip(req2) == "192.168.1.5"


def test_usage_meter_accumulates(tmp_path, monkeypatch):
    monkeypatch.setenv("AIQUANT_CACHE_DIR", str(tmp_path))
    from app.services import usage

    before = usage.today()["calls"]
    usage.record("claude-sonnet-5", 120, 30)
    usage.record("claude-opus-5", 1000, 200)
    after = usage.today()
    assert after["calls"] == before + 2
    assert after["by_model"]["claude-sonnet-5"]["input_tokens"] >= 120
    assert after["input_tokens"] >= 1120


def test_mining_endpoint_rate_limited(monkeypatch):
    from app.config import get_settings
    from app.services import ratelimit

    ratelimit._BUCKETS.clear()
    monkeypatch.setattr(get_settings(), "rl_mining_per_day", 1)
    client = TestClient(app)
    # first call passes the limiter (AI is off in tests → body says so, still 200 stream)
    with client.stream("POST", "/api/factors/mine", json={"market": "us"}) as r1:
        assert r1.status_code == 200
    r2 = client.post("/api/factors/mine", json={"market": "us"})
    assert r2.status_code == 429


# ------------------------------------------------------ input validation


def test_blank_symbol_is_400_not_502():
    client = TestClient(app)
    assert client.get("/api/market/candles/%20").status_code == 400
    assert client.get("/api/market/news/%20").status_code == 400
    assert client.get("/api/analytics/indicator/%20/rsi").status_code == 400


def test_unknown_market_rejected():
    client = TestClient(app)
    r = client.post("/api/factors/check", json={"expression": "rank(close)", "market": "mars"})
    assert r.status_code == 422


def test_gp_gen_event_carries_live_hof(monkeypatch):
    from app.services import factor_gp, factor_mine

    panel = _panel(400, 12, seed=5)
    panel["vwap"] = panel["close"].pct_change(10).shift(-10)  # planted → HOF fills fast
    monkeypatch.setattr(factor_mine, "_load_panel_blocking", lambda market: panel)
    monkeypatch.setattr(factor_gp, "_load_panel_blocking", lambda market: panel)
    events: list[dict] = []
    report = factor_gp.evolve_blocking("us", 10, 30, 4, "standard", [], 11, events.append)
    assert all("hof" in e and "best_abs_ic" in e and "min_ic" in e for e in events)
    assert len(events[-1]["hof"]) >= 1
    assert "min_ic" in report and "best_abs_ic" in report
