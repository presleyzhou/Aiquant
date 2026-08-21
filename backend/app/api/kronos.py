"""Kronos K-line forecast endpoints.

Two execution modes, checked in order:

1. **Local inference** — torch is installed (dev box, Docker with the kronos
   extra): run the vendored model in-process in a worker thread.
2. **Remote proxy** — torch is absent but ``KRONOS_REMOTE_URL`` points at a
   Kronos-capable deployment of this same backend (HF Space / Fly / Railway).
   This is how the Vercel deployment serves real forecasts while staying
   under the serverless bundle cap. Proxying happens server-side, so the
   browser never deals with CORS or a second origin.

With neither available the endpoints degrade to a clear "disabled" status.
"""

from __future__ import annotations

import asyncio
import time

import httpx
from fastapi import APIRouter, HTTPException
from pydantic import BaseModel, Field

from app.config import get_settings
from app.services.datasource import market_data
from app.services.kronos_forecast import PRESETS, infer_market, kronos_service

router = APIRouter(prefix="/api/kronos", tags=["kronos"])

# Remote inference budget: a cold HF Space needs time to wake and (on the very
# first request after a rebuild) to load the checkpoint into memory.
_REMOTE_TIMEOUT = httpx.Timeout(connect=10.0, read=120.0, write=10.0, pool=10.0)

# Forecasts are sampled, so identical requests within a short window can share
# one result — this shields the free inference Space from repeat clicks.
_FORECAST_CACHE: dict[tuple, tuple[float, dict]] = {}
_FORECAST_TTL = 600.0
_FORECAST_CACHE_MAX = 64


class ForecastRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)
    horizon: int | None = Field(default=None, ge=5, le=60)
    market: str | None = None  # "us" | "crypto"; inferred from the symbol if absent
    interval: str = Field(default="1d", pattern="^(1d|1h)$")


class EvaluateRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)
    horizon: int = Field(default=14, ge=5, le=60)


class SignalRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)
    period: str = Field(default="2y")
    horizon: int = Field(default=14, ge=5, le=60)


def _remote_base() -> str | None:
    url = get_settings().kronos_remote_url
    return url.rstrip("/") if url else None


@router.get("/status")
async def kronos_status() -> dict:
    if kronos_service.enabled():
        return {**kronos_service.status(), "mode": "local"}

    remote = _remote_base()
    if not remote:
        return {**kronos_service.status(), "mode": "off"}

    try:
        async with httpx.AsyncClient(timeout=_REMOTE_TIMEOUT) as client:
            resp = await client.get(f"{remote}/api/kronos/status")
            resp.raise_for_status()
            body = resp.json()
    except Exception as exc:
        return {
            **kronos_service.status(),
            "mode": "remote",
            "enabled": False,
            "error": f"remote unreachable: {exc}",
        }
    body["mode"] = "remote"
    return body


@router.post("/forecast")
async def kronos_forecast(req: ForecastRequest) -> dict:
    key = (req.symbol.upper().strip(), req.market, req.horizon, req.interval)
    hit = _FORECAST_CACHE.get(key)
    if hit and time.time() - hit[0] < _FORECAST_TTL:
        return hit[1]

    if kronos_service.enabled():
        result = await _forecast_local(req)
    else:
        remote = _remote_base()
        if not remote:
            raise HTTPException(
                status_code=503,
                detail="Kronos is not enabled on this deployment (torch not installed).",
            )
        result = await _forecast_remote(remote, req)

    if len(_FORECAST_CACHE) >= _FORECAST_CACHE_MAX:
        _FORECAST_CACHE.pop(next(iter(_FORECAST_CACHE)))
    _FORECAST_CACHE[key] = (time.time(), result)
    return result


async def _forecast_local(req: ForecastRequest) -> dict:
    symbol = req.symbol.upper().strip()
    market = req.market if req.market in PRESETS else infer_market(symbol)
    horizon = req.horizon or PRESETS[market].default_horizon

    period = "1mo" if req.interval == "1h" else "2y"
    try:
        df = await market_data.history_frame(symbol, period=period, interval=req.interval)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc

    try:
        return await asyncio.to_thread(
            kronos_service.forecast_blocking, df, symbol, market, horizon, req.interval
        )
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=500, detail=f"Kronos inference failed: {exc}") from exc


async def _forecast_remote(remote: str, req: ForecastRequest) -> dict:
    payload = req.model_dump(exclude_none=True)
    try:
        async with httpx.AsyncClient(timeout=_REMOTE_TIMEOUT) as client:
            resp = await client.post(f"{remote}/api/kronos/forecast", json=payload)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Kronos remote unreachable: {exc}") from exc

    if resp.status_code != 200:
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    body = resp.json()
    # Version guard: an inference Space built before hourly support silently
    # ignores the interval field and would return a DAILY forecast mislabeled
    # as hourly. Refuse loudly instead.
    if req.interval != "1d" and body.get("interval") != req.interval:
        raise HTTPException(
            status_code=502,
            detail="the remote inference service predates hourly forecasts — "
            "Factory-rebuild the HF Space to update it",
        )
    return body


@router.post("/evaluate")
async def kronos_evaluate(req: EvaluateRequest) -> dict:
    """Rolling honest evaluation: weekly historical forecasts vs what happened."""
    symbol = req.symbol.upper().strip()

    if kronos_service.enabled():
        market = infer_market(symbol)
        try:
            df = await market_data.history_frame(symbol, period="5y", interval="1d")
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        try:
            return await asyncio.to_thread(
                kronos_service.evaluate_blocking, df, symbol, market, req.horizon
            )
        except LookupError as exc:
            raise HTTPException(status_code=404, detail=str(exc)) from exc
        except Exception as exc:
            raise HTTPException(status_code=500, detail=f"Kronos evaluation failed: {exc}") from exc

    remote = _remote_base()
    if remote:
        return await _proxy_post(remote, "/api/kronos/evaluate", req.model_dump())

    raise HTTPException(status_code=503, detail="Kronos is not enabled on this deployment.")


@router.post("/signal")
async def kronos_signal(req: SignalRequest) -> dict:
    """Long/flat anchors for the kronos_signal backtest strategy."""
    symbol = req.symbol.upper().strip()
    points = await signal_points(symbol, req.period, req.horizon)
    return {"symbol": symbol, "period": req.period, "horizon": req.horizon, "points": points}


async def signal_points(symbol: str, period: str, horizon: int, df=None) -> list[dict]:
    """Kronos signal anchors — local inference, or the remote service when
    torch is absent. Shared by the endpoint above, the analytics backtest and
    the strategy-lab tools."""
    if kronos_service.enabled():
        if df is None:
            try:
                df = await market_data.history_frame(symbol, period, "1d")
            except LookupError as exc:
                raise HTTPException(status_code=404, detail=str(exc)) from exc
        market = infer_market(symbol)
        try:
            return await asyncio.to_thread(
                kronos_service.signal_points_blocking, df, market, horizon
            )
        except LookupError as exc:
            raise HTTPException(status_code=400, detail=str(exc)) from exc

    remote = _remote_base()
    if remote:
        body = await _proxy_post(
            remote, "/api/kronos/signal", {"symbol": symbol, "period": period, "horizon": horizon}
        )
        return body["points"]

    raise HTTPException(
        status_code=503,
        detail="kronos_signal needs Kronos inference (torch locally, or KRONOS_REMOTE_URL).",
    )


async def _proxy_post(remote: str, path: str, payload: dict) -> dict:
    try:
        async with httpx.AsyncClient(timeout=_REMOTE_TIMEOUT) as client:
            resp = await client.post(f"{remote}{path}", json=payload)
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"Kronos remote unreachable: {exc}") from exc
    if resp.status_code != 200:
        try:
            detail = resp.json().get("detail", resp.text)
        except Exception:
            detail = resp.text
        raise HTTPException(status_code=resp.status_code, detail=detail)
    return resp.json()
