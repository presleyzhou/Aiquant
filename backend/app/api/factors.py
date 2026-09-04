"""Loop-engineered factor mining endpoints (NDJSON streaming)."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter, Depends

from app.services.ratelimit import limiter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import asyncio

from fastapi import HTTPException

from app.services import factor_dsl
from app.services.factor_gp import evolve_stream
from app.services.factor_mine import (
    MODES,
    UNIVERSES,
    analyze_factor_blocking,
    check_factor_blocking,
    composite_backtest_blocking,
    mine_stream,
    portfolio_backtest_blocking,
)

log = logging.getLogger("aiquant.factors")

router = APIRouter(prefix="/api/factors", tags=["factors"])


class MineMemory(BaseModel):
    """Cross-session state the client persists (localStorage) and replays."""

    accepted: list[str] = Field(default_factory=list, max_length=20)
    lessons: list[str] = Field(default_factory=list, max_length=12)


class MineRequest(BaseModel):
    market: str = Field("us", pattern="^(us|crypto)$")
    horizon: int = Field(10, ge=1, le=30, description="forward-return horizon, bars")
    rounds: int = Field(3, ge=1, le=6)
    per_round: int = Field(4, ge=2, le=6)
    mode: str = Field("standard", description="strict | standard | loose")
    memory: MineMemory | None = None


class FactorBacktestRequest(BaseModel):
    expression: str = Field(min_length=1, max_length=240)
    market: str = Field("us", pattern="^(us|crypto)$")
    top_n: int = Field(5, ge=2, le=10)
    rebalance: int = Field(10, ge=1, le=30)
    invert: bool = False


class CompositeFactor(BaseModel):
    expression: str = Field(min_length=1, max_length=240)
    invert: bool = False
    horizon: int = Field(10, ge=1, le=30)


class CompositeRequest(BaseModel):
    factors: list[CompositeFactor] = Field(min_length=2, max_length=8)
    market: str = Field("us", pattern="^(us|crypto)$")
    weighting: str = Field("ic", description="ic | equal")
    top_n: int = Field(5, ge=2, le=10)
    rebalance: int = Field(10, ge=1, le=30)


class EvolveRequest(BaseModel):
    market: str = Field("us", pattern="^(us|crypto)$")
    horizon: int = Field(10, ge=1, le=30)
    population: int = Field(40, ge=20, le=80)
    generations: int = Field(15, ge=3, le=40)
    mode: str = Field("standard")
    seeds: list[str] = Field(default_factory=list, max_length=10)  # warm-start zoo factors
    seed: int | None = Field(default=None, description="RNG seed for reproducibility")
    objective: str = Field("multi", pattern="^(ic|multi)$")


class ExplainRequest(BaseModel):
    expression: str = Field(min_length=1, max_length=240)
    market: str = Field("us", pattern="^(us|crypto)$")


class CheckRequest(BaseModel):
    expression: str = Field(min_length=1, max_length=240)
    market: str = Field("us", pattern="^(us|crypto)$")
    horizon: int = Field(10, ge=1, le=30)


@router.get("/config")
async def factors_config() -> dict:
    return {
        "universes": {k: v for k, v in UNIVERSES.items()},
        "defaults": {"horizon": 10, "rounds": 3, "per_round": 4, "mode": "standard"},
        "modes": {k: {"min_ic": v[0], "min_icir": v[1]} for k, v in MODES.items()},
    }


@router.post(
    "/mine",
    dependencies=[Depends(limiter("mining", "rl_mining_per_day", 86_400, global_attr="rl_global_ai_per_day"))],
)
async def mine(req: MineRequest) -> StreamingResponse:
    async def generate():
        try:
            memory = req.memory.model_dump() if req.memory else None
            async for event in mine_stream(
                req.market, req.horizon, req.rounds, req.per_round, req.mode, memory
            ):
                yield json.dumps(event, default=str) + "\n"
        except Exception as exc:
            log.exception("factor mining stream failed")
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post("/backtest")
async def factor_backtest(req: FactorBacktestRequest) -> dict:
    """Judge an accepted factor with money: top-N equal-weight portfolio,
    rebalanced on the factor, costs included, vs equal-weight buy-and-hold."""
    try:
        return await asyncio.to_thread(
            portfolio_backtest_blocking,
            req.expression,
            req.market,
            req.top_n,
            req.rebalance,
            req.invert,
        )
    except factor_dsl.FactorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/composite")
async def factor_composite(req: CompositeRequest) -> dict:
    """Blend 2-8 zoo factors into one meta-signal and portfolio-test it."""
    try:
        return await asyncio.to_thread(
            composite_backtest_blocking,
            [f.model_dump() for f in req.factors],
            req.market,
            req.weighting,
            req.top_n,
            req.rebalance,
        )
    except factor_dsl.FactorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post("/check")
async def factor_check(req: CheckRequest) -> dict:
    """Health/robustness check: recent rolling IC (decay monitor) or the same
    factor evaluated on the OTHER market (cross-market transfer test)."""
    try:
        return await asyncio.to_thread(
            check_factor_blocking, req.expression, req.market, req.horizon
        )
    except factor_dsl.FactorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@router.post(
    "/evolve",
    dependencies=[Depends(limiter("evolve", "rl_evolve_per_day", 86_400))],
)
async def evolve(req: EvolveRequest) -> StreamingResponse:
    """Genetic-programming factor evolution — no LLM involved, streams one
    event per generation (champion IC + portfolio stats) then the hall of
    fame with holdout verdicts."""

    async def generate():
        try:
            async for event in evolve_stream(
                req.market, req.horizon, req.population, req.generations, req.mode,
                [s[:240] for s in req.seeds], req.seed, req.objective,
            ):
                yield json.dumps(event, default=str) + "\n"
        except Exception as exc:
            log.exception("factor evolution stream failed")
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


EXPLAIN_TOOL = {
    "name": "submit_explanation",
    "description": "Deliver the plain-language reading of a factor expression.",
    "input_schema": {
        "type": "object",
        "properties": {
            "meaning": {"type": "string", "description": "两句中文：这个表达式在衡量什么、为什么可能与未来收益相关。"},
            "style": {"type": "string", "enum": ["momentum", "reversal", "volatility", "volume", "liquidity", "range", "mixed"]},
            "caveat": {"type": "string", "description": "一句中文：最可能的失效场景或过拟合风险。"},
        },
        "required": ["meaning", "style", "caveat"],
    },
}


@router.post(
    "/explain",
    dependencies=[Depends(limiter("explain", "rl_explain_per_day", 86_400, global_attr="rl_global_ai_per_day"))],
)
async def explain_factor(req: ExplainRequest) -> dict:
    """Plain-language reading of a (GP- or LLM-mined) factor. Light model,
    cached 24h per expression — the interpretability layer for black-box GP."""
    from app.config import get_settings
    from app.services import disk_cache, usage
    from app.services.llm import analyst

    # validate the expression through the DSL first; never send garbage to the model
    try:
        factor_dsl.parse(req.expression)
    except factor_dsl.FactorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    if not analyst.enabled:
        raise HTTPException(status_code=503, detail="AI is not configured")

    key = f"explain-{req.market}-{req.expression}"
    cached = disk_cache.load(key, ttl_seconds=86_400)
    if isinstance(cached, dict):
        return {**cached, "cached": True}

    settings = get_settings()
    response = await analyst.client.messages.create(
        model=settings.claude_model_light,
        max_tokens=400,
        system=(
            "你是量化研究助手。给定一个截面因子表达式（DSL：字段 open/high/low/close/volume/"
            "returns/vwap；ts_* 为时序滚动算子，rank/zscore 为截面算子），用通俗中文解释它衡量什么、"
            "属于哪类风格、最可能的失效场景。只解释表达式本身，不编造回测数字。通过 submit_explanation 输出。"
        ),
        messages=[{"role": "user", "content": f"市场：{'加密货币' if req.market == 'crypto' else '美股'}\n因子：{req.expression}"}],
        tools=[EXPLAIN_TOOL],
        tool_choice={"type": "tool", "name": "submit_explanation"},
    )
    usage.record(settings.claude_model_light, getattr(response.usage, "input_tokens", 0), getattr(response.usage, "output_tokens", 0))
    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_explanation":
            result = {
                "expression": req.expression,
                "meaning": str(block.input.get("meaning", ""))[:500],
                "style": str(block.input.get("style", "mixed")),
                "caveat": str(block.input.get("caveat", ""))[:300],
            }
            disk_cache.store(key, result)
            return {**result, "cached": False}
    raise HTTPException(status_code=502, detail="model did not return an explanation")


class AnalyzeRequest(CheckRequest):
    top_n: int = Field(5, ge=2, le=20)
    cost_bps: float = Field(10.0, ge=0, le=100)


@router.post("/analyze")
async def factor_analyze(req: AnalyzeRequest) -> dict:
    """Practitioner report card: quantile spread, IC decay by horizon, turnover
    and cost-adjusted spread, walk-forward folds, bull/bear split, t-stat."""
    try:
        return await asyncio.to_thread(
            analyze_factor_blocking, req.expression, req.market, req.horizon, req.top_n, req.cost_bps
        )
    except factor_dsl.FactorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:  # noqa: BLE001 - surface the reason instead of a bare 500
        log.exception("factor report failed")
        raise HTTPException(status_code=500, detail=f"report failed: {type(exc).__name__}: {exc}") from exc
