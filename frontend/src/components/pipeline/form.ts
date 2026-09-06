import type {
  PipelineAlternative,
  PipelineConfig,
  PipelineHistory,
  PipelineResult,
  PipelineRunRequest,
  PipelineSignalWeighting,
  PipelineStarterFactor,
} from "../../api";
import type { SavedFactor } from "../../store";
import { FALLBACK_CONFIG, FORM_KEY, LAST_KEY, TRIALS_KEY } from "./constants";

/** Everything the user can set. Persisted as-is so a reload lands on the same
 * configuration; `selected` is keyed by expression so a factor stays ticked
 * whether it comes from the config starters or the browser factor zoo. */
export interface FormState {
  market: string;
  selected: string[];
  inverts: Record<string, boolean>;
  custom: Record<string, string[]>;
  signalWeighting: PipelineSignalWeighting;
  scheme: string;
  topN: number;
  rebalance: number;
  maxWeightPct: number;
  costBps: number;
  targetVolPct: number | null;
  volLookback: number;
  holdBuffer: number;
  tradeRate: number;
  /** V3: blend toward 1/N, 0–1. */
  shrinkToEqual: number;
  compare: boolean;
  /** V5: run on the user's own ticker list instead of the built-in universe. */
  customOn: boolean;
  /** V5: raw textarea contents; parsed (split, uppercased, deduped) at request time. */
  symbolsText: string;
  /** V5: panel depth. */
  history: PipelineHistory;
}


/* ---- V6 parameter presets (frontend-only) ------------------------------
 * Three risk appetites over the portfolio parameters. They deliberately leave
 * cost_bps and vol_lookback alone: those describe the market, not the appetite.
 * 平衡 / Balanced is whatever the server's defaults are. */
export type PresetId = "conservative" | "balanced" | "aggressive";
export const PRESET_IDS: PresetId[] = ["conservative", "balanced", "aggressive"];
export type PresetFields = Pick<
  FormState,
  "scheme" | "topN" | "rebalance" | "maxWeightPct" | "targetVolPct" | "holdBuffer" | "tradeRate" | "shrinkToEqual"
>;
export const PRESET_KEYS: Array<keyof PresetFields> = [
  "scheme", "topN", "rebalance", "maxWeightPct", "targetVolPct", "holdBuffer", "tradeRate", "shrinkToEqual",
];

export function presetFields(id: PresetId, d: PipelineConfig["defaults"]): PresetFields {
  switch (id) {
    case "conservative":
      return { scheme: "inverse_vol", topN: 12, rebalance: 20, maxWeightPct: 15, targetVolPct: 10, holdBuffer: 6, tradeRate: 0.5, shrinkToEqual: 0.3 };
    case "aggressive":
      return { scheme: "score", topN: 6, rebalance: 5, maxWeightPct: 30, targetVolPct: null, holdBuffer: 2, tradeRate: 1, shrinkToEqual: 0 };
    default:
      return {
        scheme: d.scheme,
        topN: d.top_n,
        rebalance: d.rebalance,
        maxWeightPct: Math.round(d.max_weight * 100),
        targetVolPct: d.target_vol_pct,
        holdBuffer: d.hold_buffer ?? FALLBACK_CONFIG.defaults.hold_buffer ?? 4,
        tradeRate: d.trade_rate ?? FALLBACK_CONFIG.defaults.trade_rate ?? 1,
        shrinkToEqual: d.shrink_to_equal ?? 0,
      };
  }
}

export const matchesPreset = (f: FormState, p: PresetFields) => PRESET_KEYS.every((k) => f[k] === p[k]);

/** V6: a shared `?pl=` spec → the form, on top of whatever the browser had.
 * Expressions the config / zoo do not know become custom factors of that
 * market so they show up (and can be removed) like any typed-in expression. */
export function formFromShare(
  spec: PipelineRunRequest,
  base: FormState,
  starters: PipelineStarterFactor[],
  zoo: SavedFactor[],
): FormState {
  const known = new Set([
    ...starters.map((f) => f.expression),
    ...zoo.filter((z) => z.market === spec.market).map((z) => z.expression),
  ]);
  const selected = [...new Set(spec.factors.map((f) => f.expression))];
  const inverts = { ...base.inverts };
  for (const f of spec.factors) inverts[f.expression] = f.invert;
  const existing = base.custom[spec.market] ?? [];
  const extra = selected.filter((e) => !known.has(e) && !existing.includes(e));
  return {
    ...base,
    market: spec.market,
    selected,
    inverts,
    custom: extra.length > 0 ? { ...base.custom, [spec.market]: [...existing, ...extra] } : base.custom,
    signalWeighting: spec.signal_weighting ?? base.signalWeighting,
    scheme: spec.scheme ?? base.scheme,
    topN: spec.top_n ?? base.topN,
    rebalance: spec.rebalance ?? base.rebalance,
    maxWeightPct: spec.max_weight === undefined ? base.maxWeightPct : Math.round(spec.max_weight * 100),
    costBps: spec.cost_bps ?? base.costBps,
    targetVolPct: spec.target_vol_pct === undefined ? base.targetVolPct : spec.target_vol_pct,
    volLookback: spec.vol_lookback ?? base.volLookback,
    holdBuffer: spec.hold_buffer ?? base.holdBuffer,
    tradeRate: spec.trade_rate ?? base.tradeRate,
    shrinkToEqual: spec.shrink_to_equal ?? base.shrinkToEqual,
    compare: spec.compare ?? base.compare,
    customOn: (spec.symbols?.length ?? 0) > 0,
    symbolsText: spec.symbols ? spec.symbols.join(", ") : base.symbolsText,
    history: spec.history ?? base.history,
  };
}

export function formFromDefaults(d: PipelineConfig["defaults"], base?: Partial<FormState>): FormState {
  return {
    market: "us",
    selected: [],
    inverts: {},
    custom: {},
    compare: true,
    customOn: false,
    symbolsText: "",
    ...base,
    history: d.history ?? "3y",
    signalWeighting: d.signal_weighting,
    scheme: d.scheme,
    topN: d.top_n,
    rebalance: d.rebalance,
    maxWeightPct: Math.round(d.max_weight * 100),
    costBps: d.cost_bps,
    targetVolPct: d.target_vol_pct,
    volLookback: d.vol_lookback,
    holdBuffer: d.hold_buffer ?? FALLBACK_CONFIG.defaults.hold_buffer ?? 4,
    tradeRate: d.trade_rate ?? FALLBACK_CONFIG.defaults.trade_rate ?? 1,
    shrinkToEqual: d.shrink_to_equal ?? 0,
  };
}

export function loadTrials(): number {
  try {
    const n = Number.parseInt(localStorage.getItem(TRIALS_KEY) ?? "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

export function saveTrials(n: number) {
  try {
    localStorage.setItem(TRIALS_KEY, String(n));
  } catch {
    /* storage unavailable — the count still lives in state for this session */
  }
}

/** Shallow shape check only — the page renders whatever the server sent, and a
 * stale or truncated blob must not crash the mount. */
export function loadLast(): PipelineResult | null {
  try {
    const raw = localStorage.getItem(LAST_KEY);
    if (!raw) return null;
    const r = JSON.parse(raw) as PipelineResult;
    if (!r || typeof r !== "object" || !r.backtest?.stats || !r.target_weights?.weights || !r.signal?.components) return null;
    return r;
  } catch {
    return null;
  }
}

export function saveLast(r: PipelineResult) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(r));
  } catch {
    /* quota exceeded or storage unavailable — the result still lives in state */
  }
}

/** V5: comma / space / newline separated tickers → uppercased, deduped, in order. */
export function parseSymbols(text: string): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const raw of text.split(/[\s,;]+/)) {
    const sym = raw.trim().toUpperCase();
    if (!sym || seen.has(sym)) continue;
    seen.add(sym);
    out.push(sym);
  }
  return out;
}

export interface HoldingLine {
  line: number;
  text: string;
  symbol?: string;
  shares?: number;
}

/** V5: "AAPL 120" / "AAPL,120" per line. A line that does not parse keeps
 * its text and line number so the UI can flag it in place. */
export function parseHoldings(text: string): HoldingLine[] {
  const out: HoldingLine[] = [];
  text.split(/\r?\n/).forEach((raw, i) => {
    const line = raw.trim();
    if (!line) return;
    const m = /^([A-Za-z0-9.^=\-]+)[\s,;:]+(\d+(?:\.\d+)?)$/.exec(line);
    if (!m) {
      out.push({ line: i + 1, text: line });
      return;
    }
    out.push({ line: i + 1, text: line, symbol: m[1].toUpperCase(), shares: Number(m[2]) });
  });
  return out;
}

export function loadForm(): FormState | null {
  try {
    const raw = localStorage.getItem(FORM_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<FormState>;
    if (!parsed || typeof parsed !== "object" || typeof parsed.market !== "string") return null;
    const base = formFromDefaults(FALLBACK_CONFIG.defaults);
    return {
      ...base,
      ...parsed,
      selected: Array.isArray(parsed.selected) ? parsed.selected.filter((x) => typeof x === "string") : [],
      inverts: parsed.inverts && typeof parsed.inverts === "object" ? parsed.inverts : {},
      custom: parsed.custom && typeof parsed.custom === "object" ? parsed.custom : {},
      customOn: parsed.customOn === true,
      symbolsText: typeof parsed.symbolsText === "string" ? parsed.symbolsText : "",
      history: parsed.history === "5y" ? "5y" : "3y",
    };
  } catch {
    return null;
  }
}

/** One tickable factor row, whichever list it came from. */
export interface FactorOption {
  expression: string;
  label: string;
  source: "starter" | "zoo" | "custom";
  horizon: number;
  defaultInvert: boolean;
  meta?: string;
}

export type AltKey = keyof Omit<PipelineAlternative, "scheme">;
