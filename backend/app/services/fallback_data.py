"""Secondary history sources so a yfinance hiccup doesn't degrade the site.

* US daily bars → Stooq's free CSV endpoint (https://stooq.com/q/d/l/?s=aapl.us&i=d)
* Crypto daily/hourly → Binance public klines (no key; XXX-USD → XXXUSDT)

Both return the same shape the platform expects from yfinance: a DataFrame
with Open/High/Low/Close/Volume columns on a UTC DatetimeIndex.
"""

from __future__ import annotations

import io
import logging
from datetime import UTC, datetime, timedelta

import httpx
import pandas as pd

log = logging.getLogger("aiquant.fallback")

_PERIOD_DAYS = {
    "1d": 2, "5d": 7, "1mo": 31, "3mo": 93, "6mo": 186,
    "1y": 366, "2y": 731, "3y": 1096, "5y": 1827, "max": 3650,
}


def _cutoff(period: str) -> pd.Timestamp:
    days = _PERIOD_DAYS.get(period, 731)
    return pd.Timestamp(datetime.now(UTC) - timedelta(days=days))


def stooq_daily(symbol: str, period: str) -> pd.DataFrame:
    """US equities/ETFs, daily bars only."""
    ticker = f"{symbol.lower()}.us"
    url = f"https://stooq.com/q/d/l/?s={ticker}&i=d"
    resp = httpx.get(url, timeout=15.0, follow_redirects=True)
    resp.raise_for_status()
    text = resp.text
    if not text or text.startswith("No data") or "Date" not in text.splitlines()[0]:
        raise LookupError(f"stooq: no data for {symbol}")
    df = pd.read_csv(io.StringIO(text))
    df["Date"] = pd.to_datetime(df["Date"], utc=True)
    df = df.set_index("Date").rename(columns=str.title)
    df = df[["Open", "High", "Low", "Close", "Volume"]].astype(float)
    df = df[df.index >= _cutoff(period)].dropna(subset=["Open", "High", "Low", "Close"])
    if df.empty:
        raise LookupError(f"stooq: empty window for {symbol}")
    df.index.name = "Date"
    return df


def binance_klines(symbol: str, period: str, interval: str) -> pd.DataFrame:
    """Crypto bars from Binance public REST. interval: 1d | 1h | 1wk."""
    pair = symbol.upper().replace("-USD", "USDT").replace("-USDT", "USDT")
    bn_interval = {"1d": "1d", "1h": "1h", "1wk": "1w"}.get(interval, "1d")
    start_ms = int(_cutoff(period).timestamp() * 1000)
    rows: list[list] = []
    cursor = start_ms
    for _ in range(8):  # ≤ 8 × 1000 candles
        resp = httpx.get(
            "https://api.binance.com/api/v3/klines",
            params={"symbol": pair, "interval": bn_interval, "startTime": cursor, "limit": 1000},
            timeout=15.0,
        )
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        rows.extend(batch)
        cursor = int(batch[-1][6]) + 1  # close time + 1ms
        if len(batch) < 1000:
            break
    if not rows:
        raise LookupError(f"binance: no klines for {pair}")
    df = pd.DataFrame(rows).iloc[:, :6]
    df.columns = ["ts", "Open", "High", "Low", "Close", "Volume"]
    df["Date"] = pd.to_datetime(df["ts"], unit="ms", utc=True)
    df = df.set_index("Date")[["Open", "High", "Low", "Close", "Volume"]].astype(float)
    df.index.name = "Date"
    return df


def fetch(symbol: str, period: str, interval: str) -> pd.DataFrame:
    """Route to the right secondary source; raises LookupError if none fits."""
    if symbol.upper().endswith(("-USD", "-USDT")):
        return binance_klines(symbol, period, interval)
    if interval == "1d":
        return stooq_daily(symbol, period)
    raise LookupError(f"no fallback source for {symbol} @ {interval}")
