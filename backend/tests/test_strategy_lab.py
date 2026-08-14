"""Strategy-lab invariants — offline; the delivery tool must be a real gate."""

import pytest

from app.api.ai import OBJECTIVE_LABELS, StrategyRequest, build_strategy_prompt
from app.services.llm import PROPOSE_STRATEGY_TOOL, STRATEGY_TOOLS, analyst, validate_proposal


def test_strategy_tools_extend_analyst_tools():
    names = [t["name"] for t in STRATEGY_TOOLS]
    assert "run_backtest" in names and "propose_strategy" in names
    assert names.count("propose_strategy") == 1
    # The delivery tool's schema must demand honesty fields.
    required = PROPOSE_STRATEGY_TOOL["input_schema"]["required"]
    assert {"rationale", "risks", "beats_buy_hold"} <= set(required)


def test_validate_proposal_accepts_runnable_params():
    assert (
        validate_proposal(
            {
                "symbol": "AAPL",
                "strategy": "ema_cross",
                "params": {"fast": 10, "slow": 40, "period": "5y"},
            }
        )
        is None
    )


def test_validate_proposal_rejects_inverted_cross():
    error = validate_proposal(
        {"symbol": "AAPL", "strategy": "sma_cross", "params": {"fast": 50, "slow": 20}}
    )
    assert error and "shorter" in error["error"]


def test_validate_proposal_rejects_contract_violations():
    error = validate_proposal(
        {"symbol": "AAPL", "strategy": "rsi_reversion", "params": {"rsi_period": 1}}
    )
    assert error and "validation" in error["error"]


async def test_propose_strategy_tool_routes_through_validation():
    bad = await analyst._run_tool(
        "propose_strategy",
        {"symbol": "SPY", "strategy": "ema_cross", "params": {"fast": 40, "slow": 10}},
    )
    assert "error" in bad

    good = await analyst._run_tool(
        "propose_strategy",
        {"symbol": "SPY", "strategy": "ema_cross", "params": {"fast": 12, "slow": 26, "period": "2y"}},
    )
    assert good.get("recorded") is True


def test_prompt_builder_covers_every_objective():
    for objective in OBJECTIVE_LABELS:
        req = StrategyRequest(symbol="600519.SS", objective=objective, notes="回撤别超过 25%")
        prompt = build_strategy_prompt(req)
        assert "600519.SS" in prompt
        assert OBJECTIVE_LABELS[objective] in prompt
        assert "回撤别超过 25%" in prompt


def test_strategy_request_rejects_junk():
    with pytest.raises(ValueError):
        StrategyRequest(symbol="AAPL", objective="yolo")
    with pytest.raises(ValueError):
        StrategyRequest(symbol="", objective="auto")
