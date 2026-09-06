"""K-line forecasting via the vendored Kronos foundation model (MIT,
github.com/shiyu-coder/Kronos) — an autoregressive transformer over tokenized
OHLCV sequences, pretrained on 45+ exchanges.

Heavy deps (torch + the HuggingFace checkpoint download) are imported lazily
on first request, never at module import: the Vercel bundle ships without
torch, so there `available()` is False and the API degrades to a clear
"not enabled" status instead of crashing the cold start.

Per-market presets — the whole point of running the same model on two very
different tapes:

* ``us``      — equities trade ~252 sessions/year, so future timestamps are
  business days and sampling runs cooler (T=0.7): daily equity bars are
  comparatively low-entropy and cooler sampling keeps the mean path stable.
* ``crypto``  — 24×7 tape, so future timestamps are calendar days (a weekend
  gap would misalign Kronos's weekday embedding), sampling runs at T=1.0 with
  a wider nucleus to respect the fatter tails, and one extra sample path is
  averaged to compensate for the added variance.
"""

from __future__ import annotations

import logging
import threading
from dataclasses import dataclass
from typing import Any

import pandas as pd

from app.config import get_settings

log = logging.getLogger("aiquant.kronos")

_HORIZON_MIN, _HORIZON_MAX = 5, 60

# Rolling evaluation / signal generation run many windows in one predict_batch
# call; a shorter fixed context keeps the batch fast while staying far above
# the model's useful lookback for daily bars.
_BATCH_CONTEXT = 256
_EVAL_CACHE: dict[tuple, dict] = {}
_EVAL_CACHE_MAX = 32


@dataclass(frozen=True)
class MarketPreset:
    calendar: str  # "bdays" | "days"
    temperature: float
    top_p: float
    sample_count: int
    context: int  # input bars fed to the model (max_context is 512)
    default_horizon: int


PRESETS: dict[str, MarketPreset] = {
    "us": MarketPreset(
        calendar="bdays", temperature=0.7, top_p=0.9, sample_count=3, context=400, default_horizon=30
    ),
    "crypto": MarketPreset(
        calendar="days", temperature=1.0, top_p=0.95, sample_count=4, context=400, default_horizon=30
    ),
}


def infer_market(symbol: str) -> str:
    return "crypto" if symbol.upper().endswith(("-USD", "-USDT")) else "us"


class KronosService:
    """Lazy singleton wrapper: one predictor, serialized inference."""

    def __init__(self) -> None:
        self._predictor: Any = None
        self._load_error: str | None = None
        self._lock = threading.Lock()

    # ------------------------------------------------------------- status

    def torch_importable(self) -> bool:
        try:
            import torch  # noqa: F401

            return True
        except Exception:
            return False

    def enabled(self) -> bool:
        if get_settings().kronos_enabled == "0":
            return False
        return self.torch_importable()

    def status(self) -> dict:
        loaded = self._predictor is not None
        return {
            "enabled": self.enabled(),
            "loaded": loaded,
            "model": get_settings().kronos_model if self.enabled() else None,
            "device": getattr(self._predictor, "device", None) if loaded else None,
            "error": self._load_error,
            "presets": {
                mkt: {
                    "calendar": p.calendar,
                    "temperature": p.temperature,
                    "top_p": p.top_p,
                    "sample_count": p.sample_count,
                    "context": p.context,
                    "default_horizon": p.default_horizon,
                }
                for mkt, p in PRESETS.items()
            },
        }

    # -------------------------------------------------------------- model

    def _get_predictor(self) -> Any:
        """Load tokenizer + checkpoint once; ~4s locally, then cached."""
        if self._predictor is not None:
            return self._predictor
        from vendor.kronos import Kronos, KronosPredictor, KronosTokenizer

        try:
            tokenizer = KronosTokenizer.from_pretrained(get_settings().kronos_tokenizer)
            model = Kronos.from_pretrained(get_settings().kronos_model)
            self._predictor = KronosPredictor(
                model, tokenizer, device=get_settings().kronos_device or None, max_context=512
            )
            log.info(
                "Kronos loaded: %s on %s", get_settings().kronos_model, self._predictor.device
            )
        except Exception as exc:  # keep the message for /status
            self._load_error = f"{type(exc).__name__}: {exc}"
            raise
        return self._predictor

    # ----------------------------------------------------------- forecast

    def forecast_blocking(
        self, df: pd.DataFrame, symbol: str, market: str, horizon: int, interval: str = "1d"
    ) -> dict:
        """Run one forecast. `df` is a yfinance OHLCV frame (daily or hourly).

        Hourly mode is crypto-only: a 24×7 tape gives clean consecutive hourly
        bars, whereas equity sessions would feed the model's hour embedding a
        gap-riddled sequence. horizon is in BARS (= hours for hourly).
        """
        preset = PRESETS[market]
        horizon = max(_HORIZON_MIN, min(_HORIZON_MAX, horizon))
        if interval == "1h" and market != "crypto":
            raise LookupError("hourly forecasts are crypto-only (equity sessions have gaps)")

        frame = pd.DataFrame(
            {
                "open": df["Open"].astype(float),
                "high": df["High"].astype(float),
                "low": df["Low"].astype(float),
                "close": df["Close"].astype(float),
                "volume": df.get("Volume", pd.Series(0.0, index=df.index)).astype(float),
            }
        ).tail(preset.context)
        if len(frame) < 64:
            raise LookupError(f"only {len(frame)} bars of history for {symbol!r}; need at least 64")

        idx = frame.index
        if getattr(idx, "tz", None) is not None:
            idx = idx.tz_convert("UTC").tz_localize(None)
        x_ts = pd.Series(idx)

        last_bar = idx[-1]
        if interval == "1h":
            future = pd.date_range(last_bar + pd.Timedelta(hours=1), periods=horizon, freq="h")
        elif preset.calendar == "bdays":
            future = pd.bdate_range(last_bar + pd.Timedelta(days=1), periods=horizon)
        else:
            future = pd.date_range(last_bar + pd.Timedelta(days=1), periods=horizon, freq="D")
        y_ts = pd.Series(future)

        predictor = self._get_predictor()
        with self._lock:  # one inference at a time — the predictor is stateful on-device
            pred = predictor.predict(
                df=frame.reset_index(drop=True),
                x_timestamp=x_ts,
                y_timestamp=y_ts,
                pred_len=horizon,
                T=preset.temperature,
                top_p=preset.top_p,
                sample_count=preset.sample_count,
                verbose=False,
            )

        # Kronos decodes each OHLCV field independently, so a row's high can
        # land below its close; report a per-bar envelope for the band.
        price_cols = ["open", "high", "low", "close"]
        pred[price_cols] = pred[price_cols].clip(lower=0.0)
        band_high = pred[price_cols].max(axis=1)
        band_low = pred[price_cols].min(axis=1)

        last_close = float(frame["close"].iloc[-1])
        pred_close = float(pred["close"].iloc[-1])

        epoch = lambda ts: int(pd.Timestamp(ts).timestamp())  # noqa: E731
        history_tail = frame.tail(120)
        history_idx = x_ts.tail(120).tolist()

        return {
            "symbol": symbol,
            "market": market,
            "model": get_settings().kronos_model,
            "device": str(predictor.device),
            "horizon": horizon,
            "interval": interval,
            "preset": {
                "calendar": preset.calendar,
                "temperature": preset.temperature,
                "top_p": preset.top_p,
                "sample_count": preset.sample_count,
                "context_bars": len(frame),
            },
            "history": [
                {"time": epoch(ts), "close": round(float(c), 6)}
                for ts, c in zip(history_idx, history_tail["close"], strict=False)
            ],
            "forecast": [
                {
                    "time": epoch(ts),
                    "close": round(float(row.close), 6),
                    "high": round(float(h), 6),
                    "low": round(float(lo), 6),
                }
                for ts, row, h, lo in zip(future, pred.itertuples(), band_high, band_low, strict=False)
            ],
            "summary": {
                "last_close": round(last_close, 6),
                "pred_close": round(pred_close, 6),
                "change_pct": round((pred_close / last_close - 1) * 100, 2) if last_close else None,
                "pred_max": round(float(band_high.max()), 6),
                "pred_min": round(float(band_low.min()), 6),
                "up_days": int((pred["close"].diff().fillna(pred["close"].iloc[0] - last_close) > 0).sum()),
            },
        }


    # ------------------------------------------------- batch helpers

    def _batch_predict(
        self,
        df: pd.DataFrame,
        anchors: list[int],
        market: str,
        horizon: int,
        sample_count: int = 2,
    ) -> list[pd.DataFrame]:
        """One predict_batch call over fixed-length windows ending at each anchor.

        Returns per-anchor forecast frames, in anchor order. `df` must already
        have lowercase OHLCV columns and a naive DatetimeIndex.
        """
        preset = PRESETS[market]
        idx = df.index

        df_list, x_list, y_list = [], [], []
        for a in anchors:
            window = df.iloc[a - _BATCH_CONTEXT + 1 : a + 1]
            df_list.append(window.reset_index(drop=True))
            x_list.append(pd.Series(window.index))
            # Real future timestamps when history has them (holiday-exact);
            # synthetic calendar for anchors that reach past the data's end.
            future = idx[a + 1 : a + 1 + horizon]
            if len(future) < horizon:
                if preset.calendar == "bdays":
                    future = pd.bdate_range(idx[a] + pd.Timedelta(days=1), periods=horizon)
                else:
                    future = pd.date_range(idx[a] + pd.Timedelta(days=1), periods=horizon, freq="D")
            y_list.append(pd.Series(future))

        predictor = self._get_predictor()
        with self._lock:
            preds = predictor.predict_batch(
                df_list,
                x_list,
                y_list,
                pred_len=horizon,
                T=preset.temperature,
                top_p=preset.top_p,
                sample_count=sample_count,
                verbose=False,
            )
        return preds

    @staticmethod
    def _normalize(df: pd.DataFrame) -> pd.DataFrame:
        """yfinance frame -> lowercase OHLCV with a naive index."""
        frame = pd.DataFrame(
            {
                "open": df["Open"].astype(float),
                "high": df["High"].astype(float),
                "low": df["Low"].astype(float),
                "close": df["Close"].astype(float),
                "volume": df.get("Volume", pd.Series(0.0, index=df.index)).astype(float),
            }
        )
        if getattr(frame.index, "tz", None) is not None:
            frame.index = frame.index.tz_convert("UTC").tz_localize(None)
        return frame

    # ---------------------------------------------------------- signals

    def signal_points_blocking(self, df: pd.DataFrame, market: str, horizon: int) -> list[dict]:
        """Kronos long/flat signal at every `horizon`-bar anchor.

        At each anchor the model sees only bars up to the anchor (no
        look-ahead); `long` means the predicted close `horizon` bars out is
        above the anchor close. The backtest engine fills at the NEXT bar's
        open, preserving its no-look-ahead convention.
        """
        horizon = max(_HORIZON_MIN, min(_HORIZON_MAX, horizon))
        frame = self._normalize(df)
        anchors = list(range(_BATCH_CONTEXT, len(frame) - 1, horizon))
        if not anchors:
            raise LookupError(
                f"kronos_signal needs more than {_BATCH_CONTEXT} bars of history "
                f"(have {len(frame)}); use a longer period"
            )

        preds = self._batch_predict(frame, anchors, market, horizon)
        closes = frame["close"].to_numpy()
        points = []
        for a, pred in zip(anchors, preds, strict=False):
            pred_close = float(pred["close"].iloc[-1])
            anchor_close = float(closes[a])
            points.append(
                {
                    "date": str(frame.index[a].date()),
                    "long": bool(pred_close > anchor_close),
                    "pred_change_pct": round((pred_close / anchor_close - 1) * 100, 2),
                }
            )
        return points

    # --------------------------------------------------------- evaluate

    def evaluate_blocking(
        self, df: pd.DataFrame, symbol: str, market: str, horizon: int, max_points: int = 24
    ) -> dict:
        """Honest rolling evaluation: weekly historical forecasts scored
        against what actually happened, with the always-bullish baseline the
        hit rate must beat to mean anything."""
        horizon = max(_HORIZON_MIN, min(_HORIZON_MAX, horizon))
        max_points = max(8, min(40, max_points))
        frame = self._normalize(df)

        cache_key = (symbol, market, horizon, max_points, str(frame.index[-1]))
        if cache_key in _EVAL_CACHE:
            return _EVAL_CACHE[cache_key]

        step = 5 if PRESETS[market].calendar == "bdays" else 7  # ~weekly either way
        last_anchor = len(frame) - 1 - horizon
        anchors = []
        a = last_anchor
        while a >= _BATCH_CONTEXT and len(anchors) < max_points:
            anchors.append(a)
            a -= step
        anchors.reverse()
        if len(anchors) < 8:
            raise LookupError(
                f"not enough history to evaluate {symbol!r}: need about "
                f"{_BATCH_CONTEXT + 8 * step + horizon} daily bars, have {len(frame)}"
            )

        preds = self._batch_predict(frame, anchors, market, horizon)
        closes = frame["close"].to_numpy()

        rows = []
        for a, pred in zip(anchors, preds, strict=False):
            anchor_close = float(closes[a])
            pred_change = (float(pred["close"].iloc[-1]) / anchor_close - 1) * 100
            actual_change = (float(closes[a + horizon]) / anchor_close - 1) * 100
            rows.append(
                {
                    "date": str(frame.index[a].date()),
                    "pred_change_pct": round(pred_change, 2),
                    "actual_change_pct": round(actual_change, 2),
                    "hit": (pred_change > 0) == (actual_change > 0),
                }
            )

        n = len(rows)
        hits = sum(r["hit"] for r in rows)
        actual_ups = sum(r["actual_change_pct"] > 0 for r in rows)
        mae = sum(abs(r["pred_change_pct"] - r["actual_change_pct"]) for r in rows) / n

        result = {
            "symbol": symbol,
            "market": market,
            "model": get_settings().kronos_model,
            "horizon": horizon,
            "n": n,
            "span": {"from": rows[0]["date"], "to": rows[-1]["date"]},
            "hit_rate_pct": round(hits / n * 100, 1),
            # What "always predict up" would have scored on the same windows —
            # the honest baseline a directional model has to beat.
            "always_up_hit_rate_pct": round(actual_ups / n * 100, 1),
            "mae_pct_points": round(mae, 2),
            "rows": rows,
        }
        if len(_EVAL_CACHE) >= _EVAL_CACHE_MAX:
            _EVAL_CACHE.pop(next(iter(_EVAL_CACHE)))
        _EVAL_CACHE[cache_key] = result
        return result


kronos_service = KronosService()
