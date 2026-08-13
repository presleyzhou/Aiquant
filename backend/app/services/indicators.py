"""Technical indicators.

Written from scratch rather than reused from the vendored package: upstream's
`Analytics/` modules are unusable (see `fincept_terminal/NOTICE.md`) and the
`ta` library it depends on is not needed for this set.

Every function takes an OHLCV DataFrame indexed by timestamp and returns a list of
`{"time": epoch_seconds, ...}` points aligned to the chart series, with warm-up
NaNs dropped so the frontend never has to filter.
"""

from __future__ import annotations

import numpy as np
import pandas as pd


def sma(df: pd.DataFrame, period: int = 20) -> list[dict]:
    return _series_to_points(df["Close"].rolling(period).mean())


def ema(df: pd.DataFrame, period: int = 20) -> list[dict]:
    return _series_to_points(df["Close"].ewm(span=period, adjust=False).mean())


def rsi(df: pd.DataFrame, period: int = 14) -> list[dict]:
    delta = df["Close"].diff()
    gain = delta.clip(lower=0)
    loss = -delta.clip(upper=0)

    # Wilder's smoothing
    avg_gain = gain.ewm(alpha=1 / period, adjust=False).mean()
    avg_loss = loss.ewm(alpha=1 / period, adjust=False).mean()

    rs = avg_gain / avg_loss.replace(0, np.nan)
    out = 100 - (100 / (1 + rs))
    # avg_loss == 0 means an unbroken run of gains: RSI is 100, not undefined.
    out = out.where(avg_loss != 0, 100.0)
    out.iloc[:period] = np.nan
    return _series_to_points(out)


def macd(df: pd.DataFrame, fast: int = 12, slow: int = 26, signal: int = 9) -> dict:
    fast_ema = df["Close"].ewm(span=fast, adjust=False).mean()
    slow_ema = df["Close"].ewm(span=slow, adjust=False).mean()
    macd_line = fast_ema - slow_ema
    signal_line = macd_line.ewm(span=signal, adjust=False).mean()
    histogram = macd_line - signal_line
    return {
        "macd": _series_to_points(macd_line),
        "signal": _series_to_points(signal_line),
        "histogram": _series_to_points(histogram),
    }


def bollinger(df: pd.DataFrame, period: int = 20, stddev: float = 2.0) -> dict:
    mid = df["Close"].rolling(period).mean()
    sd = df["Close"].rolling(period).std(ddof=0)
    return {
        "upper": _series_to_points(mid + stddev * sd),
        "middle": _series_to_points(mid),
        "lower": _series_to_points(mid - stddev * sd),
    }


def atr(df: pd.DataFrame, period: int = 14) -> list[dict]:
    return _series_to_points(_true_range(df).ewm(alpha=1 / period, adjust=False).mean())


def _true_range(df: pd.DataFrame) -> pd.Series:
    prev_close = df["Close"].shift()
    return pd.concat(
        [
            df["High"] - df["Low"],
            (df["High"] - prev_close).abs(),
            (df["Low"] - prev_close).abs(),
        ],
        axis=1,
    ).max(axis=1)


REGISTRY = {
    "sma": sma,
    "ema": ema,
    "rsi": rsi,
    "macd": macd,
    "bollinger": bollinger,
    "atr": atr,
}


def compute(df: pd.DataFrame, name: str, **params) -> dict | list[dict]:
    fn = REGISTRY.get(name.lower())
    if fn is None:
        raise ValueError(f"unknown indicator {name!r}; available: {sorted(REGISTRY)}")
    return fn(df, **params)


def _series_to_points(series: pd.Series) -> list[dict]:
    clean = series.replace([np.inf, -np.inf], np.nan).dropna()
    return [
        {"time": int(pd.Timestamp(ts).timestamp()), "value": round(float(v), 4)}
        for ts, v in clean.items()
    ]
