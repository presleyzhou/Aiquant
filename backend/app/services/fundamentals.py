"""Point-in-time fundamentals for the US pipeline universe.

Provider: Financial Modeling Prep (`FMP_API_KEY`), quarterly key metrics per
symbol — market cap, P/E, P/B, ROE. Each quarter's values become visible
only `FUNDAMENTALS_LAG_DAYS` after the period end (10-Q deadlines are 40–45
days, 10-K 60–90; the default 60 is conservative for quarters and slightly
optimistic for year-ends) and are then forward-filled until the next
publication. Without a key the fields are simply absent and any factor that
reads them fails with a clear message.

One request per symbol; the result is cached for a day on disk and in KV so
the free tier's daily quota is spent once, not per run.
"""

from __future__ import annotations

import hashlib
import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import UTC, datetime

import httpx
import numpy as np
import pandas as pd

from app.config import get_settings
from app.services import disk_cache, kvstore

log = logging.getLogger("aiquant.fundamentals")

FIELDS = ("mcap", "pe", "pb", "roe")
DERIVED = ("ep", "bp")
TTL_SECONDS = 24 * 3600
STABLE_URL = "https://financialmodelingprep.com/stable/key-metrics"
V3_URL = "https://financialmodelingprep.com/api/v3/key-metrics/{symbol}"
_ALIASES = {
    "mcap": ("marketCap",),
    "pe": ("peRatio", "priceToEarningsRatio"),
    "pb": ("pbRatio", "priceToBookRatio"),
    "roe": ("roe", "returnOnEquity"),
}
_MEM: dict[str, tuple[float, dict]] = {}


def enabled() -> bool:
    return bool(get_settings().fmp_api_key)


def describe() -> dict:
    s = get_settings()
    return {"enabled": enabled(), "provider": "fmp" if enabled() else None, "market": "us",
            "fields": list(FIELDS + DERIVED), "lag_days": int(s.fundamentals_lag_days)}


def _pick(row: dict, field: str) -> float:
    for name in _ALIASES[field]:
        v = row.get(name)
        if v is not None:
            try:
                return float(v)
            except (TypeError, ValueError):
                continue
    return float("nan")


def fetch_symbol(symbol: str, api_key: str, client: httpx.Client) -> list[dict]:
    """Quarterly rows → [{"date", "mcap", "pe", "pb", "roe"}], newest first.
    Tries the current ("stable") endpoint, then the legacy v3 path."""
    attempts = (
        (STABLE_URL, {"symbol": symbol, "period": "quarter", "limit": 40, "apikey": api_key}),
        (V3_URL.format(symbol=symbol), {"period": "quarter", "limit": 40, "apikey": api_key}),
    )
    for url, params in attempts:
        try:
            resp = client.get(url, params=params)
        except httpx.HTTPError as exc:
            log.warning("fmp %s: %s", symbol, exc)
            continue
        if resp.status_code != 200:
            continue
        try:
            body = resp.json()
        except ValueError:          # an HTML rate-limit page with a 200
            continue
        if not isinstance(body, list) or not body:
            continue
        rows = []
        for r in body:
            if not isinstance(r, dict) or not r.get("date"):
                continue
            rows.append({"date": str(r["date"])[:10], **{f: _pick(r, f) for f in FIELDS}})
        if rows:
            return rows
    return []


def _download(symbols: list[str]) -> dict[str, list[dict]]:
    key = get_settings().fmp_api_key or ""
    out: dict[str, list[dict]] = {}
    def safe(sym: str, client: httpx.Client) -> list[dict]:
        try:
            return fetch_symbol(sym, key, client)
        except Exception as exc:    # one bad symbol must not sink the batch
            log.warning("fmp %s failed: %s", sym, exc)
            return []

    with httpx.Client(timeout=15.0) as client, ThreadPoolExecutor(max_workers=6) as pool:
        for sym, rows in zip(symbols, pool.map(lambda s: safe(s, client), symbols), strict=True):
            if rows:
                out[sym] = rows
    return out


def _raw_rows(market: str, symbols: list[str]) -> dict[str, list[dict]]:
    """Per-symbol quarterly rows, cached for a day (memory → disk → KV → FMP)."""
    day = datetime.now(UTC).date().isoformat()
    digest = hashlib.sha1(",".join(sorted(symbols)).encode()).hexdigest()[:12]
    key = f"fund-{market}-{day}-{digest}"      # per universe: custom lists must not poison the built-in one
    hit = _MEM.get(key)
    if hit and time.time() - hit[0] < TTL_SECONDS:
        return hit[1]
    doc = disk_cache.load(key, TTL_SECONDS)
    if not isinstance(doc, dict):
        doc = None
        if kvstore.mode() == "kv":
            try:
                doc = (kvstore.get(key) or {}).get("rows")
            except Exception as exc:
                log.warning("fundamentals kv read failed: %s", exc)
    if not isinstance(doc, dict):
        t0 = time.time()
        doc = _download(symbols)
        log.info("fundamentals: %d/%d symbols in %.1fs", len(doc), len(symbols), time.time() - t0)
        disk_cache.store(key, doc)
        if kvstore.mode() == "kv":
            try:
                kvstore.put(key, {"rows": doc, "created": int(time.time())})
            except Exception as exc:
                log.warning("fundamentals kv write failed: %s", exc)
    if len(_MEM) >= 8:
        _MEM.pop(next(iter(_MEM)))
    _MEM[key] = (time.time(), doc)
    return doc


def frames_from_rows(rows: dict[str, list[dict]], index: pd.DatetimeIndex, columns: list[str],
                     lag_days: int) -> dict[str, pd.DataFrame]:
    """Quarterly rows → daily frames aligned to the price panel: each value
    appears `lag_days` after its period end and is forward-filled."""
    frames = {f: pd.DataFrame(np.nan, index=index, columns=columns) for f in FIELDS}
    lag = pd.Timedelta(days=int(lag_days))
    for sym in columns:
        rs = rows.get(str(sym)) or []
        if not rs:
            continue
        df = pd.DataFrame(rs)
        df["date"] = pd.to_datetime(df["date"], errors="coerce") + lag
        df = df.dropna(subset=["date"]).sort_values("date").drop_duplicates("date", keep="last").set_index("date")
        for f in FIELDS:
            if f not in df:
                continue
            series = pd.to_numeric(df[f], errors="coerce")
            # values known at each panel date: the newest publication at or before it
            aligned = series.reindex(series.index.union(index)).sort_index().ffill().reindex(index)
            frames[f][sym] = aligned.to_numpy()
    for f in FIELDS:
        frames[f] = frames[f].replace([np.inf, -np.inf], np.nan)
    pe, pb = frames["pe"], frames["pb"]
    frames["ep"] = (1.0 / pe.where(pe.abs() > 1e-9)).replace([np.inf, -np.inf], np.nan)
    frames["bp"] = (1.0 / pb.where(pb.abs() > 1e-9)).replace([np.inf, -np.inf], np.nan)
    return frames


def attach(panel: dict[str, pd.DataFrame], market: str) -> dict[str, pd.DataFrame]:
    """A shallow copy of `panel` with the fundamental fields added. Raises a
    FactorError (400) when fundamentals are unavailable for this request."""
    from app.services.factor_dsl import FactorError

    if market != "us":
        raise FactorError("fundamental fields (mcap, pe, pb, roe, ep, bp) are available for the US market only")
    if not enabled():
        raise FactorError("fundamental fields need a fundamentals provider: set FMP_API_KEY on the server")
    close = panel["close"]
    rows = _raw_rows(market, [str(c) for c in close.columns])
    covered = sum(1 for c in close.columns if rows.get(str(c)))
    if covered < max(8, int(0.5 * close.shape[1])):
        raise FactorError(f"fundamentals cover only {covered}/{close.shape[1]} symbols — provider quota or outage")
    frames = frames_from_rows(rows, close.index, [str(c) for c in close.columns], get_settings().fundamentals_lag_days)
    out = dict(panel)
    for f, frame in frames.items():
        frame.attrs["provider"] = "fmp"
        out[f] = frame
    return out
