"""Offline tests for the analytics layer — no network, fully deterministic."""

import numpy as np
import pandas as pd
import pytest

from app.services import backtest as bt
from app.services import indicators as ind


def make_frame(closes: list[float]) -> pd.DataFrame:
    index = pd.date_range("2024-01-01", periods=len(closes), freq="B", tz="UTC")
    close = pd.Series(closes, index=index, dtype=float)
    return pd.DataFrame(
        {
            "Open": close.shift(1).fillna(close.iloc[0]),
            "High": close * 1.01,
            "Low": close * 0.99,
            "Close": close,
            "Volume": pd.Series(1_000_000, index=index),
        }
    )


def trending(n: int = 260, start: float = 100.0, drift: float = 0.4) -> pd.DataFrame:
    rng = np.random.default_rng(42)
    noise = rng.normal(0, 0.8, n).cumsum()
    return make_frame([start + drift * i + noise[i] for i in range(n)])


# ------------------------------------------------------------------ indicators


def test_sma_matches_manual_mean():
    df = make_frame([float(i) for i in range(1, 51)])
    points = ind.sma(df, period=10)
    # First 9 bars are warm-up and must be dropped, not emitted as nulls.
    assert len(points) == 41
    assert points[0]["value"] == pytest.approx(sum(range(1, 11)) / 10)


def test_rsi_is_bounded_and_saturates_on_unbroken_gains():
    rising = make_frame([100.0 + i for i in range(60)])
    points = ind.rsi(rising, period=14)
    assert points, "RSI produced no points"
    assert all(0 <= p["value"] <= 100 for p in points)
    # Every bar is an up-bar, so average loss is zero — RSI is 100, not NaN.
    assert points[-1]["value"] == pytest.approx(100.0)


def test_rsi_bottoms_out_on_unbroken_losses():
    falling = make_frame([200.0 - i for i in range(60)])
    points = ind.rsi(falling, period=14)
    assert points[-1]["value"] == pytest.approx(0.0, abs=1e-6)


def test_macd_components_are_consistent():
    df = trending()
    out = ind.macd(df)
    assert set(out) == {"macd", "signal", "histogram"}
    last_macd = out["macd"][-1]["value"]
    last_signal = out["signal"][-1]["value"]
    assert out["histogram"][-1]["value"] == pytest.approx(last_macd - last_signal, abs=1e-6)


def test_bollinger_bands_are_ordered():
    df = trending()
    out = ind.bollinger(df)
    for upper, middle, lower in zip(out["upper"], out["middle"], out["lower"]):
        assert upper["value"] >= middle["value"] >= lower["value"]


def test_unknown_indicator_is_rejected():
    with pytest.raises(ValueError, match="unknown indicator"):
        ind.compute(trending(), "not_a_real_indicator")


# -------------------------------------------------------------------- backtest


def test_backtest_rejects_short_history():
    with pytest.raises(ValueError, match="at least 30 bars"):
        bt.run(make_frame([100.0] * 10), bt.BacktestConfig())


def test_backtest_emits_one_equity_point_per_bar():
    df = trending()
    result = bt.run(df, bt.BacktestConfig(strategy="sma_cross"))
    assert len(result.equity_curve) == len(df)
    assert result.equity_curve[0]["value"] == pytest.approx(100_000.0)


def test_costs_make_buy_and_hold_lag_the_raw_move():
    """Round-trip commission and slippage must actually be charged."""
    df = trending()
    free = bt.run(df, bt.BacktestConfig(strategy="buy_and_hold", commission_bps=0, slippage_bps=0))
    charged = bt.run(
        df, bt.BacktestConfig(strategy="buy_and_hold", commission_bps=50, slippage_bps=50)
    )
    assert charged.stats["total_return_pct"] < free.stats["total_return_pct"]


def test_no_lookahead_signals_are_acted_on_one_bar_late():
    """A position may never open on the same bar its signal appears.

    Bar 0 has no prior signal at all, so equity must still be exactly the
    starting capital there — if a fill leaked into bar 0 this drifts.
    """
    df = trending()
    result = bt.run(df, bt.BacktestConfig(strategy="sma_cross"))
    assert result.equity_curve[0]["value"] == pytest.approx(100_000.0)
    for trade in result.trades:
        assert trade["entry_time"] > result.equity_curve[0]["time"]


def test_flat_market_leaves_capital_intact():
    df = make_frame([100.0] * 120)
    result = bt.run(df, bt.BacktestConfig(strategy="sma_cross"))
    assert result.stats["total_return_pct"] == pytest.approx(0.0, abs=1e-6)
    assert result.stats["trade_count"] == 0


def test_open_position_is_marked_to_market_at_the_end():
    """A strategy still long on the final bar must report that trade, not drop it."""
    df = trending()
    result = bt.run(df, bt.BacktestConfig(strategy="buy_and_hold"))
    assert result.stats["trade_count"] == 1
    assert result.trades[-1]["exit_time"] is not None


def test_final_equity_agrees_with_trade_accounting():
    """The equity curve's last mark must charge the same exit cost the trade
    record and the buy-and-hold benchmark charge — otherwise total_return
    overstates the strategy relative to its own trade list."""
    df = trending()
    result = bt.run(
        df, bt.BacktestConfig(strategy="buy_and_hold", commission_bps=25, slippage_bps=25)
    )
    trade = result.trades[-1]
    assert result.stats["final_equity"] == pytest.approx(
        trade["shares"] * trade["entry_price"] + trade["pnl"], rel=1e-6
    )


def test_stats_are_json_safe():
    """numpy scalars serialise fine in Python but blow up FastAPI's encoder."""
    import json

    result = bt.run(trending(), bt.BacktestConfig(strategy="ema_cross"))
    json.dumps({"stats": result.stats, "equity": result.equity_curve, "trades": result.trades})


def test_unknown_strategy_is_rejected():
    with pytest.raises(ValueError, match="unknown strategy"):
        bt.run(trending(), bt.BacktestConfig(strategy="moon_phase"))
