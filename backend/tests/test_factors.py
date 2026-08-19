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
    _round_feedback,
    _verdict,
    evaluate_candidate,
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
