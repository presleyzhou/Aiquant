"""Adapter over the vendored fincept-terminal data layer.

`DataSourceManager` was written to be constructed with the DearPyGui application
object. It only ever touches `self.app` inside `get_settings_manager()`, and every
access there is `hasattr`-guarded, so a minimal stub is enough — the manager falls
back to its default source mapping (yfinance for equities/indices/options) instead
of reading credentials out of a Settings tab.

Everything the manager returns is normalised here into flat dicts the API layer can
serialise, so no upstream response shape leaks into the HTTP contract.
"""

from __future__ import annotations

import asyncio
import logging
from datetime import datetime, timezone
from typing import Any

import pandas as pd
import yfinance as yf

from app.config import get_settings

log = logging.getLogger(__name__)

_PERIOD_TO_INTERVAL = {
    "1d": "5m",
    "5d": "15m",
    "1mo": "1h",
    "3mo": "1d",
    "6mo": "1d",
    "1y": "1d",
    "2y": "1d",
    "5y": "1wk",
    "max": "1mo",
}


class _HeadlessApp:
    """Stand-in for the DearPyGui app object the upstream manager expects.

    `tabs` is empty on purpose: `get_settings_manager()` iterates it looking for a
    Settings tab, finds nothing, logs a debug line and returns None. The manager
    then uses its `default_sources` mapping, which is what we want headless.
    """

    tabs: dict[str, Any] = {}


class MarketDataService:
    def __init__(self) -> None:
        self._settings = get_settings()
        self._manager = None
        self._quote_cache: dict[str, tuple[float, dict]] = {}
        self._lock = asyncio.Lock()

    # ------------------------------------------------------------------ manager

    @property
    def manager(self):
        """Lazily build the vendored manager.

        Import is deferred: it pulls in yfinance and the upstream logger, and we
        do not want that cost (or a hard failure) at module import time.
        """
        if self._manager is None:
            try:
                from fincept_terminal.DatabaseConnector.DataSources.data_source_manager import (
                    DataSourceManager,
                )

                self._manager = DataSourceManager(_HeadlessApp())
                log.info("vendored DataSourceManager initialised")
            except Exception:
                log.exception("DataSourceManager unavailable; using direct yfinance path")
                self._manager = False  # sentinel: tried and failed, don't retry
        return self._manager or None

    def source_health(self) -> dict:
        """Expose the vendored manager's own health check, plus our fallback state."""
        mgr = self.manager
        if mgr is None:
            return {"vendored_manager": "unavailable", "fallback": "yfinance-direct"}
        try:
            return {
                "vendored_manager": "ok",
                "mappings": mgr.get_current_mappings(),
                "cache": mgr.get_cache_stats(),
            }
        except Exception as exc:
            return {"vendored_manager": "degraded", "error": str(exc)}

    # ------------------------------------------------------------------- quotes

    async def quote(self, symbol: str) -> dict:
        symbol = symbol.upper().strip()
        now = datetime.now(timezone.utc).timestamp()

        async with self._lock:
            cached = self._quote_cache.get(symbol)
            if cached and now - cached[0] < self._settings.quote_cache_seconds:
                return cached[1]

        data = await asyncio.to_thread(self._fetch_quote_blocking, symbol)

        async with self._lock:
            self._quote_cache[symbol] = (now, data)
        return data

    def _fetch_quote_blocking(self, symbol: str) -> dict:
        ticker = yf.Ticker(symbol)
        hist = ticker.history(period="2d", interval="1d")
        # Off-hours, yfinance can return a trailing row of NaNs. float(nan)
        # survives every arithmetic step below and json.dumps then emits the
        # literal `NaN` — invalid JSON that kills the client's parser. Drop
        # the poison rows before any number leaves this function.
        hist = hist.dropna(subset=["Close"])
        if hist.empty:
            raise LookupError(f"no market data for symbol {symbol!r}")

        last = float(hist["Close"].iloc[-1])
        prev = float(hist["Close"].iloc[-2]) if len(hist) > 1 else last
        change = last - prev
        pct = (change / prev * 100) if prev else 0.0

        info: dict[str, Any] = {}
        try:
            info = ticker.fast_info or {}
        except Exception:  # fast_info is flaky for some tickers
            pass

        return {
            "symbol": symbol,
            "price": round(last, 4),
            "change": round(change, 4),
            "change_pct": round(pct, 3),
            "previous_close": round(prev, 4),
            "day_high": _safe_float(info.get("day_high")) or round(float(hist["High"].iloc[-1]), 4),
            "day_low": _safe_float(info.get("day_low")) or round(float(hist["Low"].iloc[-1]), 4),
            "volume": (
                int(hist["Volume"].iloc[-1])
                if "Volume" in hist and not pd.isna(hist["Volume"].iloc[-1])
                else None
            ),
            "currency": info.get("currency"),
            "as_of": datetime.now(timezone.utc).isoformat(),
        }

    async def quotes(self, symbols: list[str]) -> list[dict]:
        results = await asyncio.gather(
            *(self.quote(s) for s in symbols), return_exceptions=True
        )
        out = []
        for sym, res in zip(symbols, results):
            if isinstance(res, Exception):
                out.append({"symbol": sym.upper(), "error": str(res)})
            else:
                out.append(res)
        return out

    # ------------------------------------------------------------------- candles

    async def candles(self, symbol: str, period: str = "6mo", interval: str | None = None) -> dict:
        symbol = symbol.upper().strip()
        interval = interval or _PERIOD_TO_INTERVAL.get(period, "1d")
        df = await asyncio.to_thread(self._fetch_history_blocking, symbol, period, interval)
        return {
            "symbol": symbol,
            "period": period,
            "interval": interval,
            "candles": _df_to_candles(df),
        }

    def _fetch_history_blocking(self, symbol: str, period: str, interval: str) -> pd.DataFrame:
        from app.services import disk_cache

        # 30 minutes is far fresher than daily bars change, and it absorbs the
        # repeat fetches from backtests/indicators/Kronos on the same symbol.
        cache_key = f"hist-{symbol}-{period}-{interval}"
        cached = disk_cache.load(cache_key, ttl_seconds=1800)
        if isinstance(cached, pd.DataFrame) and not cached.empty:
            return cached

        df = yf.Ticker(symbol).history(period=period, interval=interval)
        if df.empty:
            raise LookupError(f"no history for {symbol!r} (period={period}, interval={interval})")
        # yfinance can hand back rows with NaN OHLC at the edges of a window
        # (stale first bar, in-progress last bar). A single NaN poisons every
        # downstream rolling stat, so drop those rows before anyone sees them.
        df = df.dropna(subset=["Open", "High", "Low", "Close"])
        if df.empty:
            raise LookupError(f"history for {symbol!r} contained no usable bars")
        disk_cache.store(cache_key, df)
        return df

    async def history_frame(self, symbol: str, period: str, interval: str = "1d") -> pd.DataFrame:
        """Raw OHLCV frame — used by the indicator and backtest services."""
        return await asyncio.to_thread(
            self._fetch_history_blocking, symbol.upper().strip(), period, interval
        )

    # --------------------------------------------------------------------- news

    async def news(self, category: str = "financial", limit: int = 20) -> dict:
        mgr = self.manager
        if mgr is None:
            return {"source": "unavailable", "items": []}
        payload = await asyncio.to_thread(mgr.get_news_data, category, limit)
        return {
            "source": payload.get("source", "unknown"),
            "items": payload.get("data", payload.get("news", [])) or [],
        }


def _safe_float(value: Any) -> float | None:
    try:
        return round(float(value), 4)
    except (TypeError, ValueError):
        return None


def _df_to_candles(df: pd.DataFrame) -> list[dict]:
    out = []
    for ts, row in df.iterrows():
        out.append(
            {
                "time": int(pd.Timestamp(ts).timestamp()),
                "open": round(float(row["Open"]), 4),
                "high": round(float(row["High"]), 4),
                "low": round(float(row["Low"]), 4),
                "close": round(float(row["Close"]), 4),
                "volume": int(row["Volume"]) if "Volume" in row and not pd.isna(row["Volume"]) else 0,
            }
        )
    return out


market_data = MarketDataService()
