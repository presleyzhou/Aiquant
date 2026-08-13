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

/** Stream the NDJSON analysis feed, invoking `onEvent` per parsed line. */
export async function streamAnalysis(
  messages: Array<{ role: string; content: string }>,
  onEvent: (event: AIEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch("/api/ai/analyze", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ messages }),
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
