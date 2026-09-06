"""Panel providers: Binance (+CoinGecko) for crypto, AkShare for US, Yahoo
fallback — all HTTP mocked, no network."""

from __future__ import annotations

import sys
import types

import numpy as np
import pandas as pd
import pytest

from app.services import panel_providers as pp

DAY_MS = 86_400_000
T0 = 1_700_000_000_000


def _klines(n: int, start_ms: int = T0, price: float = 100.0) -> list[list]:
    rows = []
    for i in range(n):
        o = price + i
        ts = start_ms + i * DAY_MS
        rows.append([ts, str(o), str(o + 1), str(o - 1), str(o + 0.5), "1000", ts + DAY_MS - 1, "0", 10, "0", "0", "0"])
    return rows


class FakeResp:
    def __init__(self, payload, status=200):
        self._payload, self.status_code = payload, status

    def json(self):
        return self._payload

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"http {self.status_code}")


def _fake_settings(monkeypatch, **overrides):
    base = {"panel_provider_us": "auto", "panel_provider_crypto": "binance", "coingecko_fill": True, "coingecko_api_key": None}
    base.update(overrides)
    monkeypatch.setattr(pp, "_settings", lambda: types.SimpleNamespace(**base))


def test_binance_pagination_maps_symbol_and_converts_volume(monkeypatch):
    calls = []

    def fake_get(url, params=None, headers=None, timeout=None):
        calls.append(params)
        if params["startTime"] == calls[0]["startTime"]:
            return FakeResp(_klines(1000))
        return FakeResp(_klines(200, start_ms=T0 + 1000 * DAY_MS))

    monkeypatch.setattr(pp.httpx, "get", fake_get)
    df = pp.binance_frame("BTC-USD", "5y")
    assert calls[0]["symbol"] == "BTCUSDT" and len(calls) == 2
    assert len(df) == 1200 and list(df.columns) == ["Open", "High", "Low", "Close", "Volume"]
    assert df.index.tz is None and df.index[1] - df.index[0] == pd.Timedelta(days=1)
    assert df["Volume"].iloc[0] == pytest.approx(1000 * 100.5)  # base units × close → quote currency


def test_binance_unlisted_pair_is_filled_by_coingecko(monkeypatch):
    def fake_get(url, params=None, headers=None, timeout=None):
        if url == pp.BINANCE_URL:
            if params["symbol"] == "NEWUSDT":
                return FakeResp({"code": -1121, "msg": "Invalid symbol."}, status=400)
            return FakeResp(_klines(400))
        if url.endswith("/coins/markets"):
            return FakeResp([{"id": "newcoin", "symbol": "new"}, {"id": "newcoin-clone", "symbol": "new"}])
        if "/market_chart" in url:
            prices = [[T0 + i * DAY_MS, 5.0 + i * 0.01] for i in range(400)]
            return FakeResp({"prices": prices, "total_volumes": [[t, 1e6] for t, _ in prices]})
        raise AssertionError(url)

    monkeypatch.setattr(pp.httpx, "get", fake_get)
    _fake_settings(monkeypatch)
    pp._COINGECKO_IDS.clear()
    frames, used = pp._crypto_frames(["BTC-USD", "ETH-USD", "NEW-USD"], "3y", "binance")
    assert used == ["binance", "coingecko"]
    assert set(frames) == {"BTC-USD", "ETH-USD", "NEW-USD"}
    cg = frames["NEW-USD"]
    assert (cg["High"] >= cg["Low"]).all() and cg["Open"].iloc[1] == cg["Close"].iloc[0]  # close-to-close bars


def test_binance_outage_falls_back_to_yahoo(monkeypatch):
    def fake_get(url, params=None, headers=None, timeout=None):
        raise ConnectionError("network down")

    monkeypatch.setattr(pp.httpx, "get", fake_get)
    _fake_settings(monkeypatch)
    idx = pd.date_range("2024-01-01", periods=300, freq="D")
    yahoo = {s: pd.DataFrame({c: np.linspace(1, 2, 300) for c in ("Open", "High", "Low", "Close", "Volume")}, index=idx) for s in ("BTC-USD", "ETH-USD")}
    monkeypatch.setattr(pp, "yahoo_frames", lambda symbols, period: yahoo)
    frames, used = pp._crypto_frames(["BTC-USD", "ETH-USD"], "3y", "binance")
    assert used == ["yahoo"] and set(frames) == {"BTC-USD", "ETH-USD"}


def test_akshare_provider_is_used_when_installed_and_tagged(monkeypatch):
    idx = pd.date_range("2023-01-01", periods=800, freq="B")

    def stock_us_daily(symbol="AAPL", adjust=""):
        assert adjust == "qfq"
        base = 100 + (hash(symbol) % 50)
        return pd.DataFrame({"date": idx.date, "open": base, "high": base + 1, "low": base - 1, "close": base + 0.5, "volume": 1e6, "amount": 0})

    fake = types.ModuleType("akshare")
    fake.stock_us_daily = stock_us_daily
    monkeypatch.setitem(sys.modules, "akshare", fake)
    _fake_settings(monkeypatch, panel_provider_us="auto")
    syms = ["AAPL", "MSFT", "NVDA", "GOOG", "META", "AMZN", "TSLA", "JPM"]
    panel = pp.download_panel(syms, "3y", "test")
    assert pp.provider_of(panel) == "akshare"
    assert list(panel["close"].columns) == syms and "vwap" in panel
    assert panel["close"].index.tz is None


def test_akshare_missing_or_forced_yahoo(monkeypatch):
    monkeypatch.setitem(sys.modules, "akshare", None)  # import fails
    _fake_settings(monkeypatch, panel_provider_us="akshare")
    idx = pd.date_range("2023-01-01", periods=800, freq="B")
    yahoo = {s: pd.DataFrame({c: 100.0 for c in ("Open", "High", "Low", "Close", "Volume")}, index=idx) for s in ["A%d" % i for i in range(8)]}
    monkeypatch.setattr(pp, "yahoo_frames", lambda symbols, period: yahoo)
    panel = pp.download_panel(list(yahoo), "3y", "test")
    assert pp.provider_of(panel) == "yahoo"


def test_mixed_universe_routes_by_asset_class(monkeypatch):
    _fake_settings(monkeypatch, panel_provider_us="yahoo")
    idx = pd.date_range("2023-01-01", periods=500, freq="D")

    def frame(v):
        return pd.DataFrame({c: float(v) for c in ("Open", "High", "Low", "Close", "Volume")}, index=idx)

    monkeypatch.setattr(pp, "binance_frames", lambda symbols, period: ({s: frame(2) for s in symbols}, []))
    monkeypatch.setattr(pp, "yahoo_frames", lambda symbols, period: {s: frame(1) for s in symbols})
    syms = ["AAPL", "MSFT", "BTC-USD", "ETH-USD", "GOOG", "META", "SOL-USD", "AMZN"]
    panel = pp.download_panel(syms, "3y", "mixed")
    assert pp.provider_of(panel) == "binance+yahoo"
    assert panel["close"]["BTC-USD"].iloc[0] == 2.0 and panel["close"]["AAPL"].iloc[0] == 1.0
    assert set(panel["close"].columns) == set(syms)


def test_clean_panel_drops_thin_and_insane_names():
    idx = pd.date_range("2023-01-01", periods=300, freq="D")
    good = pd.Series(np.linspace(10, 20, 300), index=idx)
    thin = good.copy(); thin.iloc[:200] = np.nan
    crazy = good.copy(); crazy.iloc[150] = 1e4
    frames = {"GOOD": pd.DataFrame({c: good for c in ("Open", "High", "Low", "Close", "Volume")}),
              "THIN": pd.DataFrame({c: thin for c in ("Open", "High", "Low", "Close", "Volume")}),
              "CRAZY": pd.DataFrame({c: crazy for c in ("Open", "High", "Low", "Close", "Volume")})}
    panel = pp.clean_panel(pp._assemble(frames), "t", min_symbols=1)
    assert list(panel["close"].columns) == ["GOOD"]
    with pytest.raises(LookupError):
        pp.clean_panel(pp._assemble(frames), "t", min_symbols=2)
