/* Shareable result links: the current backtest / forecast / factor test is
 * encoded into query params, and opening such a URL replays it live — the
 * link shares the METHOD, the numbers are recomputed honestly on arrival.
 *
 * ?s=bt&sym=…&strat=…&…    backtest (runs through the preset queue)
 * ?s=kr&sym=…&h=…          Kronos forecast (auto-runs in the panel)
 * ?s=fb&expr=…&mkt=…&…     factor portfolio test (auto-runs in FactorLab)
 * ?pl=<base64url(JSON)>    end-to-end pipeline configuration (V6): pre-fills
 *                          the pipeline form, does NOT auto-run
 */

import type { PipelineFactorSpec, PipelineRunRequest } from "./api";

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

/* ---- V6 pipeline config share: the whole normalized spec as base64url JSON ---- */

/** UTF-8 safe base64url (RFC 4648 §5, unpadded) so factor expressions and
 * tickers survive the round trip untouched. */
function b64urlEncode(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(text: string): string | null {
  try {
    const b64 = text.replace(/-/g, "+").replace(/_/g, "/");
    const padded = b64 + "=".repeat((4 - (b64.length % 4)) % 4);
    const bin = atob(padded);
    return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
  } catch {
    return null;
  }
}

/** Longest `pl` payload accepted (URL sanity; a 40-ticker, 8-factor spec is ~1.5 KB). */
const PIPELINE_SHARE_MAX = 8000;

export function buildPipelineShare(spec: PipelineRunRequest): string {
  const q = new URLSearchParams({ pl: b64urlEncode(JSON.stringify(spec)) });
  return `${location.origin}/?${q}`;
}

/** Shape-check a decoded payload: only the contract's keys, only the right
 * primitive types, bounded lengths. Anything else is dropped rather than
 * trusted — the pipeline page still clamps every number against its limits. */
export function sanitizePipelineSpec(raw: unknown): PipelineRunRequest | null {
  if (!raw || typeof raw !== "object") return null;
  const r = raw as Record<string, unknown>;
  const market = typeof r.market === "string" ? r.market.slice(0, 20) : "";
  if (!market || !Array.isArray(r.factors)) return null;
  const factors: PipelineFactorSpec[] = [];
  for (const f of r.factors.slice(0, 8)) {
    if (!f || typeof f !== "object") continue;
    const ff = f as Record<string, unknown>;
    if (typeof ff.expression !== "string" || !ff.expression.trim()) continue;
    const horizon = Number(ff.horizon);
    factors.push({
      expression: ff.expression.trim().slice(0, 240),
      invert: ff.invert === true,
      horizon: Number.isFinite(horizon) && horizon > 0 ? Math.round(horizon) : 10,
    });
  }
  if (factors.length === 0) return null;
  const spec: PipelineRunRequest = { market, factors };
  const num = (key: keyof PipelineRunRequest) => {
    const v = r[key];
    return typeof v === "number" && Number.isFinite(v) ? v : undefined;
  };
  const str = (key: keyof PipelineRunRequest, max = 30) => {
    const v = r[key];
    return typeof v === "string" && v ? v.slice(0, max) : undefined;
  };
  const weighting = str("signal_weighting");
  if (weighting === "ic_expanding" || weighting === "ic" || weighting === "equal") spec.signal_weighting = weighting;
  const scheme = str("scheme");
  if (scheme) spec.scheme = scheme;
  for (const key of ["top_n", "rebalance", "max_weight", "cost_bps", "vol_lookback", "hold_buffer", "trade_rate", "shrink_to_equal"] as const) {
    const v = num(key);
    if (v !== undefined) spec[key] = v;
  }
  // target_vol_pct is tri-state: absent (keep the form), null (off), number (on)
  if (r.target_vol_pct === null) spec.target_vol_pct = null;
  else {
    const v = num("target_vol_pct");
    if (v !== undefined) spec.target_vol_pct = v;
  }
  if (typeof r.compare === "boolean") spec.compare = r.compare;
  if (Array.isArray(r.symbols)) {
    const symbols = r.symbols
      .filter((x): x is string => typeof x === "string")
      .map((x) => x.trim().toUpperCase().slice(0, 20))
      .filter(Boolean)
      .slice(0, 40);
    if (symbols.length > 0) spec.symbols = symbols;
  }
  if (r.history === "3y" || r.history === "5y") spec.history = r.history;
  return spec;
}

function decodePipelineShare(payload: string): PipelineRunRequest | null {
  if (!payload || payload.length > PIPELINE_SHARE_MAX) return null;
  const text = b64urlDecode(payload);
  if (text === null) return null;
  try {
    return sanitizePipelineSpec(JSON.parse(text));
  } catch {
    return null;
  }
}

/* ---- pending actions parsed from the URL, consumed once by their panel ---- */

let pendingKronos: KronosShare | null = null;
let pendingFactor: FactorShare | null = null;
let pendingPipeline: PipelineRunRequest | null = null;

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

/** V6: the pipeline page pre-fills its form from this once, on mount. */
export function takePipelineShare(): PipelineRunRequest | null {
  const share = pendingPipeline;
  pendingPipeline = null;
  return share;
}

export interface ParsedShare {
  kind: "bt" | "kr" | "fb" | "pl";
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
  const pl = q.get("pl");
  if (!kind && !pl) return null;
  history.replaceState(null, "", location.pathname);

  // V6 pipeline config: its own top-level key, checked first so a link that
  // (oddly) carries both never falls through to a symbol-based kind.
  if (pl) {
    const spec = decodePipelineShare(pl);
    if (!spec) return null;
    pendingPipeline = spec;
    return { kind: "pl", market: spec.market };
  }

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
