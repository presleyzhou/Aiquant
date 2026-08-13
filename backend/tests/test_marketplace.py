"""Marketplace catalog invariants — offline, deterministic."""

import json

import pytest

from app.api.analytics import BacktestRequest
from app.services import marketplace


def test_catalog_ids_are_unique():
    ids = [item.id for item in marketplace.CATALOG]
    assert len(ids) == len(set(ids))


def test_every_item_serializes_to_json():
    for item in marketplace.list_items():
        json.dumps(item)


def test_type_filter_and_search():
    strategies = marketplace.list_items(item_type="strategy")
    assert strategies and all(i["type"] == "strategy" for i in strategies)

    hits = marketplace.list_items(query="rsi")
    assert any(i["id"] == "connors-rsi2" for i in hits)

    assert marketplace.list_items(query="绝不可能匹配到的词xyz") == []


def test_strategy_presets_are_valid_backtest_requests():
    """Every strategy's payload must be accepted verbatim by the backtest API —
    otherwise "install and run" is a lie."""
    for item in marketplace.list_items(item_type="strategy"):
        payload = item["integration"]["backtest"]
        req = BacktestRequest(symbol="SPY", **payload)
        assert req.strategy == payload["strategy"]


def test_skills_carry_symbol_placeholder():
    for item in marketplace.list_items(item_type="skill"):
        template = item["integration"]["prompt_template"]
        assert "{symbol}" in template


def test_data_items_report_live_status():
    for item in marketplace.list_items(item_type="data"):
        assert item["status"]["state"] in {
            "active",
            "ready",
            "key_required",
            "available",
            "planned",
            "unavailable",
        }
    # Vendored providers were verified importable earlier in the project;
    # regression-check they still are.
    by_id = {i["id"]: i for i in marketplace.list_items(item_type="data")}
    assert by_id["yfinance"]["status"]["state"] == "active"
    assert by_id["imf-data"]["status"]["state"] == "available"
    assert by_id["oecd-data"]["status"]["state"] == "available"


def test_unknown_item_returns_none():
    assert marketplace.get_item("does-not-exist") is None


def test_rsi_params_flow_into_config():
    """The Connors preset needs these to survive the API boundary."""
    req = BacktestRequest(symbol="SPY", strategy="rsi_reversion", rsi_period=2,
                          rsi_oversold=10, rsi_overbought=65)
    assert (req.rsi_period, req.rsi_oversold, req.rsi_overbought) == (2, 10, 65)
    with pytest.raises(ValueError):
        BacktestRequest(symbol="SPY", rsi_period=1)  # below ge=2
