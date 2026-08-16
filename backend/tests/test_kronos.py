"""Kronos forecast service tests.

Real inference is exercised with a tiny fake predictor — CI shouldn't download
checkpoints or need torch. What we verify is our own logic: market inference,
calendar handling (business days vs 24×7), envelope math, and API degradation
when the feature is off.
"""

from __future__ import annotations

import numpy as np
import pandas as pd
import pytest
from fastapi.testclient import TestClient

from app.main import app
from app.services.kronos_forecast import (
    PRESETS,
    KronosService,
    infer_market,
    kronos_service,
)


def test_infer_market():
    assert infer_market("BTC-USD") == "crypto"
    assert infer_market("eth-usd") == "crypto"
    assert infer_market("SOL-USDT") == "crypto"
    assert infer_market("AAPL") == "us"
    assert infer_market("600519.SS") == "us"


def test_presets_shape():
    assert PRESETS["us"].calendar == "bdays"
    assert PRESETS["crypto"].calendar == "days"
    assert PRESETS["crypto"].temperature >= PRESETS["us"].temperature


def _history(n: int = 300) -> pd.DataFrame:
    rng = np.random.default_rng(3)
    close = 100 * np.exp(np.cumsum(rng.normal(0, 0.01, n)))
    idx = pd.date_range("2025-01-01", periods=n, freq="D", tz="UTC")
    return pd.DataFrame(
        {
            "Open": close,
            "High": close * 1.01,
            "Low": close * 0.99,
            "Close": close,
            "Volume": np.full(n, 1e6),
        },
        index=idx,
    )


class _FakePredictor:
    """Stands in for KronosPredictor: returns a flat continuation."""

    device = "cpu"

    def predict(self, df, x_timestamp, y_timestamp, pred_len, **kwargs):
        last = float(df["close"].iloc[-1])
        return pd.DataFrame(
            {
                "open": last,
                "high": last * 1.02,
                "low": last * 0.98,
                "close": last,
                "volume": 1e6,
                "amount": 1e8,
            },
            index=y_timestamp,
        )


@pytest.fixture()
def fake_service() -> KronosService:
    svc = KronosService()
    svc._predictor = _FakePredictor()
    return svc


def test_forecast_us_uses_business_days(fake_service):
    out = fake_service.forecast_blocking(_history(), "AAPL", "us", 10)
    days = [pd.Timestamp(p["time"], unit="s").weekday() for p in out["forecast"]]
    assert all(d < 5 for d in days)  # no weekends for equities
    assert out["horizon"] == 10
    assert len(out["forecast"]) == 10
    assert out["preset"]["calendar"] == "bdays"


def test_forecast_crypto_uses_calendar_days(fake_service):
    out = fake_service.forecast_blocking(_history(), "BTC-USD", "crypto", 14)
    times = [p["time"] for p in out["forecast"]]
    deltas = {b - a for a, b in zip(times, times[1:])}
    assert deltas == {86400}  # strictly consecutive days, weekends included
    assert out["preset"]["calendar"] == "days"


def test_forecast_envelope_and_summary(fake_service):
    out = fake_service.forecast_blocking(_history(), "ETH-USD", "crypto", 5)
    for bar in out["forecast"]:
        assert bar["low"] <= bar["close"] <= bar["high"]
    s = out["summary"]
    assert s["last_close"] > 0
    assert s["pred_min"] <= s["pred_close"] <= s["pred_max"]
    assert s["change_pct"] == pytest.approx(0.0, abs=0.01)  # flat fake path


def test_forecast_rejects_short_history(fake_service):
    with pytest.raises(LookupError):
        fake_service.forecast_blocking(_history(30), "AAPL", "us", 10)


def test_horizon_clamped(fake_service):
    out = fake_service.forecast_blocking(_history(), "AAPL", "us", 500)
    assert out["horizon"] == 60


def test_status_endpoint_shape():
    client = TestClient(app)
    body = client.get("/api/kronos/status").json()
    assert {"enabled", "loaded", "presets"} <= set(body)
    assert {"us", "crypto"} == set(body["presets"])


def test_forecast_endpoint_503_when_disabled(monkeypatch):
    monkeypatch.setattr(kronos_service, "enabled", lambda: False)
    client = TestClient(app)
    resp = client.post("/api/kronos/forecast", json={"symbol": "AAPL"})
    assert resp.status_code == 503


# ------------------------------------------------------------- remote proxy


class _FakeResponse:
    def __init__(self, status_code: int, body: dict):
        self.status_code = status_code
        self._body = body
        self.text = str(body)

    def json(self):
        return self._body

    def raise_for_status(self):
        if self.status_code >= 400:
            raise RuntimeError(f"HTTP {self.status_code}")


class _FakeAsyncClient:
    """Stands in for httpx.AsyncClient in the proxy path."""

    calls: list[tuple[str, str, dict | None]] = []
    response: _FakeResponse = _FakeResponse(200, {})

    def __init__(self, **kwargs):
        pass

    async def __aenter__(self):
        return self

    async def __aexit__(self, *exc):
        return False

    async def get(self, url):
        type(self).calls.append(("GET", url, None))
        return type(self).response

    async def post(self, url, json=None):
        type(self).calls.append(("POST", url, json))
        return type(self).response


@pytest.fixture()
def remote_mode(monkeypatch):
    from app.api import kronos as kronos_api
    from app.config import get_settings

    monkeypatch.setattr(kronos_service, "enabled", lambda: False)
    monkeypatch.setattr(get_settings(), "kronos_remote_url", "https://remote.example/")
    monkeypatch.setattr(kronos_api.httpx, "AsyncClient", _FakeAsyncClient)
    _FakeAsyncClient.calls = []
    yield
    monkeypatch.setattr(get_settings(), "kronos_remote_url", None)


def test_status_proxies_to_remote(remote_mode):
    _FakeAsyncClient.response = _FakeResponse(
        200, {"enabled": True, "loaded": True, "model": "NeoQuasar/Kronos-small"}
    )
    body = TestClient(app).get("/api/kronos/status").json()
    assert body["enabled"] is True
    assert body["mode"] == "remote"
    # trailing slash on the configured URL must not produce a double slash
    assert _FakeAsyncClient.calls == [("GET", "https://remote.example/api/kronos/status", None)]


def test_forecast_proxies_to_remote(remote_mode):
    _FakeAsyncClient.response = _FakeResponse(200, {"symbol": "AAPL", "forecast": []})
    resp = TestClient(app).post("/api/kronos/forecast", json={"symbol": "AAPL", "horizon": 14})
    assert resp.status_code == 200
    assert resp.json()["symbol"] == "AAPL"
    assert _FakeAsyncClient.calls == [
        ("POST", "https://remote.example/api/kronos/forecast", {"symbol": "AAPL", "horizon": 14})
    ]


def test_forecast_remote_error_passthrough(remote_mode):
    _FakeAsyncClient.response = _FakeResponse(404, {"detail": "no history for 'ZZZZ'"})
    resp = TestClient(app).post("/api/kronos/forecast", json={"symbol": "ZZZZ"})
    assert resp.status_code == 404
    assert "no history" in resp.json()["detail"]


def test_status_remote_unreachable_degrades(remote_mode):
    class _Boom(_FakeAsyncClient):
        async def get(self, url):
            raise OSError("connection refused")

    from app.api import kronos as kronos_api

    kronos_api.httpx.AsyncClient = _Boom
    body = TestClient(app).get("/api/kronos/status").json()
    assert body["enabled"] is False
    assert body["mode"] == "remote"
    assert "unreachable" in body["error"]
