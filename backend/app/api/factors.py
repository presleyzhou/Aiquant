"""Loop-engineered factor mining endpoints (NDJSON streaming)."""

from __future__ import annotations

import json
import logging

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services.factor_mine import UNIVERSES, mine_stream

log = logging.getLogger("aiquant.factors")

router = APIRouter(prefix="/api/factors", tags=["factors"])


class MineRequest(BaseModel):
    market: str = Field("us", description="us | crypto")
    horizon: int = Field(10, ge=1, le=30, description="forward-return horizon, bars")
    rounds: int = Field(3, ge=1, le=6)
    per_round: int = Field(4, ge=2, le=6)


@router.get("/config")
async def factors_config() -> dict:
    return {
        "universes": {k: v for k, v in UNIVERSES.items()},
        "defaults": {"horizon": 10, "rounds": 3, "per_round": 4},
    }


@router.post("/mine")
async def mine(req: MineRequest) -> StreamingResponse:
    async def generate():
        try:
            async for event in mine_stream(req.market, req.horizon, req.rounds, req.per_round):
                yield json.dumps(event, default=str) + "\n"
        except Exception as exc:
            log.exception("factor mining stream failed")
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
