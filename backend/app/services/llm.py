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
                    "enum": ["sma_cross", "ema_cross", "rsi_reversion", "buy_and_hold"],
                },
                "period": {
                    "type": "string",
                    "enum": ["1y", "2y", "5y", "max"],
                    "description": "Backtest window. Defaults to 2y.",
                },
                "fast": {"type": "integer", "description": "Fast MA length for cross strategies."},
                "slow": {"type": "integer", "description": "Slow MA length for cross strategies."},
            },
            "required": ["symbol", "strategy"],
        },
    },
]


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

            if name == "run_backtest":
                period = args.get("period", "2y")
                df = await market_data.history_frame(args["symbol"], period, "1d")
                cfg = bt.BacktestConfig(
                    strategy=args["strategy"],
                    fast=int(args.get("fast", 20)),
                    slow=int(args.get("slow", 50)),
                )
                result = bt.run(df, cfg)
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

    async def stream(self, messages: list[dict]) -> AsyncIterator[dict]:
        """Yield analysis events. Each event is a dict with a `type` field."""
        if not self.enabled:
            yield {
                "type": "error",
                "message": "AI analysis is disabled: ANTHROPIC_API_KEY is not configured.",
            }
            return

        convo: list[dict] = list(messages)

        for _ in range(8):  # bound the tool loop
            request: dict[str, Any] = {
                "model": self._settings.claude_model,
                "max_tokens": self._settings.claude_max_tokens,
                "system": SYSTEM_PROMPT,
                "messages": convo,
                "tools": TOOLS,
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

        yield {"type": "error", "message": "Tool loop exceeded 8 iterations without finishing."}


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
