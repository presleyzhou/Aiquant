"""Claude-backed quant analyst.

Claude is given real tools rather than a pre-baked prompt dump: it decides which
symbols to quote, which indicators to compute, and which backtests to run, then
reasons over the actual numbers those tools return. That keeps the analysis
grounded — the model cannot invent a Sharpe ratio it never asked for.

Streaming uses a manual tool loop over `messages.stream()` rather than the beta
tool runner: the runner does not auto-resume `pause_turn`, and we need per-token
output to push down the WebSocket anyway.
"""

from __future__ import annotations

import asyncio
import json
import logging
from typing import Any, AsyncIterator

from app.config import get_settings
from app.services import backtest as bt
from app.services import indicators as ind
from app.services.datasource import market_data

log = logging.getLogger(__name__)

SYSTEM_PROMPT = """You are the analysis engine of an AI quant terminal.

You have tools that return live market data, computed technical indicators, and \
backtest results. Use them. Never state a price, indicator value, or performance \
statistic you have not read out of a tool result in this conversation — if you \
need a number, fetch it.

When the user names a strategy, run it through `run_backtest` before commenting on \
it, and compare the result against the buy-and-hold benchmark the tool returns. \
Report what the numbers show, including when they are unfavourable.

Lead with the conclusion, then the evidence. Keep responses focused: cover the \
substance and skip filler sections. Use plain prose for reasoning and tables only \
for short enumerable facts.

You are not a licensed financial adviser and must not give personalised investment \
advice or tell the user what to buy or sell. Analyse instruments and strategies on \
their merits, and say plainly when something is outside what the data supports."""

TOOLS: list[dict[str, Any]] = [
    {
        "name": "get_quote",
        "description": (
            "Get the current price snapshot for one or more ticker symbols: last price, "
            "absolute and percent change on the day, day high/low, previous close and volume. "
            "Call this whenever the user asks about a stock's current level or today's move."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbols": {
                    "type": "array",
                    "items": {"type": "string"},
                    "description": "Ticker symbols, e.g. ['AAPL', 'MSFT']",
                }
            },
            "required": ["symbols"],
        },
    },
    {
        "name": "get_price_history",
        "description": (
            "Get OHLCV bars for a symbol over a period. Use this to look at trend, "
            "volatility, or a specific historical move before commenting on it."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"},
                "period": {
                    "type": "string",
                    "enum": ["1mo", "3mo", "6mo", "1y", "2y", "5y", "max"],
                    "description": "Lookback window. Defaults to 6mo.",
                },
            },
            "required": ["symbol"],
        },
    },
    {
        "name": "compute_indicator",
        "description": (
            "Compute a technical indicator over a symbol's price history and return its "
            "most recent values. Call this instead of estimating an indicator by eye."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"},
                "indicator": {
                    "type": "string",
                    "enum": ["sma", "ema", "rsi", "macd", "bollinger", "atr"],
                },
                "period": {
                    "type": "integer",
                    "description": "Lookback length where the indicator takes one (sma/ema/rsi/atr).",
                },
                "history": {
                    "type": "string",
                    "enum": ["3mo", "6mo", "1y", "2y", "5y"],
                    "description": "Price history to compute over. Defaults to 1y.",
                },
            },
            "required": ["symbol", "indicator"],
        },
    },
    {
        "name": "run_backtest",
        "description": (
            "Backtest a long-only strategy on a symbol and return performance statistics "
            "(total return, CAGR, Sharpe, Sortino, max drawdown, win rate, profit factor) "
            "alongside a buy-and-hold benchmark over the same window. Fills happen on the "
            "next bar's open with commission and slippage charged, so results are not "
            "look-ahead biased. Call this before assessing any strategy."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "symbol": {"type": "string"},
                "strategy": {
                    "type": "string",
                    "enum": ["sma_cross", "ema_cross", "rsi_reversion", "buy_and_hold", "kronos_signal"],
                },
                "period": {
                    "type": "string",
                    "enum": ["1y", "2y", "5y", "max"],
                    "description": "Backtest window. Defaults to 2y.",
                },
                "fast": {"type": "integer", "description": "Fast MA length for cross strategies."},
                "slow": {"type": "integer", "description": "Slow MA length for cross strategies."},
                "kronos_horizon": {
                    "type": "integer",
                    "description": "kronos_signal only: forecast horizon / rebalance cadence in bars (5-60, default 14).",
                },
            },
            "required": ["symbol", "strategy"],
        },
    },
]


STRATEGY_SYSTEM_PROMPT = """You are the strategy design engine of an AI quant terminal. \
Your job: design ONE runnable strategy for the user's instrument and objective, \
grounded entirely in real backtests you run yourself.

Required workflow:
1. Read the instrument's character first: fetch price history and 1-2 indicators \
(e.g. ATR for volatility, a long SMA for trend) to decide whether it rewards \
trend-following or mean-reversion.
2. Screen candidates in-sample (period "2y") with `run_backtest`. Budget: at \
most 6 screening runs — choose each variant deliberately, do not grid-scan. \
Shortlist 1-3 parameter sets. The `kronos_signal` strategy (long when the \
Kronos K-line foundation model predicts a higher close `kronos_horizon` bars \
out, flat otherwise) runs ~30 model inferences per backtest and may be \
unavailable on some deployments — if a kronos_signal call errors, drop it and \
continue with the classical strategies; use it for at most 2 of your runs.
3. Put each shortlisted set through `walk_forward` (rolling train→test folds; \
default 3 folds, 2y train / 1y test — one call runs the whole protocol). This \
is the decision that matters: judge by the AGGREGATE out-of-sample return vs \
benchmark and by fold consistency (`folds_beating_benchmark`). A set that only \
wins in one fold is curve-fit, not a strategy. At most 3 walk_forward calls.
4. Finish by calling `propose_strategy` exactly once — it is the only delivery \
channel and it validates your parameters; if it returns an error, fix and \
re-call. Copy the winning walk_forward `folds` and `aggregate` into the \
proposal's `walk_forward` field verbatim.

Honesty rules — these outrank pleasing the user:
- Every number you cite must come from a tool result in this conversation.
- If nothing beats buy-and-hold after costs, say so plainly, set \
`beats_buy_hold=false`, and either recommend buy_and_hold or explain why the \
instrument doesn't suit the requested style. A negative result delivered \
honestly is a valid outcome.
- Name the overfitting risk: parameters tuned on history may not persist. \
Include it in `risks`.
- You are not a licensed adviser; the proposal is research, not a recommendation \
to trade.

Keep interim narration to one short line per step; put the full reasoning in the \
final proposal's rationale."""

WALK_FORWARD_TOOL: dict[str, Any] = {
    "name": "walk_forward",
    "description": (
        "Rolling walk-forward validation — the professional standard for judging a "
        "parameter set. One call runs the whole protocol server-side: history is "
        "sliced into consecutive train→test folds anchored to the most recent data, "
        "the SAME parameters are evaluated in every fold (no per-fold refitting), and "
        "you get per-fold results plus a compounded out-of-sample aggregate. Judge by "
        "aggregate OOS return vs benchmark and fold consistency, not by any single fold."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "symbol": {"type": "string"},
            "strategy": {
                "type": "string",
                "enum": ["sma_cross", "ema_cross", "rsi_reversion", "buy_and_hold", "kronos_signal"],
            },
            "fast": {"type": "integer"},
            "slow": {"type": "integer"},
            "kronos_horizon": {"type": "integer", "description": "kronos_signal only: 5-60, default 14"},
            "rsi_period": {"type": "integer"},
            "rsi_oversold": {"type": "number"},
            "rsi_overbought": {"type": "number"},
            "folds": {"type": "integer", "description": "2-5, default 3"},
            "train_years": {"type": "number", "description": "0.5-5, default 2"},
            "test_years": {"type": "number", "description": "0.25-3, default 1"},
        },
        "required": ["symbol", "strategy"],
    },
}

PROPOSE_STRATEGY_TOOL: dict[str, Any] = {
    "name": "propose_strategy",
    "description": (
        "Submit the final strategy proposal. Must be called exactly once, as the last "
        "step. Parameters are validated against the backtest API contract — an error "
        "result means the proposal was NOT recorded; fix the fields and call again."
    ),
    "input_schema": {
        "type": "object",
        "properties": {
            "name": {"type": "string", "description": "策略名称（中文，专业、具体，含关键参数）"},
            "symbol": {"type": "string"},
            "strategy": {
                "type": "string",
                "enum": ["sma_cross", "ema_cross", "rsi_reversion", "buy_and_hold", "kronos_signal"],
            },
            "params": {
                "type": "object",
                "description": "回测参数。交叉类含 fast/slow；RSI 类含 rsi_period/rsi_oversold/rsi_overbought；period 为建议运行窗口。",
                "properties": {
                    "period": {"type": "string", "enum": ["1y", "2y", "5y", "max"]},
                    "fast": {"type": "integer"},
                    "slow": {"type": "integer"},
                    "rsi_period": {"type": "integer"},
                    "rsi_oversold": {"type": "number"},
                    "rsi_overbought": {"type": "number"},
                },
            },
            "rationale": {
                "type": "string",
                "description": "为什么这组参数适合该标的——引用本次对话中真实回测数字，说明标的性格判断与参数取舍。",
            },
            "in_sample": {
                "type": "object",
                "description": "样本内(2y)关键指标：period, total_return_pct, buy_hold_return_pct, sharpe, max_drawdown_pct, win_rate_pct, trade_count",
            },
            "validation": {
                "type": "object",
                "description": "样本外验证窗口关键指标，字段同 in_sample",
            },
            "walk_forward": {
                "type": "object",
                "description": (
                    "获胜参数组的滚动验证结果——原样复制 walk_forward 工具返回的 "
                    "folds 与 aggregate 两个字段，不要改写或省略。"
                ),
            },
            "risks": {
                "type": "array",
                "items": {"type": "string"},
                "description": "2-4 条主要风险与适用边界（必须包含过拟合提示）",
            },
            "beats_buy_hold": {
                "type": "boolean",
                "description": "验证窗口内是否跑赢买入持有（含成本）。必须与真实数字一致。",
            },
        },
        "required": ["name", "symbol", "strategy", "params", "rationale", "risks", "beats_buy_hold"],
    },
}

STRATEGY_TOOLS: list[dict[str, Any]] = [*TOOLS, WALK_FORWARD_TOOL, PROPOSE_STRATEGY_TOOL]


def validate_proposal(input_data: dict) -> dict | None:
    """Check a propose_strategy payload against the real backtest contract.

    Returns an error dict for Claude to fix, or None when valid. Import is
    local to avoid an api→services→api cycle.
    """
    from app.api.analytics import BacktestRequest

    params = dict(input_data.get("params") or {})
    try:
        req = BacktestRequest(
            symbol=input_data["symbol"], strategy=input_data["strategy"], **params
        )
    except Exception as exc:
        return {"error": f"params failed validation: {exc}"}
    if req.strategy in {"sma_cross", "ema_cross"} and req.fast >= req.slow:
        return {"error": "fast period must be shorter than slow period"}
    return None


class ClaudeUnavailable(RuntimeError):
    pass


class QuantAnalyst:
    def __init__(self) -> None:
        self._settings = get_settings()
        self._client = None
        # Opus 5's safety classifiers can decline a request outright. Server-side
        # fallbacks re-serve a declined request on another model inside the same
        # call, so a false positive on benign finance wording doesn't dead-end.
        # If the account lacks the beta, we notice once and stop asking for it.
        self._use_fallbacks = True

    @property
    def enabled(self) -> bool:
        return self._settings.claude_enabled

    @property
    def client(self):
        if self._client is None:
            if not self.enabled:
                raise ClaudeUnavailable(
                    "ANTHROPIC_API_KEY is not set — AI analysis is disabled. "
                    "Set it in .env and restart the backend."
                )
            from anthropic import AsyncAnthropic

            self._client = AsyncAnthropic(api_key=self._settings.anthropic_api_key)
        return self._client

    # ---------------------------------------------------------------- tool exec

    async def _kronos_want_long(self, symbol: str, period: str, df, cfg):
        """Precompute the kronos_signal series (None for classical strategies)."""
        if cfg.strategy != "kronos_signal":
            return None
        from app.api.kronos import signal_points
        from app.api.analytics import kronos_points_to_series

        points = await signal_points(symbol.upper(), period, cfg.kronos_horizon, df=df)
        return kronos_points_to_series(df, points)

    async def _run_tool(self, name: str, args: dict) -> dict:
        try:
            if name == "get_quote":
                return {"quotes": await market_data.quotes(list(args["symbols"])[:10])}

            if name == "get_price_history":
                period = args.get("period", "6mo")
                payload = await market_data.candles(args["symbol"], period=period, interval="1d")
                candles = payload["candles"]
                # Trim: the model needs shape and recent detail, not 1200 raw bars.
                return {
                    "symbol": payload["symbol"],
                    "period": period,
                    "bar_count": len(candles),
                    "first_bar": candles[0] if candles else None,
                    "recent_bars": candles[-40:],
                }

            if name == "compute_indicator":
                history = args.get("history", "1y")
                df = await market_data.history_frame(args["symbol"], history, "1d")
                params = {}
                if args.get("period") and args["indicator"] in {"sma", "ema", "rsi", "atr"}:
                    params["period"] = int(args["period"])
                result = ind.compute(df, args["indicator"], **params)
                return {
                    "symbol": args["symbol"].upper(),
                    "indicator": args["indicator"],
                    "params": params,
                    "latest": _tail_indicator(result),
                }

            if name == "walk_forward":
                df = await market_data.history_frame(args["symbol"], "max", "1d")
                cfg = bt.BacktestConfig(
                    strategy=args["strategy"],
                    fast=int(args.get("fast", 20)),
                    slow=int(args.get("slow", 50)),
                    rsi_period=int(args.get("rsi_period", 14)),
                    rsi_oversold=float(args.get("rsi_oversold", 30)),
                    rsi_overbought=float(args.get("rsi_overbought", 70)),
                    kronos_horizon=int(args.get("kronos_horizon", 14)),
                )
                want_long = await self._kronos_want_long(args["symbol"], "max", df, cfg)
                report = await asyncio.to_thread(
                    bt.walk_forward,
                    df,
                    cfg,
                    int(args.get("folds", 3)),
                    float(args.get("train_years", 2)),
                    float(args.get("test_years", 1)),
                    want_long,
                )
                return {"symbol": args["symbol"].upper(), "strategy": cfg.strategy, **report}

            if name == "propose_strategy":
                error = validate_proposal(args)
                if error:
                    return error
                return {
                    "recorded": True,
                    "note": "方案已通过参数校验并记录，可以结束回复。",
                }

            if name == "run_backtest":
                period = args.get("period", "2y")
                df = await market_data.history_frame(args["symbol"], period, "1d")
                cfg = bt.BacktestConfig(
                    strategy=args["strategy"],
                    fast=int(args.get("fast", 20)),
                    slow=int(args.get("slow", 50)),
                    kronos_horizon=int(args.get("kronos_horizon", 14)),
                )
                want_long = await self._kronos_want_long(args["symbol"], period, df, cfg)
                result = bt.run(df, cfg, want_long=want_long)
                return {
                    "symbol": args["symbol"].upper(),
                    "strategy": cfg.strategy,
                    "period": period,
                    "stats": result.stats,
                    "recent_trades": result.trades[-8:],
                }

            return {"error": f"unknown tool {name!r}"}

        except Exception as exc:
            log.warning("tool %s failed: %s", name, exc)
            return {"error": f"{type(exc).__name__}: {exc}"}

    # ------------------------------------------------------------------ streaming

    async def _stream_once(self, request: dict) -> AsyncIterator[dict]:
        """Run one streamed turn, yielding deltas then a `__final__` marker.

        Tries the beta endpoint with server-side refusal fallbacks first. If the
        account doesn't have that beta, the API rejects the request — we detect
        that once, drop back to the standard endpoint, and never retry the beta.
        """
        use_beta = self._use_fallbacks
        while True:
            if use_beta:
                stream_ctx = self.client.beta.messages.stream(
                    **request,
                    betas=["server-side-fallback-2026-07-01"],
                    fallbacks="default",
                )
            else:
                stream_ctx = self.client.messages.stream(**request)

            try:
                async with stream_ctx as stream:
                    async for event in stream:
                        if event.type == "content_block_delta":
                            if event.delta.type == "text_delta":
                                yield {"type": "text", "text": event.delta.text}
                            elif event.delta.type == "thinking_delta":
                                yield {"type": "thinking", "text": event.delta.thinking}
                    yield {"type": "__final__", "message": await stream.get_final_message()}
                return
            except Exception as exc:
                if use_beta and _is_fallback_beta_rejection(exc):
                    log.info(
                        "server-side fallbacks unavailable on this account (%s); "
                        "continuing without them",
                        exc,
                    )
                    self._use_fallbacks = False
                    use_beta = False
                    continue
                raise

    async def stream(
        self,
        messages: list[dict],
        *,
        system: str | None = None,
        tools: list[dict] | None = None,
        max_iterations: int = 8,
        max_tokens: int | None = None,
    ) -> AsyncIterator[dict]:
        """Yield analysis events. Each event is a dict with a `type` field.

        `system`/`tools` default to the analyst persona; the strategy designer
        passes its own prompt and the propose_strategy delivery tool.
        """
        if not self.enabled:
            yield {
                "type": "error",
                "message": "AI analysis is disabled: ANTHROPIC_API_KEY is not configured.",
            }
            return

        system = system or SYSTEM_PROMPT
        tools = tools or TOOLS
        convo: list[dict] = list(messages)

        for _ in range(max_iterations):  # bound the tool loop
            request: dict[str, Any] = {
                "model": self._settings.claude_model,
                "max_tokens": max_tokens or self._settings.claude_max_tokens,
                "system": system,
                "messages": convo,
                "tools": tools,
                # Adaptive thinking is the default on Opus 5; ask for the readable
                # summary so the UI can show progress instead of a silent pause.
                "thinking": {"type": "adaptive", "display": "summarized"},
                "output_config": {"effort": self._settings.claude_effort},
            }

            try:
                message = None
                async for chunk in self._stream_once(request):
                    if chunk["type"] == "__final__":
                        message = chunk["message"]
                        usage = getattr(message, "usage", None)
                        if usage is not None:
                            from app.services import usage as usage_meter

                            usage_meter.record(
                                request["model"],
                                getattr(usage, "input_tokens", 0),
                                getattr(usage, "output_tokens", 0),
                            )
                    else:
                        yield chunk
                if message is None:
                    yield {"type": "error", "message": "Claude returned no message."}
                    return
            except Exception as exc:
                log.exception("Claude request failed")
                yield {"type": "error", "message": f"{type(exc).__name__}: {exc}"}
                return

            # Safety classifiers can decline; content is empty or partial in that case.
            if message.stop_reason == "refusal":
                detail = getattr(message, "stop_details", None)
                category = getattr(detail, "category", None) if detail else None
                yield {
                    "type": "refusal",
                    "message": "The request was declined by Claude's safety classifiers.",
                    "category": category,
                }
                return

            if message.stop_reason != "tool_use":
                yield {"type": "done", "stop_reason": message.stop_reason}
                return

            convo.append({"role": "assistant", "content": message.content})

            tool_results = []
            for block in message.content:
                if block.type != "tool_use":
                    continue
                yield {"type": "tool_use", "name": block.name, "input": block.input}
                result = await self._run_tool(block.name, dict(block.input))
                yield {"type": "tool_result", "name": block.name, "result": result}
                tool_results.append(
                    {
                        "type": "tool_result",
                        "tool_use_id": block.id,
                        "content": json.dumps(result, default=str),
                        "is_error": "error" in result,
                    }
                )

            convo.append({"role": "user", "content": tool_results})

        yield {
            "type": "error",
            "message": f"Tool loop exceeded {max_iterations} iterations without finishing.",
        }


def _is_fallback_beta_rejection(exc: Exception) -> bool:
    """True when the API rejected the request because of the fallbacks beta.

    Only a 400 counts — a 401/429/500 says nothing about beta availability and
    must not silently disable the feature for the process lifetime.
    """
    if getattr(exc, "status_code", None) != 400:
        return False
    text = str(exc).lower()
    return "fallback" in text or "beta" in text


def _tail_indicator(result: dict | list, n: int = 30):
    if isinstance(result, list):
        return result[-n:]
    return {k: (v[-n:] if isinstance(v, list) else v) for k, v in result.items()}


analyst = QuantAnalyst()
