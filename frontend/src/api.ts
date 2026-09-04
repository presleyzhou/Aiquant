export interface Quote {
  symbol: string;
  price?: number;
  change?: number;
  change_pct?: number;
  previous_close?: number;
  day_high?: number;
  day_low?: number;
  volume?: number;
  currency?: string;
  as_of?: string;
  error?: string;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FactorBacktestResult {
  expression: string;
  market: string;
  top_n: number;
  rebalance: number;
  inverted: boolean;
  span: { from: string; to: string };
  stats: {
    total_return_pct: number;
    cagr_pct: number | null;
    sharpe: number;
    max_drawdown_pct: number;
    avg_turnover_pct: number;
    benchmark: { total_return_pct: number; cagr_pct: number | null; sharpe: number };
  };
  equity_curve: Point[];
  benchmark_curve: Point[];
  drawdown_curve: Point[];
}

export interface FactorCheck {
  expression: string;
  market: string;
  horizon: number;
  is_ic: number;
  oos_ic: number;
  recent_ic: number;
  recent_days: number;
  days: number;
  as_of: string;
}

export interface CompositeResult extends Omit<FactorBacktestResult, "expression" | "inverted"> {
  weighting: string;
  components: Array<{ expression: string; is_ic: number; weight: number }>;
  max_pair_corr: number;
}

export interface NewsArticle {
  title: string;
  url: string;
  publisher: string;
  published: string;
}

export interface NewsSummary {
  symbol: string;
  stance: "bullish" | "bearish" | "neutral" | "mixed";
  summary: string;
  article_count: number;
  cached: boolean;
}

export interface PaperStats {
  return_pct: number;
  bench_return_pct: number;
  excess_pct: number;
  max_drawdown_pct: number;
  current_drawdown_pct: number;
  sharpe: number | null;
  ann_vol_pct: number | null;
  win_rate_pct: number | null;
  bars: number;
  last_7d_pct: number | null;
  last_30d_pct: number | null;
  from?: string;
  to?: string;
}

export interface PaperTrack {
  kind: string;
  started_at: string;
  as_of: string;
  days_live: number;
  equity_curve: Point[];
  benchmark_curve: Point[];
  stats: PaperStats;
  pre: PaperStats;
  decay: { verdict: "holding" | "degraded" | "improved" | "insufficient"; sharpe_delta: number | null; excess_delta: number | null };
  position: { state: "long" | "flat" | "holdings" | "unknown"; symbols?: string[]; since?: string };
  trades_live: number | null;
  daily_returns: Array<{ time: number; ret_pct: number }>;
}

export interface FactorExplanation {
  expression: string;
  meaning: string;
  style: string;
  caveat: string;
  cached: boolean;
}

export interface AiStatus {
  enabled: boolean;
  model: string | null;
  effort: string | null;
  light_model?: string | null;
  usage_today?: {
    day: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    by_model: Record<string, { calls: number; input_tokens: number; output_tokens: number }>;
  };
  limits?: Record<string, number>;
}

export interface KronosBar {
  time: number;
  close: number;
  high: number;
  low: number;
}

export interface KronosForecast {
  symbol: string;
  market: "us" | "crypto";
  model: string;
  device: string;
  horizon: number;
  preset: {
    calendar: string;
    temperature: number;
    top_p: number;
    sample_count: number;
    context_bars: number;
  };
  history: Array<{ time: number; close: number }>;
  forecast: KronosBar[];
  summary: {
    last_close: number;
    pred_close: number;
    change_pct: number | null;
    pred_max: number;
    pred_min: number;
    up_days: number;
  };
}

export interface KronosEvalRow {
  date: string;
  pred_change_pct: number;
  actual_change_pct: number;
  hit: boolean;
}

export interface KronosEvaluation {
  symbol: string;
  market: string;
  model: string;
  horizon: number;
  n: number;
  span: { from: string; to: string };
  hit_rate_pct: number;
  always_up_hit_rate_pct: number;
  mae_pct_points: number;
  rows: KronosEvalRow[];
}

export interface KronosStatus {
  enabled: boolean;
  loaded: boolean;
  model: string | null;
  device: string | null;
  error: string | null;
}

export interface Point {
  time: number;
  value: number;
}

export interface BacktestStats {
  initial_capital: number;
  final_equity: number;
  total_return_pct: number;
  cagr_pct: number;
  annual_volatility_pct: number;
  sharpe: number;
  sortino: number;
  max_drawdown_pct: number;
  trade_count: number;
  win_rate_pct: number;
  profit_factor: number | null;
  avg_win: number;
  avg_loss: number;
  buy_hold_return_pct: number;
  excess_vs_buy_hold_pct: number;
  bars: number;
}

export interface BacktestResult {
  symbol: string;
  strategy: string;
  period: string;
  stats: BacktestStats;
  equity_curve: Point[];
  benchmark_curve: Point[];
  drawdown_curve: Point[];
  trades: Array<{
    entry_time: number;
    exit_time: number | null;
    entry_price: number;
    exit_price: number | null;
    shares: number;
    pnl: number | null;
    return_pct: number | null;
  }>;
}

export interface MarketItem {
  id: string;
  type: "strategy" | "skill" | "data" | "factor";
  name: string;
  tagline: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  tier: "free" | "key_required" | "planned" | "paid";
  risk: "low" | "medium" | "high" | null;
  integration: {
    backtest?: Record<string, unknown>;
    prompt_template?: string;
    connector?: string;
    env_key?: string;
    factor?: FactorPayload;
  };
  status?: { state: string; label: string };
  price: { amount: string; currency: string } | null;
  /** Community (user-listed) item fields. */
  community?: boolean;
  locked?: boolean;
  payout_method?: string;
  sales?: number;
  created_at?: number;
}

export interface FactorPayload {
  expression: string;
  market: string;
  horizon: number;
  is_ic?: number;
  is_icir?: number;
  oos_ic?: number;
  hypothesis?: string;
}

export interface MyListing extends Omit<MarketItem, "status"> {
  status: string;
  demo_sales: number;
  gross_usd: number;
  net_usd: number;
  payout: { method: string; address?: string; asset?: string; stripe_account?: string };
}

export interface ListingCreate {
  seller_secret: string;
  type: "strategy" | "factor";
  name: string;
  tagline: string;
  description: string;
  author: string;
  tags: string[];
  price_usd: number;
  risk?: "low" | "medium" | "high" | null;
  payload: Record<string, unknown>;
  payout: { method: "none" | "crypto" | "stripe"; address?: string; asset?: string; stripe_account?: string };
}

export interface SymbolHit {
  symbol: string;
  name: string;
  exchange: string;
  source: "local" | "yahoo";
}

export interface PaymentConfig {
  methods: { card: boolean; crypto: boolean };
  providers: { card: string | null; crypto: string | null };
  demo: boolean;
  connect: boolean;
  platform_fee_pct: number;
  persistence: "kv" | "file";
  note: string;
  provider: string;
  real: boolean;
}

export type PayMethod = "card" | "crypto";

export interface Checkout {
  order_id: string;
  provider: string;
  method: PayMethod;
  status: "pending" | "confirmed" | "failed";
  demo: boolean;
  item_id: string;
  amount: string;
  currency: string;
  hosted_url: string | null;
  expires_at?: string | number;
}

export interface OrderStatus {
  order_id: string;
  provider: string;
  status: "pending" | "confirmed" | "failed";
  demo: boolean;
  item_id?: string;
  token?: string;
  wallet?: Wallet;
}

export interface WalletEntry {
  id: string;
  kind: "topup" | "purchase" | "sale" | "withdraw";
  amount: number;
  demo: boolean;
  ref: string;
  note: string;
  at: number;
}

export interface Wallet {
  balance_usd: number;
  demo_usd: number;
  entries: WalletEntry[];
}

export interface TopUpCheckout extends Omit<Checkout, "item_id"> {
  kind: "topup";
}

/** @deprecated legacy crypto-only shape; kept for older callers. */
export interface Charge extends OrderStatus {
  charge_id: string;
  hosted_url: string | null;
}

export type AIEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "refusal"; message: string; category?: string | null }
  | { type: "error"; message: string }
  | { type: "done"; stop_reason: string };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch("/api/health").then(json<{ status: string; ai_enabled: boolean; model: string | null }>),

  quotes: (symbols: string[]) =>
    fetch(`/api/market/quotes?symbols=${encodeURIComponent(symbols.join(","))}`).then(
      json<{ quotes: Quote[] }>,
    ),

  candles: (symbol: string, period: string, interval?: string) =>
    fetch(
      `/api/market/candles/${encodeURIComponent(symbol)}?period=${period}${interval ? `&interval=${interval}` : ""}`,
    ).then(
      json<{ symbol: string; period: string; interval: string; candles: Candle[] }>,
    ),

  indicator: (symbol: string, name: string, history: string, period?: number) => {
    const qs = new URLSearchParams({ history });
    if (period) qs.set("period", String(period));
    return fetch(`/api/analytics/indicator/${encodeURIComponent(symbol)}/${name}?${qs}`).then(
      json<{ symbol: string; indicator: string; data: Point[] | Record<string, Point[]> }>,
    );
  },

  backtest: (body: Record<string, unknown>) =>
    fetch("/api/analytics/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<BacktestResult>),

  symbolNews: (symbol: string) =>
    fetch(`/api/market/news/${encodeURIComponent(symbol)}`).then(
      json<{ symbol: string; articles: NewsArticle[] }>,
    ),

  newsSummary: (symbol: string) =>
    fetch("/api/ai/news-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol }),
    }).then(json<NewsSummary>),

  paperTrack: (body: Record<string, unknown>) =>
    fetch("/api/paper/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<PaperTrack>),

  factorExplain: (expression: string, market: string) =>
    fetch("/api/factors/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression, market }),
    }).then(json<FactorExplanation>),

  factorComposite: (body: Record<string, unknown>) =>
    fetch("/api/factors/composite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<CompositeResult>),

  factorCheck: (expression: string, market: string, horizon: number) =>
    fetch("/api/factors/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression, market, horizon }),
    }).then(json<FactorCheck>),

  factorBacktest: (body: Record<string, unknown>) =>
    fetch("/api/factors/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<FactorBacktestResult>),

  kronosStatus: () => fetch("/api/kronos/status").then(json<KronosStatus>),

  kronosEvaluate: (symbol: string, horizon?: number) =>
    fetch("/api/kronos/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(horizon ? { symbol, horizon } : { symbol }),
    }).then(json<KronosEvaluation>),

  kronosForecast: (symbol: string, horizon?: number, interval: string = "1d") =>
    fetch("/api/kronos/forecast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(horizon ? { symbol, horizon, interval } : { symbol, interval }),
    }).then(json<KronosForecast>),

  aiStatus: () =>
    fetch("/api/ai/status").then(
      json<AiStatus>,
    ),

  marketItems: (type?: string, q?: string) => {
    const qs = new URLSearchParams();
    if (type) qs.set("type", type);
    if (q) qs.set("q", q);
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/marketplace/items${suffix}`).then(
      json<{ count: number; items: MarketItem[] }>,
    );
  },

  searchSymbols: (q: string, limit = 8) =>
    fetch(`/api/market/search?q=${encodeURIComponent(q)}&limit=${limit}`).then(
      json<{ query: string; results: SymbolHit[] }>,
    ),

  paymentConfig: () => fetch("/api/payments/config").then(json<PaymentConfig>),

  createCheckout: (item_id: string, method: PayMethod, return_url: string) =>
    fetch("/api/payments/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id, method, return_url }),
    }).then(json<Checkout>),

  orderStatus: (provider: string, order_id: string, item_id: string) =>
    fetch(
      `/api/payments/orders/${encodeURIComponent(provider)}/${encodeURIComponent(order_id)}?item_id=${encodeURIComponent(item_id)}`,
    ).then(json<OrderStatus>),

  confirmDemo: (order_id: string, item_id: string) =>
    fetch(`/api/payments/orders/demo/${encodeURIComponent(order_id)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id }),
    }).then(json<OrderStatus>),

  connectOnboard: (email: string, return_url: string) =>
    fetch("/api/payments/connect/onboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email || null, return_url }),
    }).then(json<{ account_id: string; url: string }>),

  createListing: (body: ListingCreate) =>
    fetch("/api/marketplace/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ item: MarketItem; persistence: string }>),

  myListings: (seller_secret: string) =>
    fetch("/api/marketplace/listings/mine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seller_secret }),
    }).then(json<{ listings: MyListing[]; persistence: string }>),

  removeListing: (id: string, seller_secret: string) =>
    fetch(`/api/marketplace/listings/${encodeURIComponent(id)}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seller_secret }),
    }).then(json<{ removed: string }>),

  wallet: (account_secret: string) =>
    fetch("/api/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_secret }),
    }).then(json<Wallet>),

  walletTopUp: (account_secret: string, amount_usd: number, method: PayMethod, return_url: string) =>
    fetch("/api/wallet/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_secret, amount_usd, method, return_url }),
    }).then(json<TopUpCheckout>),

  walletTopUpDemoConfirm: (order_id: string, account_secret: string, amount_usd: number) =>
    fetch(`/api/wallet/topup/demo/${encodeURIComponent(order_id)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_secret, amount_usd }),
    }).then(json<OrderStatus & { wallet: Wallet }>),

  walletPurchase: (account_secret: string, item_id: string) =>
    fetch("/api/wallet/purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_secret, item_id }),
    }).then(json<OrderStatus & { wallet: Wallet }>),

  walletWithdraw: (account_secret: string, amount_usd: number, method: "crypto" | "bank", address: string) =>
    fetch("/api/wallet/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_secret, amount_usd, method, address }),
    }).then(json<Wallet & { id: string; status: string; amount: number }>),

  listingPayload: (id: string, token: string) =>
    fetch(`/api/marketplace/listings/${encodeURIComponent(id)}/payload?token=${encodeURIComponent(token)}`).then(
      json<{ id: string; integration: MarketItem["integration"] }>,
    ),
};

export interface WalkForwardFold {
  fold: number;
  train_start: string;
  train_end: string;
  test_start: string;
  test_end: string;
  train: Record<string, number>;
  test: Record<string, number>;
  beats_benchmark: boolean;
}

export interface WalkForwardReport {
  folds: WalkForwardFold[];
  aggregate: {
    folds: number;
    train_years: number;
    test_years: number;
    oos_return_pct: number;
    oos_buy_hold_return_pct: number;
    mean_test_sharpe: number;
    worst_fold_return_pct: number;
    folds_beating_benchmark: number;
  };
}

export interface StrategyProposal {
  name: string;
  symbol: string;
  strategy: string;
  params: Record<string, unknown>;
  rationale: string;
  in_sample?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  walk_forward?: WalkForwardReport;
  risks: string[];
  beats_buy_hold: boolean;
}

export interface StrategyForm {
  symbol: string;
  objective: string;
  validation_period: string;
  notes: string;
}

/** Stream an NDJSON endpoint, invoking `onEvent` per parsed line. */
export async function streamNDJSON(
  url: string,
  body: unknown,
  onEvent: (event: AIEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    const detail =
      typeof body.detail === "string" ? body.detail : body.detail ? JSON.stringify(body.detail) : null;
    throw new Error(detail ?? `${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // The final chunk may end mid-line; keep the remainder for the next read.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as AIEvent);
      } catch {
        // A malformed line is not worth killing the whole stream over.
      }
    }
  }
  if (buffer.trim()) {
    try {
      onEvent(JSON.parse(buffer) as AIEvent);
    } catch {
      /* ignore trailing partial */
    }
  }
}

export const streamAnalysis = (
  messages: Array<{ role: string; content: string }>,
  onEvent: (event: AIEvent) => void,
  signal?: AbortSignal,
) => streamNDJSON("/api/ai/analyze", { messages }, onEvent, signal);

export const streamStrategy = (
  form: StrategyForm,
  onEvent: (event: AIEvent) => void,
  signal?: AbortSignal,
) => streamNDJSON("/api/ai/strategy", form, onEvent, signal);
