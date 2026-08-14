from fastapi import APIRouter, HTTPException, Query, Response

from app.services.datasource import market_data

router = APIRouter(prefix="/api/market", tags=["market"])

# Candles/indicators change at bar granularity, not per request: let the browser
# (and any CDN in front) reuse a response while the user flips chart settings
# back and forth instead of re-entering the whole fetch path each time.
CACHE_HEADER = "public, max-age=60"


@router.get("/quote/{symbol}")
async def get_quote(symbol: str):
    try:
        return await market_data.quote(symbol)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"upstream data error: {exc}") from exc


@router.get("/quotes")
async def get_quotes(symbols: str = Query(..., description="Comma-separated tickers")):
    tickers = [s.strip() for s in symbols.split(",") if s.strip()][:25]
    if not tickers:
        raise HTTPException(status_code=400, detail="no symbols supplied")
    return {"quotes": await market_data.quotes(tickers)}


@router.get("/candles/{symbol}")
async def get_candles(
    symbol: str,
    response: Response,
    period: str = Query("6mo", description="1d 5d 1mo 3mo 6mo 1y 2y 5y max"),
    interval: str | None = Query(None, description="Override the auto-selected bar size"),
):
    try:
        response.headers["Cache-Control"] = CACHE_HEADER
        return await market_data.candles(symbol, period=period, interval=interval)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"upstream data error: {exc}") from exc


@router.get("/news")
async def get_news(category: str = "financial", limit: int = Query(20, ge=1, le=100)):
    return await market_data.news(category=category, limit=limit)


@router.get("/sources")
async def get_sources():
    """Health of the vendored fincept data layer and its current source mapping."""
    return market_data.source_health()
