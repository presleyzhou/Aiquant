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
| **End-to-End Pipeline** | Universe (built-in 60 US / 24 crypto, or a custom 8–40 ticker list with 3y/5y history) → multi-factor signal (expanding-window IC weights, so every day is out-of-sample; IC-decay curve, quintile spreads) → portfolio construction (equal / score / inverse-vol / min-variance / risk parity / **HRP** / **Grinold mean-variance** on a Ledoit-Wolf-shrunk covariance; caps, shrink-to-1/N, hold buffer, Gârleanu-Pedersen partial adjustment, vol targeting) → cost-aware backtest with price drift between rebalances, in-sample vs holdout, monthly heatmap, seven-scheme comparison with a Ledoit-Wolf bootstrap test of each scheme against 1/N → **overfitting check** (Probabilistic & Deflated Sharpe with an honest trial count, Sharpe t-stat vs the Harvey-Liu-Zhu hurdle, minimum track record length, breakeven cost, rolling half-year hit rate, a 3×3 parameter-sensitivity grid with spike detection) → risk & attribution (drawdowns, contributors, effective N, beta/TE/IR, capture ratios, CVaR, regime table, Brinson sector attribution, square-root-impact capacity curve with breakeven AUM) → target weights, one-click deploy to paper trading, a rebalance order ticket (NAV + current shares → sell-first whole-share trade list with costs) and an optional AI investment-committee memo. Pure numpy/pandas |
| **Accounts (optional)** | Supabase Auth magic-link sign-in; the backend verifies bearer tokens via `/auth/v1/user`. Signed-in users get an additive, key-aware cloud merge of factor library, lessons, paper deployments, alerts, purchases and watchlists; wallet and listings belong to the account, with a one-click claim of the browser identity. Env: `SUPABASE_URL`, `SUPABASE_ANON_KEY`, `VITE_SUPABASE_URL`, `VITE_SUPABASE_ANON_KEY`, `ADMIN_TOKEN` |
| **Robustness gate, marginal contribution, best horizon** | Strict mode requires ≥3 of 4 time folds and both market regimes to agree; a Δ button reports blend Sharpe with vs without a factor (`POST /api/factors/marginal`); the report card's best horizon becomes the default rebalance for backtests and paper deployments |
| **Tradability & multiple-testing gates** | Every candidate is also judged on Top-5 turnover and the quintile long-short spread after 10 bp costs (negative → rejected, reason fed back to the LLM; GP fitness × 0.6); the significance bar rises with cumulative trials (|t| ≥ 2.0, +0.5 per decade, capped at 3.0). Composite blends gain AlphaForge-style rolling-IC dynamic weights |
| **Factor report card** | One-click pre-trade diagnostics per factor: quintile returns and monotonicity, IC decay across horizons with best holding period, Top-N turnover and cost-adjusted spread, 4-fold rolling IC and up/down-market split, horizon-adjusted t-stat vs the t ≥ 3 bar; A/B/C grades plus actionable suggestions (`POST /api/factors/analyze`) |
| **Paper trading** | Deploy any strategy/factor at a real date; NAV replays the rule from that day — everything after is out-of-sample by construction. Each card shows current position, a backtest-vs-live comparison with an edge-decay verdict, drawdown alerts, notes and CSV export; an equal-weight overview combines all deployments |
| **AI Analyst & Strategy Lab** | Claude with real tool access (quotes, indicators, backtests) and honesty rules: every cited number must come from a tool result |
| **Marketplace** | Two-sided: anyone can list strategies / factors (free or paid) with crypto-wallet or Stripe Connect payouts; buyers pay by card / Apple Pay (Stripe Checkout) or crypto (Coinbase Commerce). Prepaid site wallet: top up by card or crypto, buy from balance, sellers are credited net of fee and can request withdrawals. Server-signed entitlements gate paid payloads; Upstash/Vercel KV stores listings and the order ledger; clearly-labeled demo mode without keys |

## Honesty design

- Backtests fill on the **next** bar's open; costs charged both sides; the benchmark is always beside the result.
- Factor acceptance requires same-sign holdout confirmation; the holdout never enters LLM feedback; an empty factor zoo is a valid outcome.
- Kronos gets its own report card: rolling historical forecasts scored against what actually happened.
- Paper deployments freeze configs at real dates — forward honesty, not curve-fit hindsight.
- Pipeline weights decided on day t earn returns from day t+1; covariances use trailing windows only; vol targeting only ever de-levers; the trailing 20% is reported as a separate holdout.

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
cd backend && python -m pytest -q     # 188 tests, no network
cd frontend && npx tsc -b && npm run e2e  # hermetic Playwright smoke
```

## References

Chain-of-Alpha (arXiv:2508.06312) · AlphaAgent (arXiv:2502.16789) · Alpha-GPT 2.0 ·
QuantAgent · Kronos (NeoQuasar checkpoints). Data layer reuses MIT-licensed parts of
fincept-terminal (see `backend/fincept_terminal/NOTICE.md`).

MIT License. Research and education only — nothing here is investment advice.
