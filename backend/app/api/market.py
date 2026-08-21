import asyncio

from fastapi import APIRouter, HTTPException, Query

from app.services import symbol_search
from app.services.datasource import market_data

router = APIRouter(prefix="/api/market", tags=["market"])


@router.get("/search")
async def search_symbols(
    q: str = Query(..., min_length=1, max_length=40),
    limit: int = Query(8, ge=1, le=20),
):
    """Fuzzy symbol lookup: curated CN/US name dictionary (instant, supports
    Chinese names and pinyin initials) merged with Yahoo's search API."""
    local = symbol_search.search_local(q, limit)
    remote = await asyncio.to_thread(symbol_search.search_remote, q, limit)
    return {"query": q, "results": symbol_search.merge_results(local, remote, limit)}


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
    period: str = Query("6mo", description="1d 5d 1mo 3mo 6mo 1y 2y 5y max"),
    interval: str | None = Query(None, description="Override the auto-selected bar size"),
):
    try:
        return await market_data.candles(symbol, period=period, interval=interval)
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"upstream data error: {exc}") from exc


@router.get("/news")
async def get_news(category: str = "financial", limit: int = Query(20, ge=1, le=100)):
    return await market_data.news(category=category, limit=limit)


@router.get("/news/{symbol}")
async def get_symbol_news(symbol: str, limit: int = Query(8, ge=1, le=15)):
    """Recent headlines for one symbol (yfinance), disk-cached 15 minutes."""
    import asyncio

    from app.services.symbol_news import fetch_symbol_news

    symbol = symbol.upper().strip()
    articles = await asyncio.to_thread(fetch_symbol_news, symbol, limit)
    return {"symbol": symbol, "articles": articles}


@router.get("/sources")
async def get_sources():
    """Health of the vendored fincept data layer and its current source mapping."""
    return market_data.source_health()
