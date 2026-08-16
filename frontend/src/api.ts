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
  type: "strategy" | "skill" | "data";
  name: string;
  tagline: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  tier: "free" | "key_required" | "planned";
  risk: "low" | "medium" | "high" | null;
  integration: {
    backtest?: Record<string, unknown>;
    prompt_template?: string;
    connector?: string;
    env_key?: string;
  };
  status?: { state: string; label: string };
  price: { amount: string; currency: string } | null;
}

export interface SymbolHit {
  symbol: string;
  name: string;
  exchange: string;
  source: "local" | "yahoo";
}

export interface PaymentConfig {
  provider: string;
  real: boolean;
  note: string;
}

export interface Charge {
  charge_id: string;
  provider: string;
  status: "pending" | "confirmed" | "failed";
  demo: boolean;
  item_id?: string;
  amount?: string;
  currency?: string;
  hosted_url: string | null;
  expires_at?: string;
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

  candles: (symbol: string, period: string) =>
    fetch(`/api/market/candles/${encodeURIComponent(symbol)}?period=${period}`).then(
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

  kronosStatus: () => fetch("/api/kronos/status").then(json<KronosStatus>),

  kronosEvaluate: (symbol: string, horizon?: number) =>
    fetch("/api/kronos/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(horizon ? { symbol, horizon } : { symbol }),
    }).then(json<KronosEvaluation>),

  kronosForecast: (symbol: string, horizon?: number) =>
    fetch("/api/kronos/forecast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(horizon ? { symbol, horizon } : { symbol }),
    }).then(json<KronosForecast>),

  aiStatus: () =>
    fetch("/api/ai/status").then(
      json<{ enabled: boolean; model: string | null; effort: string | null }>,
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

  createCharge: (item_id: string) =>
    fetch("/api/payments/charges", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id }),
    }).then(json<Charge>),

  chargeStatus: (charge_id: string) =>
    fetch(`/api/payments/charges/${encodeURIComponent(charge_id)}`).then(json<Charge>),
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
    throw new Error(body.detail ?? `${res.status} ${res.statusText}`);
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
