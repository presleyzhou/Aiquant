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


def resolve_interval(period: str) -> str:
    """The bar size the candle endpoint would pick for this window."""
    return _PERIOD_TO_INTERVAL.get(period, "1d")


class _HeadlessApp:
    """Stand-in for the DearPyGui app object the upstream manager expects.

    `tabs` is empty on purpose: `get_settings_manager()` iterates it looking for a
    Settings tab, finds nothing, logs a debug line and returns None. The manager
    then uses its `default_sources` mapping, which is what we want headless.
    """

    tabs: dict[str, Any] = {}


_HISTORY_CACHE_MAX = 64
_QUOTE_CACHE_MAX = 256
_FAIL_CACHE_SECONDS = 60.0


def _evict_oldest(cache: dict, limit: int) -> None:
    while len(cache) > limit:
        cache.pop(next(iter(cache)))


class MarketDataService:
    def __init__(self) -> None:
        self._settings = get_settings()
        self._manager = None
        self._quote_cache: dict[str, tuple[float, dict]] = {}
        self._quote_fail_cache: dict[str, tuple[float, str]] = {}
        self._lock = asyncio.Lock()
        # History frames are shared read-only by candles, indicators, backtests
        # and the AI tool loop — the strategy lab alone runs ~10 backtests over
        # the same (symbol, period), so one upstream fetch has to serve all of
        # them. In-flight tasks are tracked so concurrent identical requests
        # (chart mount fires candles + overlays together) collapse to one fetch.
        self._history_cache: dict[tuple[str, str, str], tuple[float, pd.DataFrame]] = {}
        self._history_inflight: dict[tuple[str, str, str], asyncio.Task] = {}
        self._history_lock = asyncio.Lock()

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
            failed = self._quote_fail_cache.get(symbol)
            if failed and now - failed[0] < _FAIL_CACHE_SECONDS:
                raise LookupError(failed[1])

        try:
            data = await asyncio.to_thread(self._fetch_quote_blocking, symbol)
        except LookupError as exc:
            # Negative cache: a delisted/typo'd ticker left in a watchlist would
            # otherwise hit the upstream on every 5s WS push, forever.
            async with self._lock:
                self._quote_fail_cache[symbol] = (now, str(exc))
            raise

        async with self._lock:
            self._quote_cache[symbol] = (now, data)
            _evict_oldest(self._quote_cache, _QUOTE_CACHE_MAX)
        return data

    def _fetch_quote_blocking(self, symbol: str) -> dict:
        ticker = yf.Ticker(symbol)
        # 5d, not 2d: over a weekend or holiday a 2-day window holds a single
        # session, which silently zeroed the daily change (prev == last).
        hist = ticker.history(period="5d", interval="1d")

        info: dict[str, Any] = {}
        try:
            info = ticker.fast_info or {}
        except Exception:  # fast_info is flaky for some tickers
            pass

        return self._quote_from_history(symbol, hist, info)

    def _quote_from_history(self, symbol: str, hist: pd.DataFrame, info: dict[str, Any]) -> dict:
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
        """Quotes for a watchlist: cache hits are served, the misses go out as
        ONE batched download instead of a request per symbol."""
        wanted = [s.upper().strip() for s in symbols if s.strip()]
        now = datetime.now(timezone.utc).timestamp()

        ready: dict[str, dict] = {}
        async with self._lock:
            for sym in set(wanted):
                cached = self._quote_cache.get(sym)
                if cached and now - cached[0] < self._settings.quote_cache_seconds:
                    ready[sym] = cached[1]
                    continue
                failed = self._quote_fail_cache.get(sym)
                if failed and now - failed[0] < _FAIL_CACHE_SECONDS:
                    ready[sym] = {"symbol": sym, "error": failed[1]}

        misses = [s for s in dict.fromkeys(wanted) if s not in ready]
        if len(misses) == 1:
            try:
                ready[misses[0]] = await self.quote(misses[0])
            except Exception as exc:
                ready[misses[0]] = {"symbol": misses[0], "error": str(exc)}
        elif misses:
            fetched = await asyncio.to_thread(self._fetch_quotes_blocking, misses)
            stamp = datetime.now(timezone.utc).timestamp()
            async with self._lock:
                for sym, res in fetched.items():
                    if isinstance(res, Exception):
                        ready[sym] = {"symbol": sym, "error": str(res)}
                        if isinstance(res, LookupError):
                            self._quote_fail_cache[sym] = (stamp, str(res))
                    else:
                        ready[sym] = res
                        self._quote_cache[sym] = (stamp, res)
                _evict_oldest(self._quote_cache, _QUOTE_CACHE_MAX)
                _evict_oldest(self._quote_fail_cache, _QUOTE_CACHE_MAX)

        return [ready.get(sym, {"symbol": sym, "error": "no data"}) for sym in wanted]

    def _fetch_quotes_blocking(self, symbols: list[str]) -> dict[str, dict | Exception]:
        """One yf.download round-trip for the whole batch.

        The per-symbol path additionally reads `fast_info`; skipping it here
        loses only the `currency` field (unused by the UI — day high/low come
        from today's daily bar either way) and saves an HTTP call per symbol.
        """
        try:
            frame = yf.download(
                symbols,
                period="5d",
                interval="1d",
                group_by="ticker",
                auto_adjust=True,
                threads=True,
                progress=False,
            )
        except Exception as exc:
            log.warning("batch quote download failed (%s); falling back per-symbol", exc)
            out: dict[str, dict | Exception] = {}
            for sym in symbols:
                try:
                    out[sym] = self._fetch_quote_blocking(sym)
                except Exception as sym_exc:
                    out[sym] = sym_exc
            return out

        results: dict[str, dict | Exception] = {}
        for sym in symbols:
            try:
                hist = frame[sym] if isinstance(frame.columns, pd.MultiIndex) else frame
                results[sym] = self._quote_from_history(sym, hist, {})
            except Exception as exc:
                results[sym] = exc if isinstance(exc, LookupError) else LookupError(
                    f"no market data for symbol {sym!r}"
                )
        return results

    # ------------------------------------------------------------------- candles

    async def candles(self, symbol: str, period: str = "6mo", interval: str | None = None) -> dict:
        symbol = symbol.upper().strip()
        interval = interval or resolve_interval(period)
        df = await self.history_frame(symbol, period, interval)
        return {
            "symbol": symbol,
            "period": period,
            "interval": interval,
            "candles": _df_to_candles(df),
        }

    def _fetch_history_blocking(self, symbol: str, period: str, interval: str) -> pd.DataFrame:
        df = yf.Ticker(symbol).history(period=period, interval=interval)
        if df.empty:
            raise LookupError(f"no history for {symbol!r} (period={period}, interval={interval})")
        # yfinance can hand back rows with NaN OHLC at the edges of a window
        # (stale first bar, in-progress last bar). A single NaN poisons every
        # downstream rolling stat, so drop those rows before anyone sees them.
        df = df.dropna(subset=["Open", "High", "Low", "Close"])
        if df.empty:
            raise LookupError(f"history for {symbol!r} contained no usable bars")
        return df

    async def history_frame(self, symbol: str, period: str, interval: str = "1d") -> pd.DataFrame:
        """Raw OHLCV frame — used by candles, indicators and backtests.

        Cached with a TTL and deduplicated in flight. The returned frame is
        shared between callers, so treat it as read-only (every consumer in
        this codebase only derives new series from it).
        """
        key = (symbol.upper().strip(), period, interval)
        now = datetime.now(timezone.utc).timestamp()

        async with self._history_lock:
            hit = self._history_cache.get(key)
            if hit and now - hit[0] < self._settings.history_cache_seconds:
                return hit[1]
            task = self._history_inflight.get(key)
            if task is None:
                task = asyncio.create_task(asyncio.to_thread(self._fetch_history_blocking, *key))
                self._history_inflight[key] = task

        try:
            df = await asyncio.shield(task)
        finally:
            async with self._history_lock:
                self._history_inflight.pop(key, None)

        async with self._history_lock:
            self._history_cache.pop(key, None)  # re-insert at the end: eviction is oldest-first
            self._history_cache[key] = (datetime.now(timezone.utc).timestamp(), df)
            _evict_oldest(self._history_cache, _HISTORY_CACHE_MAX)
        return df

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
    times = (df.index.astype("int64") // 1_000_000_000).tolist()
    opens = df["Open"].round(4).tolist()
    highs = df["High"].round(4).tolist()
    lows = df["Low"].round(4).tolist()
    closes = df["Close"].round(4).tolist()
    if "Volume" in df.columns:
        volumes = df["Volume"].fillna(0).astype("int64").tolist()
    else:
        volumes = [0] * len(df)
    return [
        {"time": t, "open": o, "high": h, "low": l, "close": c, "volume": v}
        for t, o, h, l, c, v in zip(times, opens, highs, lows, closes, volumes)
    ]


market_data = MarketDataService()
