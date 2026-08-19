"""Loop-engineered factor mining endpoints (NDJSON streaming)."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

import asyncio

from fastapi import HTTPException

from app.services import factor_dsl
from app.services.factor_mine import (
    MODES,
    UNIVERSES,
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
    market: str = Field("us", description="us | crypto")
    horizon: int = Field(10, ge=1, le=30, description="forward-return horizon, bars")
    rounds: int = Field(3, ge=1, le=6)
    per_round: int = Field(4, ge=2, le=6)
    mode: str = Field("standard", description="strict | standard | loose")
    memory: MineMemory | None = None


class FactorBacktestRequest(BaseModel):
    expression: str = Field(min_length=1, max_length=240)
    market: str = Field("us")
    top_n: int = Field(5, ge=2, le=10)
    rebalance: int = Field(10, ge=1, le=30)
    invert: bool = False


@router.get("/config")
async def factors_config() -> dict:
    return {
        "universes": {k: v for k, v in UNIVERSES.items()},
        "defaults": {"horizon": 10, "rounds": 3, "per_round": 4, "mode": "standard"},
        "modes": {k: {"min_ic": v[0], "min_icir": v[1]} for k, v in MODES.items()},
    }


@router.post("/mine")
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
