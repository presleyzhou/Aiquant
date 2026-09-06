"""Daily OHLCV panel providers.

    crypto  → Binance public klines (primary, no key), CoinGecko fills coins
              Binance does not list, Yahoo as the last resort
    us      → AkShare (Sina Finance, forward-adjusted) when the library is
              installed, Yahoo otherwise

Every provider returns the same thing: {symbol: DataFrame[Open, High, Low,
Close, Volume]} on a tz-naive daily index. `download_panel` groups a ticker
list by asset class, calls the configured provider per group, merges, cleans
and tags the result with the provider chain that produced it.

AkShare is optional and deliberately NOT part of the Vercel bundle: with
py_mini_racer and lxml it adds ~100 MB to a function that already sits near
the 225 MB cap. Install it locally / in Docker with `pip install akshare`
(or the `[akshare]` extra) and it is picked up automatically.
"""

from __future__ import annotations

import logging
import time
from concurrent.futures import ThreadPoolExecutor
from datetime import datetime, timedelta, timezone

import httpx
import pandas as pd

from app.services import disk_cache

log = logging.getLogger("aiquant.panel")

_PERIOD_DAYS = {"1y": 366, "2y": 731, "3y": 1096, "5y": 1827, "max": 3650}
CRYPTO_SUFFIXES = ("-USD", "-USDT", "-USDC")
BINANCE_URL = "https://api.binance.com/api/v3/klines"
COINGECKO_URL = "https://api.coingecko.com/api/v3"
_COINGECKO_IDS: dict[str, tuple[float, dict[str, str]]] = {}
_COINGECKO_TTL = 24 * 3600
_WORKERS_BINANCE = 6
_WORKERS_AKSHARE = 3          # Sina rate-limits aggressive clients


def is_crypto(symbol: str) -> bool:
    return str(symbol).upper().endswith(CRYPTO_SUFFIXES)


def _cutoff(period: str) -> pd.Timestamp:
    return pd.Timestamp(datetime.now(timezone.utc) - timedelta(days=_PERIOD_DAYS.get(period, 1096)))


def _settings():
    from app.config import get_settings

    return get_settings()


# ----------------------------------------------------------------- Binance


def binance_frame(symbol: str, period: str) -> pd.DataFrame:
    """One coin's daily bars from Binance (XXX-USD → XXXUSDT), paginated."""
    pair = symbol.upper().replace("-USDT", "USDT").replace("-USDC", "USDT").replace("-USD", "USDT")
    cursor = int(_cutoff(period).timestamp() * 1000)
    rows: list[list] = []
    for _ in range(8):
        resp = httpx.get(BINANCE_URL, params={"symbol": pair, "interval": "1d", "startTime": cursor, "limit": 1000}, timeout=20.0)
        if resp.status_code == 400:            # unknown pair — let CoinGecko try
            raise LookupError(f"binance: {pair} not listed")
        resp.raise_for_status()
        batch = resp.json()
        if not batch:
            break
        rows.extend(batch)
        cursor = int(batch[-1][6]) + 1
        if len(batch) < 1000:
            break
    if not rows:
        raise LookupError(f"binance: no klines for {pair}")
    df = pd.DataFrame(rows).iloc[:, :6]
    df.columns = ["ts", "Open", "High", "Low", "Close", "Volume"]
    df["Date"] = pd.to_datetime(df["ts"], unit="ms", utc=True).dt.tz_localize(None).dt.normalize()
    df = df.set_index("Date")[["Open", "High", "Low", "Close", "Volume"]].astype(float)
    # Binance volume is in base units; the platform expects quote-currency
    # volume for crypto (as Yahoo reports it) → multiply by close
    df["Volume"] = df["Volume"] * df["Close"]
    return df[~df.index.duplicated(keep="last")]


def binance_frames(symbols: list[str], period: str) -> tuple[dict[str, pd.DataFrame], list[str]]:
    """All coins in parallel; returns (frames, symbols Binance does not list).
    A transport failure (network, 5xx) is raised so the caller can fall back."""
    frames: dict[str, pd.DataFrame] = {}
    missing: list[str] = []
    errors: list[Exception] = []

    def one(sym: str):
        try:
            return sym, binance_frame(sym, period), None
        except LookupError:
            return sym, None, "missing"
        except Exception as exc:  # network / HTTP
            return sym, None, exc

    with ThreadPoolExecutor(max_workers=_WORKERS_BINANCE) as pool:
        for sym, frame, err in pool.map(one, symbols):
            if frame is not None:
                frames[sym] = frame
            elif err == "missing":
                missing.append(sym)
            else:
                errors.append(err)
    if not frames and errors:
        raise LookupError(f"binance unreachable: {errors[0]}")
    return frames, missing


# --------------------------------------------------------------- CoinGecko


def _coingecko_headers() -> dict[str, str]:
    key = _settings().coingecko_api_key
    return {"x-cg-demo-api-key": key} if key else {}


def coingecko_ids(symbols: list[str]) -> dict[str, str]:
    """symbol (e.g. SOL-USD) → CoinGecko coin id, resolved through the
    markets endpoint so the largest coin wins when tickers collide."""
    wanted = {s: s.upper().split("-")[0].lower() for s in symbols}
    now = time.time()
    cached = _COINGECKO_IDS.get("ids")
    table: dict[str, str] = dict(cached[1]) if cached and now - cached[0] < _COINGECKO_TTL else {}
    todo = sorted({v for v in wanted.values() if v not in table})
    if todo:
        resp = httpx.get(
            f"{COINGECKO_URL}/coins/markets",
            params={"vs_currency": "usd", "symbols": ",".join(todo), "per_page": 250, "order": "market_cap_desc"},
            headers=_coingecko_headers(), timeout=20.0,
        )
        resp.raise_for_status()
        for coin in resp.json():
            sym = str(coin.get("symbol", "")).lower()
            if sym in todo and sym not in table:
                table[sym] = str(coin["id"])
        _COINGECKO_IDS["ids"] = (now, table)
    return {s: table[v] for s, v in wanted.items() if v in table}


def coingecko_frame(coin_id: str, period: str) -> pd.DataFrame:
    """Daily prices + volumes from /market_chart. CoinGecko has no free daily
    OHLC beyond 90 days, so open = previous close and high/low span the two —
    a close-to-close approximation, flagged in the provider tag."""
    days = "max" if period in ("3y", "5y", "max") else str(_PERIOD_DAYS.get(period, 366))
    resp = httpx.get(
        f"{COINGECKO_URL}/coins/{coin_id}/market_chart",
        params={"vs_currency": "usd", "days": days, "interval": "daily"},
        headers=_coingecko_headers(), timeout=30.0,
    )
    resp.raise_for_status()
    body = resp.json()
    prices = pd.DataFrame(body.get("prices", []), columns=["ts", "Close"])
    vols = pd.DataFrame(body.get("total_volumes", []), columns=["ts", "Volume"])
    if prices.empty:
        raise LookupError(f"coingecko: no prices for {coin_id}")
    df = prices.merge(vols, on="ts", how="left")
    df["Date"] = pd.to_datetime(df["ts"], unit="ms", utc=True).dt.tz_localize(None).dt.normalize()
    df = df.drop_duplicates("Date", keep="last").set_index("Date")[["Close", "Volume"]].astype(float)
    df["Open"] = df["Close"].shift(1)
    df["High"] = df[["Open", "Close"]].max(axis=1)
    df["Low"] = df[["Open", "Close"]].min(axis=1)
    df = df[df.index >= _cutoff(period).tz_localize(None)]
    return df[["Open", "High", "Low", "Close", "Volume"]].dropna(subset=["Close"])


def coingecko_frames(symbols: list[str], period: str) -> dict[str, pd.DataFrame]:
    if not symbols:
        return {}
    try:
        ids = coingecko_ids(symbols)
    except Exception as exc:
        log.warning("coingecko id lookup failed: %s", exc)
        return {}
    out: dict[str, pd.DataFrame] = {}
    for sym, coin_id in ids.items():
        try:
            out[sym] = coingecko_frame(coin_id, period)
        except Exception as exc:
            log.warning("coingecko %s (%s): %s", sym, coin_id, exc)
    return out


# ----------------------------------------------------------------- AkShare


def akshare_available() -> bool:
    try:
        import akshare  # noqa: F401
    except Exception:
        return False
    return True


def akshare_frame(symbol: str, period: str) -> pd.DataFrame:
    """Forward-adjusted (qfq) daily bars from Sina via AkShare."""
    import akshare as ak

    raw = ak.stock_us_daily(symbol=symbol.upper(), adjust="qfq")
    if raw is None or len(raw) == 0:
        raise LookupError(f"akshare: no data for {symbol}")
    df = raw.copy()
    if "date" in df.columns:
        df["Date"] = pd.to_datetime(df["date"])
        df = df.set_index("Date")
    else:
        df.index = pd.to_datetime(df.index)
        df.index.name = "Date"
    df = df.rename(columns={"open": "Open", "high": "High", "low": "Low", "close": "Close", "volume": "Volume"})
    df = df[["Open", "High", "Low", "Close", "Volume"]].astype(float)
    df.index = df.index.tz_localize(None).normalize() if getattr(df.index, "tz", None) is not None else df.index.normalize()
    df = df[df.index >= _cutoff(period).tz_localize(None)]
    if df.empty:
        raise LookupError(f"akshare: empty window for {symbol}")
    return df[~df.index.duplicated(keep="last")]


def akshare_frames(symbols: list[str], period: str) -> dict[str, pd.DataFrame]:
    frames: dict[str, pd.DataFrame] = {}

    def one(sym: str):
        try:
            return sym, akshare_frame(sym, period)
        except Exception as exc:
            log.warning("akshare %s: %s", sym, exc)
            return sym, None

    with ThreadPoolExecutor(max_workers=_WORKERS_AKSHARE) as pool:
        for sym, frame in pool.map(one, symbols):
            if frame is not None:
                frames[sym] = frame
    return frames


# ------------------------------------------------------------------- Yahoo


def yahoo_frames(symbols: list[str], period: str) -> dict[str, pd.DataFrame]:
    import yfinance as yf

    raw = yf.download(list(symbols), period=period, interval="1d", auto_adjust=True,
                      progress=False, group_by="column", threads=True)
    if raw is None or raw.empty:
        raise LookupError("yahoo: empty download")
    frames: dict[str, pd.DataFrame] = {}
    for sym in symbols:
        cols = {}
        for field in ("Open", "High", "Low", "Close", "Volume"):
            block = raw[field]
            series = block if isinstance(block, pd.Series) else (block[sym] if sym in block.columns else None)
            if series is None:
                break
            cols[field] = series
        if len(cols) == 5:
            df = pd.DataFrame(cols).dropna(how="all")
            if not df.empty:
                idx = pd.to_datetime(df.index)
                df.index = (idx.tz_localize(None) if idx.tz is not None else idx).normalize()
                frames[sym] = df.astype(float)
    return frames


# -------------------------------------------------------------- assembly


def _assemble(frames: dict[str, pd.DataFrame]) -> dict[str, pd.DataFrame]:
    """{symbol: OHLCV frame} → {field: DataFrame[dates × symbols]}."""
    panel: dict[str, pd.DataFrame] = {}
    for field, source in (("open", "Open"), ("high", "High"), ("low", "Low"), ("close", "Close"), ("volume", "Volume")):
        panel[field] = pd.DataFrame({sym: df[source] for sym, df in frames.items()}).sort_index()
    return panel


def clean_panel(panel: dict[str, pd.DataFrame], label: str, min_symbols: int) -> dict[str, pd.DataFrame]:
    """Drop names with thin histories or feed errors; add derived fields."""
    for field in list(panel):
        panel[field] = panel[field].dropna(axis=1, how="all")
    close_ok = panel["close"].notna().mean() > 0.7
    sane = panel["close"].pct_change().abs().max() < 4.0   # a >400% day is a feed error
    good = panel["close"].columns[close_ok & sane]
    if len(good) < min_symbols:
        raise LookupError(f"only {len(good)} usable symbols in the {label} universe (need {min_symbols})")
    for field in list(panel):
        panel[field] = panel[field].reindex(columns=good)
    close = panel["close"]
    panel["returns"] = close.pct_change()
    panel["vwap"] = (panel["high"] + panel["low"] + close) / 3
    return panel


def _crypto_frames(symbols: list[str], period: str, provider: str) -> tuple[dict[str, pd.DataFrame], list[str]]:
    used: list[str] = []
    frames: dict[str, pd.DataFrame] = {}
    if provider == "binance":
        try:
            frames, missing = binance_frames(symbols, period)
            used.append("binance")
        except LookupError as exc:
            log.warning("binance failed, falling back to yahoo: %s", exc)
            missing = list(symbols)
        if missing and frames and _settings().coingecko_fill:
            filled = coingecko_frames(missing, period)
            if filled:
                frames.update(filled)
                used.append("coingecko")
                missing = [s for s in missing if s not in filled]
        if not frames or (missing and not used):
            frames = yahoo_frames(symbols, period)
            used = ["yahoo"]
    else:
        frames = yahoo_frames(symbols, period)
        used = ["yahoo"]
    return frames, used


def _equity_frames(symbols: list[str], period: str, provider: str, min_symbols: int) -> tuple[dict[str, pd.DataFrame], list[str]]:
    use_ak = provider == "akshare" or (provider == "auto" and akshare_available())
    if use_ak:
        if not akshare_available():
            log.warning("PANEL_PROVIDER_US=akshare but akshare is not installed; using yahoo")
        else:
            frames = akshare_frames(symbols, period)
            if len(frames) >= min(min_symbols, len(symbols)):
                return frames, ["akshare"]
            log.warning("akshare returned %d/%d symbols; falling back to yahoo", len(frames), len(symbols))
    return yahoo_frames(symbols, period), ["yahoo"]


def download_panel(tickers: list[str], period: str, label: str, min_symbols: int = 8,
                   market: str | None = None) -> dict[str, pd.DataFrame]:
    """The panel for `tickers`, from the configured providers, cleaned. The
    provider chain is recorded in `panel["close"].attrs["provider"]`."""
    settings = _settings()
    tickers = list(dict.fromkeys(str(t).upper() for t in tickers))
    crypto = [t for t in tickers if is_crypto(t)] if market != "us" else []
    equity = [t for t in tickers if t not in crypto]
    frames: dict[str, pd.DataFrame] = {}
    used: list[str] = []
    if crypto:
        f, u = _crypto_frames(crypto, period, settings.panel_provider_crypto)
        frames.update(f); used += u
    if equity:
        f, u = _equity_frames(equity, period, settings.panel_provider_us, min_symbols)
        frames.update(f); used += u
    if not frames:
        raise LookupError(f"could not download the {label} universe")
    panel = clean_panel(_assemble(frames), label, min_symbols)
    tag = "+".join(dict.fromkeys(used))
    for field in panel.values():
        field.attrs["provider"] = tag
    log.info("panel %s: %d symbols via %s", label, panel["close"].shape[1], tag)
    return panel


def provider_of(panel: dict[str, pd.DataFrame]) -> str:
    try:
        return str(panel["close"].attrs.get("provider") or "yahoo")
    except Exception:
        return "yahoo"
