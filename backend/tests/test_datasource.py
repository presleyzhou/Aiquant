"""Offline tests for the market data caching layer — no network."""

import asyncio

import pandas as pd
import pytest

from app.services.datasource import MarketDataService


def frame(n: int = 40) -> pd.DataFrame:
    index = pd.date_range("2024-01-01", periods=n, freq="B", tz="UTC")
    close = pd.Series([100.0 + i for i in range(n)], index=index)
    return pd.DataFrame(
        {
            "Open": close,
            "High": close * 1.01,
            "Low": close * 0.99,
            "Close": close,
            "Volume": pd.Series(1_000, index=index),
        }
    )


# ------------------------------------------------------------- history caching


async def test_history_frame_is_cached(monkeypatch):
    svc = MarketDataService()
    calls: list[tuple] = []

    def fake_fetch(symbol, period, interval):
        calls.append((symbol, period, interval))
        return frame()

    monkeypatch.setattr(svc, "_fetch_history_blocking", fake_fetch)

    first = await svc.history_frame("AAPL", "1y", "1d")
    second = await svc.history_frame("aapl", "1y", "1d")  # case-normalised key
    assert first is second
    assert calls == [("AAPL", "1y", "1d")]

    await svc.history_frame("AAPL", "2y", "1d")  # different window = new fetch
    assert len(calls) == 2


async def test_concurrent_history_requests_collapse_to_one_fetch(monkeypatch):
    svc = MarketDataService()
    calls = []

    def fake_fetch(symbol, period, interval):
        calls.append(symbol)
        return frame()

    monkeypatch.setattr(svc, "_fetch_history_blocking", fake_fetch)

    results = await asyncio.gather(*(svc.history_frame("MSFT", "6mo", "1d") for _ in range(5)))
    assert len(calls) == 1
    assert all(r is results[0] for r in results)


async def test_history_fetch_failure_is_not_cached(monkeypatch):
    svc = MarketDataService()
    attempts = {"n": 0}

    def flaky_fetch(symbol, period, interval):
        attempts["n"] += 1
        if attempts["n"] == 1:
            raise LookupError("no history")
        return frame()

    monkeypatch.setattr(svc, "_fetch_history_blocking", flaky_fetch)

    with pytest.raises(LookupError):
        await svc.history_frame("TSLA", "1y", "1d")
    df = await svc.history_frame("TSLA", "1y", "1d")  # retry must go upstream again
    assert attempts["n"] == 2
    assert not df.empty


# --------------------------------------------------------------- quote batching


async def test_quotes_batches_misses_and_serves_cache(monkeypatch):
    svc = MarketDataService()
    batch_calls: list[list[str]] = []

    def fake_batch(symbols):
        batch_calls.append(list(symbols))
        return {s: {"symbol": s, "price": 1.0} for s in symbols}

    monkeypatch.setattr(svc, "_fetch_quotes_blocking", fake_batch)

    out = await svc.quotes(["AAPL", "MSFT", "NVDA"])
    assert [q["symbol"] for q in out] == ["AAPL", "MSFT", "NVDA"]
    assert batch_calls == [["AAPL", "MSFT", "NVDA"]]

    # Second call inside the TTL is served entirely from cache.
    out = await svc.quotes(["AAPL", "MSFT", "NVDA"])
    assert len(batch_calls) == 1
    assert all("error" not in q for q in out)


async def test_quotes_reports_per_symbol_failures(monkeypatch):
    svc = MarketDataService()

    def fake_batch(symbols):
        return {
            s: LookupError(f"no market data for symbol {s!r}") if s == "BAD" else {"symbol": s}
            for s in symbols
        }

    monkeypatch.setattr(svc, "_fetch_quotes_blocking", fake_batch)

    out = await svc.quotes(["AAPL", "BAD"])
    by_symbol = {q["symbol"]: q for q in out}
    assert "error" not in by_symbol["AAPL"]
    assert "error" in by_symbol["BAD"]


async def test_failed_symbol_is_negative_cached(monkeypatch):
    svc = MarketDataService()
    attempts = {"n": 0}

    def always_missing(symbol):
        attempts["n"] += 1
        raise LookupError(f"no market data for symbol {symbol!r}")

    monkeypatch.setattr(svc, "_fetch_quote_blocking", always_missing)

    with pytest.raises(LookupError):
        await svc.quote("NOPE")
    with pytest.raises(LookupError):
        await svc.quote("NOPE")  # inside the failure TTL: served from cache
    assert attempts["n"] == 1
