"""Kronos K-line forecast endpoints.

POST /api/kronos/forecast is CPU/GPU-bound for a few seconds, so the actual
inference runs in a worker thread; the service serializes runs internally.
"""

from __future__ import annotations

import asyncio

from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.services.datasource import market_data
from app.services.kronos_forecast import PRESETS, infer_market, kronos_service

router = APIRouter(prefix="/api/kronos", tags=["kronos"])


class ForecastRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)
    horizon: int | None = Field(default=None, ge=5, le=60)
    market: str | None = None  # "us" | "crypto"; inferred from the symbol if absent


@router.get("/status")
async def kronos_status() -> dict:
    return kronos_service.status()


@router.post("/forecast")
async def kronos_forecast(req: ForecastRequest) -> dict:
    if not kronos_service.enabled():
        raise HTTPException(
            status_code=503,
            detail="Kronos is not enabled on this deployment (torch not installed).",
        )

    symbol = req.symbol.upper().strip()
    market = req.market if req.market in PRESETS else infer_market(symbol)
    horizon = req.horizon or PRESETS[market].default_horizon

    try:
        df = await market_data.history_frame(symbol, period="2y", interval="1d")
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        return await asyncio.to_thread(
            kronos_service.forecast_blocking, df, symbol, market, horizon
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Kronos inference failed: {exc}") from exc
