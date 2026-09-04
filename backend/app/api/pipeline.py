"""End-to-end quant pipeline: signal → portfolio construction → backtest →
risk/attribution → target weights. Deterministic, no LLM, no rate limit."""

from __future__ import annotations

import asyncio
import logging

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services import factor_dsl
from app.services.pipeline import config as pipeline_config
from app.services.pipeline import run_pipeline_blocking

log = logging.getLogger("aiquant.pipeline")

router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])


class PipelineFactor(BaseModel):
    expression: str = Field(min_length=1, max_length=240)
    invert: bool = False
    horizon: int = Field(10, ge=1, le=30)


class PipelineRequest(BaseModel):
    market: str = Field("us", pattern="^(us|crypto)$")
    factors: list[PipelineFactor] = Field(min_length=1, max_length=8)
    signal_weighting: str = Field("ic", pattern="^(ic|equal)$")
    scheme: str = Field("inverse_vol", pattern="^(equal|score|inverse_vol|min_variance|risk_parity)$")
    top_n: int = Field(8, ge=2, le=20)
    rebalance: int = Field(10, ge=1, le=30)
    max_weight: float = Field(0.25, ge=0.05, le=1.0)
    cost_bps: float = Field(7.0, ge=0, le=50)
    target_vol_pct: float | None = Field(None, ge=0, le=40, description="annualised %; null or 0 = off")
    vol_lookback: int = Field(60, ge=20, le=120)
    compare: bool = True


@router.get("/config")
async def get_config() -> dict:
    return pipeline_config()


@router.post("/run")
async def run(req: PipelineRequest) -> dict:
    try:
        return await asyncio.to_thread(run_pipeline_blocking, req.model_dump())
    except factor_dsl.FactorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
