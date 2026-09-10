import numpy as np
import pandas as pd

from app.services import backtest as bt


def _frame(closes):
    idx = pd.date_range("2024-01-01", periods=len(closes), freq="B", tz="UTC")
    c = pd.Series(closes, index=idx, dtype=float)
    return pd.DataFrame({"Open": c, "High": c * 1.01, "Low": c * 0.99, "Close": c, "Volume": 1e6})


def test_stop_loss_exits_next_open_and_waits_for_signal_reset():
    closes = [100.0] * 10 + [85.0] * 5 + [90.0] * 25
    df = _frame(closes)
    always = pd.Series(True, index=df.index)
    res = bt.run(df, bt.BacktestConfig(strategy="buy_and_hold", stop_loss_pct=10), want_long=always)
    stops = [t for t in res.trades if t["exit_reason"] == "stop_loss"]
    assert len(stops) == 1
    assert stops[0]["exit_time"] == int(df.index[11].timestamp())      # decided on day 10's close, filled day 11
    assert res.stats["trade_count"] == 1 and res.stats["exits_by_reason"] == {"stop_loss": 1}
    plain = bt.run(df, bt.BacktestConfig(strategy="buy_and_hold"), want_long=always)
    assert plain.stats["trade_count"] == 1 and plain.trades[0]["exit_reason"] == "signal"


def test_take_profit_and_trailing_stop():
    df = _frame([100.0 + i for i in range(40)])
    always = pd.Series(True, index=df.index)
    tp_ = bt.run(df, bt.BacktestConfig(strategy="buy_and_hold", take_profit_pct=5), want_long=always)
    assert tp_.trades[0]["exit_reason"] == "take_profit" and tp_.trades[0]["return_pct"] > 4
    df2 = _frame([100.0 + i for i in range(20)] + [119.0 - 2 * i for i in range(20)])
    ts_ = bt.run(df2, bt.BacktestConfig(strategy="buy_and_hold", trailing_stop_pct=5), want_long=pd.Series(True, index=df2.index))
    assert ts_.trades[0]["exit_reason"] == "trailing_stop"
    assert 100 < ts_.trades[0]["exit_price"] < 119


def test_vol_target_scales_the_position():
    rng = np.random.default_rng(0)
    df = _frame(list(100 * np.exp(np.cumsum(rng.normal(0, 0.03, 120)))))
    # go long only after 30 bars so the 20-bar realised vol is known at entry
    late = pd.Series([i >= 30 for i in range(len(df))], index=df.index)
    full = bt.run(df, bt.BacktestConfig(strategy="buy_and_hold"), want_long=late)
    sized = bt.run(df, bt.BacktestConfig(strategy="buy_and_hold", vol_target_pct=10), want_long=late)
    assert sized.trades[0]["shares"] < 0.5 * full.trades[0]["shares"]
    assert abs(sized.stats["annual_volatility_pct"]) < abs(full.stats["annual_volatility_pct"])
    capped = bt.run(df, bt.BacktestConfig(strategy="buy_and_hold", max_position=0.5), want_long=late)
    assert abs(capped.trades[0]["shares"] / full.trades[0]["shares"] - 0.5) < 0.02
    # before the vol window fills, sizing falls back to max_position (documented behaviour)
    early = bt.run(df, bt.BacktestConfig(strategy="buy_and_hold", vol_target_pct=10), want_long=pd.Series(True, index=df.index))
    assert abs(early.trades[0]["shares"] - bt.run(df, bt.BacktestConfig(strategy="buy_and_hold"), want_long=pd.Series(True, index=df.index)).trades[0]["shares"]) < 1e-6
