"""Shared (KV) panel cache: round trip through a fake Upstash, size guard,
loader integration."""

from __future__ import annotations

import numpy as np

from app.services import factor_mine, panel_cache
from tests.test_factors import _panel


class FakeKV:
    """Minimal Upstash: SET k v [EX n], GET, MGET."""

    def __init__(self):
        self.store = {}

    def __call__(self, *cmd):
        op = cmd[0]
        if op == "SET":
            self.store[cmd[1]] = cmd[2]
            return "OK"
        if op == "GET":
            return self.store.get(cmd[1])
        if op == "MGET":
            return [self.store.get(k) for k in cmd[1:]]
        raise AssertionError(op)


def _use_fake(monkeypatch):
    fake = FakeKV()
    monkeypatch.setattr(panel_cache.kvstore, "_kv", fake)
    monkeypatch.setattr(panel_cache.kvstore, "mode", lambda: "kv")
    return fake


def test_round_trip_preserves_data_and_provider(monkeypatch):
    fake = _use_fake(monkeypatch)
    panel = _panel(400, 12)
    panel["close"].attrs["provider"] = "binance+coingecko"
    assert panel_cache.store("panel-test", panel) is True
    assert set(fake.store) == {f"panel:panel-test:{f}" for f in (*panel_cache.FIELDS, "manifest")}
    back = panel_cache.load("panel-test")
    assert back is not None and set(back) == set(panel_cache.FIELDS) | set(panel_cache.DERIVED)
    assert np.allclose(back["close"].values, panel["close"].values, equal_nan=True)
    assert list(back["close"].columns) == list(panel["close"].columns)
    assert back["close"].attrs["provider"] == "binance+coingecko"
    assert panel_cache.describe("panel-test")["symbols"] == 12


def test_missing_or_partial_entries_return_none(monkeypatch):
    fake = _use_fake(monkeypatch)
    assert panel_cache.load("nope") is None
    panel_cache.store("p", _panel(200, 6))
    del fake.store["panel:p:volume"]
    assert panel_cache.load("p") is None


def test_size_guard_and_file_mode(monkeypatch):
    fake = _use_fake(monkeypatch)
    monkeypatch.setattr(panel_cache, "MAX_BLOB_BYTES", 10)
    assert panel_cache.store("big", _panel(200, 6)) is False and fake.store == {}
    monkeypatch.setattr(panel_cache.kvstore, "mode", lambda: "file")
    assert panel_cache.store("f", _panel(200, 6)) is False and panel_cache.load("f") is None


def test_loader_prefers_shared_panel_over_download(monkeypatch):
    _use_fake(monkeypatch)
    panel = _panel(300, 10)
    key = None

    def fake_disk_load(k, ttl):
        nonlocal key
        key = k
        return None

    monkeypatch.setattr(factor_mine.disk_cache, "load", fake_disk_load)
    monkeypatch.setattr(factor_mine.disk_cache, "store", lambda k, v: None)
    monkeypatch.setattr(factor_mine, "download_panel", lambda *a, **k: (_ for _ in ()).throw(AssertionError("should not download")))
    factor_mine._PANEL_CACHE.clear()
    # seed the shared layer under the key the loader will compute
    factor_mine._PANEL_CACHE.clear()
    try:
        factor_mine._load_panel_blocking("us")
    except AssertionError:
        pass  # first call computed the key and tried to download
    assert key is not None
    panel_cache.store(key, panel)
    factor_mine._PANEL_CACHE.clear()
    got = factor_mine._load_panel_blocking("us")
    assert got["close"].shape == panel["close"].shape
