/* Shareable result links: the current backtest / forecast / factor test is
 * encoded into query params, and opening such a URL replays it live — the
 * link shares the METHOD, the numbers are recomputed honestly on arrival.
 *
 * ?s=bt&sym=…&strat=…&…    backtest (runs through the preset queue)
 * ?s=kr&sym=…&h=…          Kronos forecast (auto-runs in the panel)
 * ?s=fb&expr=…&mkt=…&…     factor portfolio test (auto-runs in FactorLab)
 */

export interface KronosShare {
  symbol: string;
  horizon: number;
  market: string;
}

export interface FactorShare {
  expression: string;
  market: string;
  top_n: number;
  rebalance: number;
  invert: boolean;
}

export function buildBacktestShare(
  market: string,
  symbol: string,
  payload: Record<string, unknown>,
): string {
  const q = new URLSearchParams({ s: "bt", mkt: market, sym: symbol });
  for (const [key, value] of Object.entries(payload)) {
    if (value !== undefined && value !== null) q.set(key, String(value));
  }
  return `${location.origin}/?${q}`;
}

export function buildKronosShare(market: string, symbol: string, horizon: number): string {
  const q = new URLSearchParams({ s: "kr", mkt: market, sym: symbol, h: String(horizon) });
  return `${location.origin}/?${q}`;
}

export function buildFactorShare(f: FactorShare): string {
  const q = new URLSearchParams({
    s: "fb",
    mkt: f.market,
    expr: f.expression,
    topn: String(f.top_n),
    reb: String(f.rebalance),
    inv: f.invert ? "1" : "0",
  });
  return `${location.origin}/?${q}`;
}

/* ---- pending actions parsed from the URL, consumed once by their panel ---- */

let pendingKronos: KronosShare | null = null;
let pendingFactor: FactorShare | null = null;

export function takeKronosShare(symbol: string): KronosShare | null {
  if (pendingKronos && pendingKronos.symbol === symbol) {
    const share = pendingKronos;
    pendingKronos = null;
    return share;
  }
  return null;
}

export function takeFactorShare(): FactorShare | null {
  const share = pendingFactor;
  pendingFactor = null;
  return share;
}

export interface ParsedShare {
  kind: "bt" | "kr" | "fb";
  market: string;
  symbol?: string;
  backtestPayload?: Record<string, unknown>;
}

/** Parse the URL once on boot; stash panel-level actions, return what the
 * App shell must do (switch view, add symbol, queue preset). Cleans the
 * query string so a reload doesn't replay the action. */
export function parseShareFromUrl(): ParsedShare | null {
  const q = new URLSearchParams(location.search);
  const kind = q.get("s");
  if (!kind) return null;
  history.replaceState(null, "", location.pathname);

  const market = q.get("mkt") === "crypto" ? "crypto" : "us";
  const symbol = (q.get("sym") ?? "").toUpperCase().slice(0, 20);

  if (kind === "bt" && symbol) {
    const payload: Record<string, unknown> = {};
    const num = (key: string) => {
      const v = Number(q.get(key));
      return Number.isFinite(v) && q.get(key) !== null && q.get(key) !== "" ? v : undefined;
    };
    const strategy = q.get("strategy");
    if (strategy) payload.strategy = strategy.slice(0, 30);
    const period = q.get("period");
    if (period) payload.period = period.slice(0, 5);
    for (const key of ["fast", "slow", "rsi_period", "rsi_oversold", "rsi_overbought", "kronos_horizon"]) {
      const v = num(key);
      if (v !== undefined) payload[key] = v;
    }
    return { kind: "bt", market, symbol, backtestPayload: payload };
  }

  if (kind === "kr" && symbol) {
    const horizon = Math.max(5, Math.min(60, Number(q.get("h")) || 30));
    pendingKronos = { symbol, horizon, market };
    return { kind: "kr", market, symbol };
  }

  if (kind === "fb") {
    const expression = (q.get("expr") ?? "").slice(0, 240);
    if (expression) {
      pendingFactor = {
        expression,
        market,
        top_n: Math.max(2, Math.min(10, Number(q.get("topn")) || 5)),
        rebalance: Math.max(1, Math.min(30, Number(q.get("reb")) || 10)),
        invert: q.get("inv") === "1",
      };
      return { kind: "fb", market };
    }
  }
  return null;
}
