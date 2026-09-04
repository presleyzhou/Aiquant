# AIQUANT TERMINAL

**[中文文档 / Chinese README →](README.md)**

An honest, bilingual (中文/EN) quant research terminal: live quotes, look-ahead-free
backtesting, K-line foundation-model forecasting, and loop-engineered AI factor
mining — every number recomputed from real data, ugly results shown as-is.

**Live:** https://aiquant-rust.vercel.app

## What's inside

| Module | What it does |
|---|---|
| **US / Crypto workspaces** | Watchlists (symbol/Chinese-name/pinyin search), hourly/daily/weekly candles, indicators; crypto quotes stream live from Binance WebSocket |
| **Backtesting** | Next-bar-open fills, commission + slippage both sides, buy-and-hold benchmark always shown; SMA/EMA cross, RSI reversion, Kronos-signal strategies; walk-forward validation |
| **Kronos forecasting** | Open-source K-line foundation model ([Kronos](https://github.com/shiyu-coder/Kronos), MIT) with per-market presets (business-day vs 24×7 calendars), hourly crypto mode, and a rolling **honest accuracy panel** that scores past forecasts against the always-bullish baseline |
| **AI Factor Mining** | Chain-of-Alpha-style loop: Claude proposes factor expressions in a safe DSL (hand-rolled parser, never `eval`), a deterministic evaluator scores daily rank IC with an untouched holdout, and directive feedback steers each next round; cross-session memory, decay monitoring, cross-market transfer tests, multi-factor composites |
| **Paper trading** | Deploy any strategy/factor at a real date; NAV replays the rule from that day — everything after is out-of-sample by construction. Each card shows current position, a backtest-vs-live comparison with an edge-decay verdict, drawdown alerts, notes and CSV export; an equal-weight overview combines all deployments |
| **AI Analyst & Strategy Lab** | Claude with real tool access (quotes, indicators, backtests) and honesty rules: every cited number must come from a tool result |
| **Marketplace** | Two-sided: anyone can list strategies / factors (free or paid) with crypto-wallet or Stripe Connect payouts; buyers pay by card / Apple Pay (Stripe Checkout) or crypto (Coinbase Commerce). Server-signed entitlements gate paid payloads; Upstash/Vercel KV stores listings and the order ledger; clearly-labeled demo mode without keys |

## Honesty design

- Backtests fill on the **next** bar's open; costs charged both sides; the benchmark is always beside the result.
- Factor acceptance requires same-sign holdout confirmation; the holdout never enters LLM feedback; an empty factor zoo is a valid outcome.
- Kronos gets its own report card: rolling historical forecasts scored against what actually happened.
- Paper deployments freeze configs at real dates — forward honesty, not curve-fit hindsight.

## Quick start

```bash
# backend (Python 3.11+)
cd backend && uv venv && uv pip install -e ".[dev]" && uvicorn app.main:app --reload

# frontend
cd frontend && npm ci && npm run dev
```

Everything runs without keys (AI panels show a clear disabled notice). Optional env:
`ANTHROPIC_API_KEY` (AI features), `KRONOS_REMOTE_URL` (remote inference — see
`deploy/kronos-space/`), `SENTRY_DSN`, payments: `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `STRIPE_PAYMENT_METHODS` (e.g. `card,alipay,wechat_pay`), `COINBASE_COMMERCE_API_KEY`, `COINBASE_WEBHOOK_SECRET`, `MARKETPLACE_SECRET` (signs entitlements — required in production), `PLATFORM_FEE_PCT`, `KV_REST_API_URL` + `KV_REST_API_TOKEN` (durable listings/orders). Webhook endpoints: `/api/payments/webhooks/stripe` (event `checkout.session.completed`) and `/api/payments/webhooks/coinbase`.

## Tests

```bash
cd backend && python -m pytest -q     # 98 tests, no network
cd frontend && npx tsc -b && npm run e2e  # hermetic Playwright smoke
```

## References

Chain-of-Alpha (arXiv:2508.06312) · AlphaAgent (arXiv:2502.16789) · Alpha-GPT 2.0 ·
QuantAgent · Kronos (NeoQuasar checkpoints). Data layer reuses MIT-licensed parts of
fincept-terminal (see `backend/fincept_terminal/NOTICE.md`).

MIT License. Research and education only — nothing here is investment advice.
