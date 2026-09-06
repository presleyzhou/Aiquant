import { Fragment, useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type PipelineAlternative,
  type PipelineAttribution,
  type PipelineCapacity,
  type PipelineConfig,
  type PipelineContributor,
  type PipelineFactorSpec,
  type PipelineHealthRow,
  type PipelineHistory,
  type PipelineMemo,
  type PipelineMemoRequest,
  type PipelineOrder,
  type PipelineOrders,
  type PipelineQuantiles,
  type PipelineRegime,
  type PipelineResult,
  type PipelineRunRequest,
  type PipelineSensitivity,
  type PipelineSignalWeighting,
  type PipelineStarterFactor,
  type Point,
} from "../api";
import { useT, type Lang, type MsgKey } from "../i18n";
import { buildPipelineShare, takePipelineShare } from "../share";
import { deployPaper, savedFactors, type SavedFactor } from "../store";
import { EquityChart } from "./EquityChart";

interface Props {
  hidden: boolean;
}

const FORM_KEY = "aiquant.pipeline.form";
/** V3: how many runs this browser has made, sent as `prior_trials` so the
 * Deflated Sharpe penalises repeated tinkering honestly. */
const TRIALS_KEY = "aiquant.pipeline.trials";
/** V4: the last successful run, restored on mount so a reload does not lose
 * the numbers (and the Markdown report) the user was looking at. */
const LAST_KEY = "aiquant.pipeline.last";
const STAGE_COUNT = 6;

/** Everything the user can set. Persisted as-is so a reload lands on the same
 * configuration; `selected` is keyed by expression so a factor stays ticked
 * whether it comes from the config starters or the browser factor zoo. */
interface FormState {
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

/** V2 select options; used when the server predates `config.signal_weightings`. */
const SIGNAL_WEIGHTINGS: PipelineSignalWeighting[] = ["ic_expanding", "ic", "equal"];
const IC_HORIZONS = [1, 2, 3, 5, 10, 15, 20];
/** V5 fallbacks for a pre-V5 config. */
const HISTORIES: PipelineHistory[] = ["3y", "5y"];
const SYMBOL_LIMITS: [number, number] = [8, 40];
/** V5: where the terminal's watchlist tab keeps its ticker arrays, per market. */
const WATCHLIST_KEYS: Record<string, string> = { us: "aiquant.watchlist", crypto: "aiquant.watchlist.crypto" };
/** V5: `min_trade_pct` bounds per the contract. */
const MIN_TRADE_RANGE: [number, number] = [0, 5];

/** Pre-config placeholder: the page must be usable before (or without) the
 * config request, so the contract's scheme ids and defaults live here too.
 * Real config overrides all of it the moment it arrives. */
const FALLBACK_CONFIG: PipelineConfig = {
  markets: ["us", "crypto"],
  universes: { us: [], crypto: [] },
  schemes: [
    { id: "equal", zh: "等权 Top-N", en: "Equal-weight Top-N", desc_zh: "入选标的等权，最简单也最难被过拟合", desc_en: "Equal weight across selected names — the hardest baseline to beat" },
    { id: "score", zh: "信号加权", en: "Score-weighted", desc_zh: "权重随合成信号强弱变化", desc_en: "Weights scale with composite signal strength" },
    { id: "inverse_vol", zh: "波动率倒数", en: "Inverse volatility", desc_zh: "波动越低权重越高，拉平各标的风险贡献", desc_en: "Lower-volatility names get more weight, levelling risk contributions" },
    { id: "min_variance", zh: "最小方差", en: "Minimum variance", desc_zh: "用协方差矩阵求组合波动最低的权重", desc_en: "Solves the covariance matrix for the lowest portfolio variance" },
    { id: "risk_parity", zh: "风险平价", en: "Risk parity", desc_zh: "每个标的贡献相同份额的组合风险", desc_en: "Every name contributes the same share of portfolio risk" },
    { id: "hrp", zh: "层次风险平价 HRP", en: "Hierarchical Risk Parity", desc_zh: "按相关性聚类后自上而下分配风险，无需求逆协方差矩阵", desc_en: "Clusters names by correlation and splits risk top-down — no covariance inversion" },
    { id: "mean_variance", zh: "均值-方差（Grinold α）", en: "Mean-variance (Grinold alpha)", desc_zh: "把信号换算成 α，与协方差一起求最优权重；最激进，也最依赖信号质量", desc_en: "Turns the signal into alpha and optimises it against covariance — the most aggressive, and the most signal-dependent" },
  ],
  signal_weightings: SIGNAL_WEIGHTINGS,
  histories: HISTORIES,
  starter_factors: { us: [], crypto: [] },
  defaults: {
    scheme: "inverse_vol",
    signal_weighting: "ic_expanding",
    top_n: 8,
    rebalance: 10,
    max_weight: 0.25,
    cost_bps: 7,
    target_vol_pct: null,
    vol_lookback: 60,
    horizon: 10,
    hold_buffer: 4,
    trade_rate: 1,
    shrink_to_equal: 0,
    history: "3y",
  },
  limits: {
    factors: [1, 8],
    top_n: [2, 20],
    rebalance: [1, 30],
    max_weight: [0.05, 1],
    cost_bps: [0, 50],
    target_vol_pct: [5, 40],
    vol_lookback: [20, 120],
    hold_buffer: [0, 20],
    trade_rate: [0.1, 1],
    shrink_to_equal: [0, 1],
    prior_trials: [0, 10000],
    symbols: SYMBOL_LIMITS,
  },
};

/** V3 group ids with a translation; anything else prints as its raw id. */
const SECTOR_IDS = new Set([
  "tech", "communication", "consumer", "staples", "financials", "health", "industrials", "energy",
  "utilities_realestate", "layer1", "layer2", "payments", "defi_infra", "meme", "other",
]);
const REGIME_IDS = new Set(["low_vol", "mid_vol", "high_vol", "uptrend", "downtrend"]);
/** Segment colours for the sector stack, cycled when a book spans more groups. */
const STACK_COLORS = [
  "rgba(59, 224, 255, 0.7)",
  "rgba(167, 139, 250, 0.7)",
  "rgba(255, 176, 0, 0.7)",
  "rgba(61, 220, 132, 0.7)",
  "rgba(255, 92, 108, 0.7)",
  "rgba(59, 224, 255, 0.4)",
  "rgba(167, 139, 250, 0.4)",
  "rgba(255, 176, 0, 0.4)",
  "rgba(61, 220, 132, 0.4)",
];

const WARNING_KEYS: Record<string, MsgKey> = {
  holdout_sharpe_collapsed: "pl.warn.holdout_sharpe_collapsed",
  high_turnover: "pl.warn.high_turnover",
  few_rebalances: "pl.warn.few_rebalances",
  concentrated: "pl.warn.concentrated",
  low_coverage: "pl.warn.low_coverage",
  low_psr: "pl.warn.low_psr",
  not_significant: "pl.warn.not_significant",
  parameter_spike: "pl.warn.parameter_spike",
  low_capacity: "pl.warn.low_capacity",
};

/* ---- V6 parameter presets (frontend-only) ------------------------------
 * Three risk appetites over the portfolio parameters. They deliberately leave
 * cost_bps and vol_lookback alone: those describe the market, not the appetite.
 * 平衡 / Balanced is whatever the server's defaults are. */
type PresetId = "conservative" | "balanced" | "aggressive";
const PRESET_IDS: PresetId[] = ["conservative", "balanced", "aggressive"];
type PresetFields = Pick<
  FormState,
  "scheme" | "topN" | "rebalance" | "maxWeightPct" | "targetVolPct" | "holdBuffer" | "tradeRate" | "shrinkToEqual"
>;
const PRESET_KEYS: Array<keyof PresetFields> = [
  "scheme", "topN", "rebalance", "maxWeightPct", "targetVolPct", "holdBuffer", "tradeRate", "shrinkToEqual",
];

function presetFields(id: PresetId, d: PipelineConfig["defaults"]): PresetFields {
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

const matchesPreset = (f: FormState, p: PresetFields) => PRESET_KEYS.every((k) => f[k] === p[k]);

/** V6: a shared `?pl=` spec → the form, on top of whatever the browser had.
 * Expressions the config / zoo do not know become custom factors of that
 * market so they show up (and can be removed) like any typed-in expression. */
function formFromShare(
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

function formFromDefaults(d: PipelineConfig["defaults"], base?: Partial<FormState>): FormState {
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

function loadTrials(): number {
  try {
    const n = Number.parseInt(localStorage.getItem(TRIALS_KEY) ?? "0", 10);
    return Number.isFinite(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function saveTrials(n: number) {
  try {
    localStorage.setItem(TRIALS_KEY, String(n));
  } catch {
    /* storage unavailable — the count still lives in state for this session */
  }
}

/** Shallow shape check only — the page renders whatever the server sent, and a
 * stale or truncated blob must not crash the mount. */
function loadLast(): PipelineResult | null {
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

function saveLast(r: PipelineResult) {
  try {
    localStorage.setItem(LAST_KEY, JSON.stringify(r));
  } catch {
    /* quota exceeded or storage unavailable — the result still lives in state */
  }
}

/** Clipboard write with the execCommand fallback for insecure contexts. */
async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.setAttribute("readonly", "");
      ta.style.position = "fixed";
      ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      document.body.removeChild(ta);
      return ok;
    } catch {
      return false;
    }
  }
}

/** V5: comma / space / newline separated tickers → uppercased, deduped, in order. */
function parseSymbols(text: string): string[] {
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

interface HoldingLine {
  line: number;
  text: string;
  symbol?: string;
  shares?: number;
}

/** V5: "AAPL 120" / "AAPL,120" per line. A line that does not parse keeps
 * its text and line number so the UI can flag it in place. */
function parseHoldings(text: string): HoldingLine[] {
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

function loadForm(): FormState | null {
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
interface FactorOption {
  expression: string;
  label: string;
  source: "starter" | "zoo" | "custom";
  horizon: number;
  defaultInvert: boolean;
  meta?: string;
}

type AltKey = keyof Omit<PipelineAlternative, "scheme">;

/** Six-stage guided pipeline: universe → signal → portfolio → backtest → risk
 * → deploy. Every number on screen comes from one /api/pipeline/run response;
 * the in-sample vs holdout split, the benchmark columns and the warnings are
 * rendered as-is so the page cannot flatter a configuration. */
export function PipelinePage({ hidden }: Props) {
  const { t, lang } = useT();
  const storedRef = useRef<FormState | null>(loadForm());
  const [form, setForm] = useState<FormState>(
    () => storedRef.current ?? formFromDefaults(FALLBACK_CONFIG.defaults),
  );
  const [config, setConfig] = useState<PipelineConfig>(FALLBACK_CONFIG);
  const [configState, setConfigState] = useState<"loading" | "ready" | "failed">("loading");
  const [zoo, setZoo] = useState<SavedFactor[]>(savedFactors);
  const [draft, setDraft] = useState("");
  const [draftError, setDraftError] = useState<string | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<PipelineResult | null>(loadLast);
  // True while the result on screen came from storage rather than this session.
  const [restored, setRestored] = useState<boolean>(() => result !== null);
  const [altSort, setAltSort] = useState<{ key: AltKey; dir: 1 | -1 }>({ key: "sharpe", dir: -1 });
  const [deployName, setDeployName] = useState("");
  const [deployed, setDeployed] = useState(false);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [mdCopied, setMdCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [stage, setStage] = useState(1);
  const [trials, setTrials] = useState<number>(loadTrials);
  const [aiEnabled, setAiEnabled] = useState(false);
  // V6: last preset clicked (the chip only shows while the form still matches it)
  const [preset, setPreset] = useState<PresetId | null>(null);
  // V6: config-link share state
  const [shareCopied, setShareCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [shareLoaded, setShareLoaded] = useState(false);
  const stageRefs = useRef<Array<HTMLElement | null>>([]);

  // V6 shared-link replay (?pl=): pre-fill the form, never run. Marking the
  // result as the "stored" form keeps the config load from resetting it to
  // the server defaults a moment later. Effect (not initializer) so a
  // StrictMode double-mount cannot lose the single-use share.
  useEffect(() => {
    const share = takePipelineShare();
    if (!share) return;
    const next = formFromShare(share, form, config.starter_factors[share.market] ?? [], zoo);
    storedRef.current = next;
    setForm(next);
    setShareLoaded(true);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // AI availability decides whether the committee-memo button is live; read
  // once, the same way the analyst panel does.
  useEffect(() => {
    let alive = true;
    api
      .aiStatus()
      .then((st) => {
        if (alive) setAiEnabled(Boolean(st.enabled));
      })
      .catch(() => {
        if (alive) setAiEnabled(false);
      });
    return () => {
      alive = false;
    };
  }, []);

  // Config: real values replace the placeholder; a fresh browser also picks
  // up the server defaults, while a stored form keeps the user's choices.
  useEffect(() => {
    let alive = true;
    api
      .pipelineConfig()
      .then((cfg) => {
        if (!alive) return;
        setConfig(cfg);
        setConfigState("ready");
        setForm((f) => {
          const next = storedRef.current ? { ...f } : formFromDefaults(cfg.defaults, f);
          if (!cfg.schemes.some((s) => s.id === next.scheme)) next.scheme = cfg.defaults.scheme;
          if (!(cfg.signal_weightings ?? SIGNAL_WEIGHTINGS).includes(next.signalWeighting)) {
            next.signalWeighting = cfg.defaults.signal_weighting;
          }
          if (!cfg.markets.includes(next.market)) next.market = cfg.markets[0] ?? "us";
          // a shared expression added as "custom" before the config arrived may be a starter after all
          const starters = new Set((cfg.starter_factors[next.market] ?? []).map((sf) => sf.expression));
          const own = next.custom[next.market] ?? [];
          if (own.some((e) => starters.has(e))) {
            next.custom = { ...next.custom, [next.market]: own.filter((e) => !starters.has(e)) };
          }
          return next;
        });
      })
      .catch(() => {
        if (alive) setConfigState("failed");
      });
    return () => {
      alive = false;
    };
  }, []);

  // The factor zoo is written by the factor-mining tab; re-read on each visit.
  useEffect(() => {
    if (!hidden) setZoo(savedFactors());
  }, [hidden]);

  useEffect(() => {
    try {
      localStorage.setItem(FORM_KEY, JSON.stringify(form));
    } catch {
      /* storage unavailable — the form still works for this session */
    }
  }, [form]);

  const patch = useCallback((p: Partial<FormState>) => setForm((f) => ({ ...f, ...p })), []);

  const limits = { ...FALLBACK_CONFIG.limits, ...config.limits };
  const maxFactors = limits.factors[1];
  const universe = config.universes[form.market] ?? [];
  const schemes = config.schemes;
  const weightings = config.signal_weightings ?? SIGNAL_WEIGHTINGS;
  const histories = config.histories ?? HISTORIES;
  // V5: the custom list, parsed live; only its size gates the run button — the
  // server does the real validation and reports what it could not deliver.
  const symbolLimits = limits.symbols ?? SYMBOL_LIMITS;
  const customSymbols = useMemo(() => parseSymbols(form.symbolsText), [form.symbolsText]);
  const universeIssue: "tooFew" | "tooMany" | null = !form.customOn
    ? null
    : customSymbols.length < symbolLimits[0]
      ? "tooFew"
      : customSymbols.length > symbolLimits[1]
        ? "tooMany"
        : null;
  const universeMsg =
    universeIssue === "tooFew"
      ? t("pl.uni.tooFew", { min: symbolLimits[0] })
      : universeIssue === "tooMany"
        ? t("pl.uni.tooMany", { max: symbolLimits[1] })
        : null;
  const [importNote, setImportNote] = useState<string | null>(null);

  /** V5: fill the textarea from the terminal's watchlist for this market. */
  const importWatchlist = () => {
    let list: string[] = [];
    try {
      const raw = localStorage.getItem(WATCHLIST_KEYS[form.market] ?? WATCHLIST_KEYS.us);
      const parsed: unknown = raw ? JSON.parse(raw) : null;
      if (Array.isArray(parsed)) list = parsed.filter((x): x is string => typeof x === "string");
    } catch {
      list = [];
    }
    const merged = parseSymbols([...customSymbols, ...list].join(" "));
    if (list.length === 0) {
      setImportNote(t("pl.uni.importEmpty"));
    } else {
      setImportNote(t("pl.uni.imported", { n: list.length }));
      patch({ symbolsText: merged.join(", ") });
    }
    window.setTimeout(() => setImportNote(null), 3000);
  };
  const schemeName = (id: string) => {
    const s = schemes.find((x) => x.id === id);
    return s ? (lang === "zh" ? s.zh : s.en) : id;
  };
  const weightingLabel = (id: string) =>
    (SIGNAL_WEIGHTINGS as string[]).includes(id) ? t(`pl.sig.w.${id}` as MsgKey) : id;

  const options = useMemo<FactorOption[]>(() => {
    const seen = new Set<string>();
    const out: FactorOption[] = [];
    for (const f of config.starter_factors[form.market] ?? []) {
      if (seen.has(f.expression)) continue;
      seen.add(f.expression);
      out.push({
        expression: f.expression,
        label: lang === "zh" ? f.zh : f.en,
        source: "starter",
        horizon: f.horizon,
        defaultInvert: f.invert,
      });
    }
    for (const f of zoo.filter((z) => z.market === form.market)) {
      if (seen.has(f.expression)) continue;
      seen.add(f.expression);
      out.push({
        expression: f.expression,
        label: f.hypothesis?.trim() || t("pl.sig.zooLabel"),
        source: "zoo",
        horizon: f.horizon,
        defaultInvert: f.is_ic < 0,
        meta: `IC ${signed3(f.is_ic)} · OOS ${signed3(f.oos_ic)} · ${f.savedAt.slice(0, 10)}`,
      });
    }
    for (const expression of form.custom[form.market] ?? []) {
      if (seen.has(expression)) continue;
      seen.add(expression);
      out.push({
        expression,
        label: t("pl.sig.customLabel"),
        source: "custom",
        horizon: config.defaults.horizon,
        defaultInvert: false,
      });
    }
    return out;
  }, [config, form.market, form.custom, zoo, lang, t]);

  const chosen = useMemo(
    () => options.filter((o) => form.selected.includes(o.expression)).slice(0, maxFactors),
    [options, form.selected, maxFactors],
  );
  const invertOf = (o: FactorOption) => form.inverts[o.expression] ?? o.defaultInvert;

  const toggleFactor = (o: FactorOption) => {
    setForm((f) => {
      const on = f.selected.includes(o.expression);
      if (on) return { ...f, selected: f.selected.filter((x) => x !== o.expression) };
      if (chosen.length >= maxFactors) return f;
      return { ...f, selected: [...f.selected, o.expression] };
    });
  };

  const addCustom = () => {
    const expr = draft.trim();
    if (!expr) return;
    if (options.some((o) => o.expression === expr)) {
      setDraftError(t("pl.sig.dup"));
      return;
    }
    setDraftError(null);
    setDraft("");
    setForm((f) => ({
      ...f,
      custom: { ...f.custom, [f.market]: [...(f.custom[f.market] ?? []), expr] },
      selected: f.selected.length < maxFactors ? [...f.selected, expr] : f.selected,
    }));
  };

  const removeCustom = (expr: string) =>
    setForm((f) => ({
      ...f,
      custom: { ...f.custom, [f.market]: (f.custom[f.market] ?? []).filter((x) => x !== expr) },
      selected: f.selected.filter((x) => x !== expr),
    }));

  const clamp = (v: number, [lo, hi]: [number, number]) => Math.min(hi, Math.max(lo, v));

  const buildRequest = (): PipelineRunRequest => ({
    market: form.market,
    factors: chosen.map<PipelineFactorSpec>((o) => ({
      expression: o.expression,
      invert: invertOf(o),
      horizon: o.horizon,
    })),
    signal_weighting: form.signalWeighting,
    scheme: form.scheme,
    top_n: clamp(Math.round(form.topN), limits.top_n),
    rebalance: clamp(Math.round(form.rebalance), limits.rebalance),
    max_weight: clamp(form.maxWeightPct / 100, limits.max_weight),
    cost_bps: clamp(form.costBps, limits.cost_bps),
    target_vol_pct: form.targetVolPct === null ? null : clamp(form.targetVolPct, limits.target_vol_pct),
    vol_lookback: clamp(Math.round(form.volLookback), limits.vol_lookback),
    hold_buffer: clamp(Math.round(form.holdBuffer), limits.hold_buffer),
    trade_rate: clamp(Math.round(form.tradeRate * 10) / 10, limits.trade_rate),
    shrink_to_equal: clamp(Math.round(form.shrinkToEqual * 10) / 10, limits.shrink_to_equal),
    prior_trials: clamp(Math.round(trials), limits.prior_trials),
    compare: form.compare,
    history: form.history,
    // V5: only when the toggle is on — an omitted key means the built-in universe
    ...(form.customOn ? { symbols: customSymbols } : {}),
  });

  const run = async () => {
    if (running || chosen.length === 0 || universeIssue !== null) return;
    setRunning(true);
    setError(null);
    setDeployed(false);
    setCopied("idle");
    setMdCopied("idle");
    setShareLoaded(false);
    try {
      const res = await api.pipelineRun(buildRequest());
      setResult(res);
      setRestored(false);
      saveLast(res);
      setTrials((n) => {
        const next = n + 1;
        saveTrials(next);
        return next;
      });
      setStage(4);
      window.setTimeout(() => stageRefs.current[3]?.scrollIntoView({ behavior: "smooth", block: "start" }), 50);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setRunning(false);
    }
  };

  // A fresh result gets a fresh default deployment name.
  useEffect(() => {
    if (!result) return;
    setDeployName(
      t("pl.deploy.defaultName", {
        s: schemeName(result.portfolio.scheme),
        n: String(result.signal.components.length),
      }),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [result]);

  const deploy = () => {
    if (!result || deployed) return;
    deployPaper(
      "pipeline",
      deployName.trim() || t("pl.deploy.defaultName", { s: result.portfolio.scheme, n: String(result.signal.components.length) }),
      result.spec as unknown as Record<string, unknown>,
    );
    setDeployed(true);
  };

  const copyCsv = async () => {
    if (!result) return;
    const rows = ["symbol,weight_pct", ...result.target_weights.weights.map((w) => `${w.symbol},${w.weight_pct.toFixed(2)}`)];
    const ok = await copyText(rows.join("\n"));
    setCopied(ok ? "ok" : "fail");
    window.setTimeout(() => setCopied("idle"), 2500);
  };

  /** V4: the stage summaries as one Markdown document in the current language. */
  const copyMarkdown = async () => {
    if (!result) return;
    const md = markdownReport(result, t, {
      market: marketLabel(result.universe.market),
      scheme: schemeName(result.portfolio.scheme),
      weighting: weightingLabel(result.signal.weighting),
      sector: (symbol: string, group?: string) => {
        const g = groupOf(symbol, group);
        return g === undefined ? undefined : sectorLabel(g);
      },
    });
    const ok = await copyText(md);
    setMdCopied(ok ? "ok" : "fail");
    window.setTimeout(() => setMdCopied("idle"), 2500);
  };

  /** V6: the normalized spec without the browser-specific trial count. */
  const shareSpec = (): PipelineRunRequest => {
    const spec = buildRequest();
    delete spec.prior_trials;
    return spec;
  };

  const shareConfig = async () => {
    if (chosen.length === 0) return;
    const ok = await copyText(buildPipelineShare(shareSpec()));
    setShareCopied(ok ? "ok" : "fail");
    window.setTimeout(() => setShareCopied("idle"), 2500);
  };

  const applyPreset = (id: PresetId) => {
    patch(presetFields(id, config.defaults));
    setPreset(id);
  };
  const activePreset = preset !== null && matchesPreset(form, presetFields(preset, config.defaults)) ? preset : null;
  const presetName = (id: PresetId) => t(`pl.preset.${id}` as MsgKey);

  const goStage = (n: number) => {
    setStage(n);
    stageRefs.current[n - 1]?.scrollIntoView({ behavior: "smooth", block: "start" });
  };

  const stageDone = [
    configState === "ready",
    chosen.length > 0,
    chosen.length > 0,
    result !== null,
    result !== null,
    deployed,
  ];

  const sortedAlts = useMemo(() => {
    if (!result) return [];
    const v = (a: PipelineAlternative) => a[altSort.key] ?? Number.NEGATIVE_INFINITY;
    return [...result.alternatives].sort((a, b) => {
      const x = v(a);
      const y = v(b);
      return x === y ? 0 : (x - y) * altSort.dir;
    });
  }, [result, altSort]);

  const toggleAltSort = (key: AltKey) =>
    setAltSort((s) => (s.key === key ? { key, dir: s.dir === 1 ? -1 : 1 } : { key, dir: -1 }));

  const sectorLabel = (id: string) => (SECTOR_IDS.has(id) ? t(`pl.sector.${id}` as MsgKey) : id);
  /** V3 group of a held name: the run's own label first, else the config's sector map. */
  const groupOf = (symbol: string, group?: string) => group ?? config.sectors?.[symbol];

  const bt = result?.backtest;
  const hasSectors =
    result !== null && result.target_weights.weights.some((w) => groupOf(w.symbol, w.group) !== undefined);
  const holdoutWarn =
    bt !== undefined && (bt.holdout.sharpe < bt.in_sample.sharpe - 0.5 || bt.holdout.excess_pct < 0);

  const marketLabel = (m: string) => (m === "crypto" ? t("fl.market.crypto") : m === "us" ? t("fl.market.us") : m);

  const setStageRef = (i: number) => (el: HTMLElement | null) => {
    stageRefs.current[i] = el;
  };

  return (
    <div className="lab" style={hidden ? { display: "none" } : undefined}>
      <div className="lab__inner">
        <section className="lab-hero">
          <h1 className="lab-hero__title">{t("pl.title")}</h1>
          <p className="lab-hero__sub">
            {t("pl.sub1")}
            <b>{t("pl.sub.b")}</b>
            {t("pl.sub2")}
          </p>
        </section>

        {/* ------------------------------------------------------ stepper */}
        <nav className="pl-stepper" aria-label={t("pl.stepper")}>
          {Array.from({ length: STAGE_COUNT }, (_, i) => i + 1).map((n) => (
            <button
              key={n}
              className={`pl-step${stage === n ? " is-active" : ""}${stageDone[n - 1] ? " is-done" : ""}`}
              onClick={() => goStage(n)}
              aria-current={stage === n ? "step" : undefined}
            >
              <span className="pl-step__num">{stageDone[n - 1] ? "✓" : n}</span>
              <span className="pl-step__label">{t(`pl.stage${n}` as MsgKey)}</span>
            </button>
          ))}
        </nav>

        {configState === "failed" && <div className="notice">{t("pl.configFailed")}</div>}

        {/* ------------------------------------------- stages 1 + 2 */}
        <div className="pl-grid">
          <section className="panel pl-card" ref={setStageRef(0)} id="pl-stage-1" tabIndex={-1}>
            <div className="panel__head">
              <span className="panel__title">① {t("pl.stage1")}</span>
              <span className="panel__meta">
                {configState === "loading"
                  ? t("pl.configLoading")
                  : form.customOn
                    ? t("pl.uni.customSize", { n: customSymbols.length })
                    : t("pl.uni.size", { n: String(universe.length) })}
              </span>
            </div>
            <div className="panel__body pl-body">
              <div className="pl-uni-row">
                <label className="field" style={{ maxWidth: 220 }}>
                  <span className="field__label">{t("fl.market")}</span>
                  <select
                    className="select"
                    value={form.market}
                    disabled={running}
                    onChange={(e) => patch({ market: e.target.value })}
                  >
                    {config.markets.map((m) => (
                      <option key={m} value={m}>
                        {marketLabel(m)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field" style={{ maxWidth: 140 }} title={t("pl.uni.historyHint")}>
                  <span className="field__label">{t("pl.uni.history")}</span>
                  <select
                    className="select"
                    value={form.history}
                    disabled={running}
                    onChange={(e) => patch({ history: e.target.value === "5y" ? "5y" : "3y" })}
                    data-testid="pl-history"
                  >
                    {histories.map((h) => (
                      <option key={h} value={h}>
                        {t(`pl.uni.h.${h}` as MsgKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">{t("pl.uni.custom")}</span>
                  <div className="pl-inline">
                    <input
                      type="checkbox"
                      className="fl-zoo-row__check"
                      checked={form.customOn}
                      disabled={running}
                      onChange={(e) => patch({ customOn: e.target.checked })}
                      aria-label={t("pl.uni.custom")}
                      data-testid="pl-custom-toggle"
                    />
                    <span className="dim">{form.customOn ? t("pl.uni.customOn") : t("pl.uni.customOff")}</span>
                  </div>
                </label>
              </div>
              {form.customOn ? (
                <div className="pl-custom" data-testid="pl-custom">
                  <textarea
                    className="textarea pl-symbols"
                    value={form.symbolsText}
                    disabled={running}
                    placeholder={t("pl.uni.customPh")}
                    onChange={(e) => patch({ symbolsText: e.target.value })}
                    aria-label={t("pl.uni.custom")}
                    spellCheck={false}
                    data-testid="pl-symbols"
                  />
                  <div className="pl-custom__bar">
                    <span
                      className={`pl-counter${universeIssue ? " is-bad" : ""}`}
                      data-testid="pl-symbols-count"
                    >
                      {t("pl.uni.counter", { n: customSymbols.length, max: symbolLimits[1], min: symbolLimits[0] })}
                    </span>
                    <button className="btn btn--mini" onClick={importWatchlist} disabled={running} data-testid="pl-import-watchlist">
                      {t("pl.uni.import")}
                    </button>
                    {importNote && <span className="dim pl-hint" data-testid="pl-import-note">{importNote}</span>}
                    {universeMsg && <span className="pl-badge pl-badge--warn" data-testid="pl-symbols-issue">{universeMsg}</span>}
                  </div>
                  <p className="dim pl-hint">{t("pl.uni.customHint")}</p>
                </div>
              ) : (
                <>
                  <p className="dim pl-hint">{t("pl.uni.hint")}</p>
                  {universe.length > 0 && (
                    <div className="chip-row pl-chip-row">
                      {universe.slice(0, 14).map((s) => (
                        <span key={s} className="chip">{s}</span>
                      ))}
                      {universe.length > 14 && (
                        <span className="chip dim">+{universe.length - 14}</span>
                      )}
                    </div>
                  )}
                </>
              )}
              <p className="dim pl-hint">{t("pl.uni.historyHint")}</p>
              {result && (
                <>
                  <div className="stat-grid pl-stats">
                    <Stat
                      label={t("pl.uni.covered")}
                      value={`${result.universe.symbols} / ${
                        result.universe.custom
                          ? result.universe.requested ?? result.universe.symbols
                          : universe.length || result.universe.symbols
                      }`}
                    />
                    <Stat label={t("pl.uni.bars")} value={String(result.universe.bars)} />
                    <Stat label={t("pl.uni.span")} value={`${result.universe.from} → ${result.universe.to}`} small />
                  </div>
                  {(result.universe.custom || result.universe.history || (result.universe.dropped?.length ?? 0) > 0) && (
                    <div className="chip-row pl-chip-row" data-testid="pl-universe-summary">
                      {result.universe.custom ? (
                        <span className="chip is-on">
                          {t("pl.uni.customSummary", { n: result.universe.symbols, h: result.universe.history ?? form.history })}
                        </span>
                      ) : (
                        result.universe.history && (
                          <span className="chip">{t("pl.uni.builtinSummary", { h: result.universe.history })}</span>
                        )
                      )}
                      {result.universe.provider && (
                        <span className="chip dim" title={t("pl.uni.providerHint")}>
                          {t("pl.uni.provider", { p: result.universe.provider })}
                        </span>
                      )}
                      {result.universe.dropped && result.universe.dropped.length > 0 && (
                        <span
                          className="pl-badge pl-badge--warn pl-dropped"
                          title={result.universe.dropped.join(", ")}
                          data-testid="pl-dropped"
                        >
                          ⚠ {t("pl.uni.dropped", { n: result.universe.dropped.length, list: result.universe.dropped.join(", ") })}
                        </span>
                      )}
                    </div>
                  )}
                  {result.universe.health && result.universe.health.length > 0 && (
                    <HealthTable rows={result.universe.health} sectorLabel={sectorLabel} />
                  )}
                </>
              )}
            </div>
          </section>

          <section className="panel pl-card" ref={setStageRef(1)} id="pl-stage-2" tabIndex={-1}>
            <div className="panel__head">
              <span className="panel__title">② {t("pl.stage2")}</span>
              <span className={`panel__meta ${chosen.length === 0 ? "dn" : ""}`}>
                {t("pl.sig.count", { n: String(chosen.length), max: String(maxFactors) })}
              </span>
            </div>
            <div className="panel__body pl-body">
              {options.length === 0 ? (
                <div className="empty">{configState === "loading" ? t("pl.configLoading") : t("pl.sig.empty")}</div>
              ) : (
                <ul className="pl-factors">
                  {options.map((o) => {
                    const on = form.selected.includes(o.expression);
                    const full = !on && chosen.length >= maxFactors;
                    return (
                      <li key={o.expression} className={`pl-factor${on ? " is-on" : ""}`}>
                        <input
                          type="checkbox"
                          className="fl-zoo-row__check"
                          checked={on}
                          disabled={full || running}
                          onChange={() => toggleFactor(o)}
                          aria-label={o.label}
                        />
                        <div className="pl-factor__main">
                          <div className="pl-factor__label">
                            {o.label}
                            <span className={`pl-src pl-src--${o.source}`}>{t(`pl.sig.src.${o.source}` as MsgKey)}</span>
                          </div>
                          <code className="pl-factor__expr">{o.expression}</code>
                          {o.meta && <div className="dim pl-factor__meta">{o.meta}</div>}
                        </div>
                        <div className="pl-factor__actions">
                          <button
                            className={`chip${invertOf(o) ? " is-on" : ""}`}
                            title={t("pl.sig.invertTitle")}
                            onClick={() => patch({ inverts: { ...form.inverts, [o.expression]: !invertOf(o) } })}
                          >
                            ↕ {t("pl.sig.invert")}
                          </button>
                          {o.source === "custom" && (
                            <button className="watch-row__x" title={t("lab.mine.del")} onClick={() => removeCustom(o.expression)}>
                              ×
                            </button>
                          )}
                        </div>
                      </li>
                    );
                  })}
                </ul>
              )}
              <form
                className="pl-add"
                onSubmit={(e) => {
                  e.preventDefault();
                  addCustom();
                }}
              >
                <input
                  className="input"
                  value={draft}
                  placeholder={t("pl.sig.addPh")}
                  onChange={(e) => {
                    setDraft(e.target.value);
                    setDraftError(null);
                  }}
                  aria-label={t("pl.sig.addLabel")}
                />
                <button className="btn" type="submit" disabled={!draft.trim()}>
                  {t("pl.sig.add")}
                </button>
              </form>
              {draftError && <div className="err">{draftError}</div>}
              <label className="field" style={{ maxWidth: 220 }}>
                <span className="field__label">{t("pl.sig.weighting")}</span>
                <select
                  className="select"
                  value={form.signalWeighting}
                  onChange={(e) => patch({ signalWeighting: e.target.value as PipelineSignalWeighting })}
                >
                  {weightings.map((w) => (
                    <option key={w} value={w}>
                      {weightingLabel(w)}
                    </option>
                  ))}
                </select>
              </label>
              {result && (
                <div className="pl-result-block">
                  <div className="dim pl-hint">
                    {t("pl.sig.head", {
                      w: weightingLabel(result.signal.weighting),
                      c: result.signal.max_pair_corr.toFixed(2),
                    })}
                  </div>
                  {result.signal.corr_matrix && result.signal.corr_matrix.length >= 2 && (
                    <>
                      <div className="pl-subhead">{t("pl.sig.corr")}</div>
                      <CorrHeatmap m={result.signal.corr_matrix} labels={result.signal.components.map((c) => c.expression)} />
                      <p className="dim pl-hint">{t("pl.sig.corrNote")}</p>
                    </>
                  )}
                  {result.signal.ic_by_horizon && result.signal.ic_by_horizon.length > 0 && (
                    <>
                      <div className="pl-subhead">
                        {t("pl.sig.decay")}
                        <span className="chip" data-testid="pl-comp-is">
                          {t("pl.sig.compIs", { v: signed3Opt(result.signal.composite_is_ic) })}
                        </span>
                        <span className="chip">{t("pl.sig.compOos", { v: signed3Opt(result.signal.composite_oos_ic) })}</span>
                      </div>
                      <IcDecayBars rows={result.signal.ic_by_horizon} />
                      <p className="dim pl-hint">{t("pl.sig.decayNote")}</p>
                    </>
                  )}
                  {result.signal.quantiles && result.signal.quantiles.buckets.length > 0 && (
                    <>
                      <div className="pl-subhead">
                        {t("pl.sig.quantiles")}
                        <span className="chip" title={t("pl.sig.spreadTitle")} data-testid="pl-spread">
                          {t("pl.sig.spread", {
                            v: signed1Opt(result.signal.quantiles.spread_ann_pct),
                            s: numOpt(result.signal.quantiles.spread_sharpe),
                          })}
                        </span>
                        {result.signal.quantiles.monotonic !== null && (
                          <span
                            className={`pl-badge ${result.signal.quantiles.monotonic ? "pl-badge--ok" : "pl-badge--warn"}`}
                            title={t("pl.sig.monoTitle")}
                            data-testid="pl-monotonic"
                          >
                            {result.signal.quantiles.monotonic ? t("pl.sig.mono") : t("pl.sig.notMono")}
                          </span>
                        )}
                      </div>
                      <QuantileBars q={result.signal.quantiles} />
                      <p className="dim pl-hint">{t("pl.sig.quantilesNote")}</p>
                    </>
                  )}
                  <div className="table-scroll">
                    <table className="lab-stats">
                      <thead>
                        <tr>
                          <th>{t("fl.z.expr")}</th>
                          <th className="pl-num">{t("pl.sig.weight")}</th>
                          <th className="pl-num">{t("pl.sig.avgWeight")}</th>
                          <th className="pl-num">{t("fl.m.isic")}</th>
                          <th className="pl-num">{t("fl.m.oosic")}</th>
                          <th className="pl-num">{t("pl.sig.standalone")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.signal.components.map((c) => (
                          <tr key={c.expression}>
                            <td>
                              <code className="pl-factor__expr">{c.expression}</code>
                              {c.invert && <span className="dim"> · {t("fl.bt.inverted")}</span>}
                              {c.active_pct !== undefined && c.active_pct < 100 && (
                                <span className="chip pl-chip--mini" title={t("pl.sig.activeTitle")} data-testid="pl-active-chip">
                                  {t("pl.sig.active", { v: c.active_pct.toFixed(0) })}
                                </span>
                              )}
                            </td>
                            <td className="pl-num">{(c.weight * 100).toFixed(0)}%</td>
                            <td className="pl-num dim">{c.avg_weight === undefined ? "—" : `${(c.avg_weight * 100).toFixed(0)}%`}</td>
                            <td className={`pl-num ${tone(c.is_ic)}`}>{signed3(c.is_ic)}</td>
                            <td className={`pl-num ${tone(c.oos_ic)}`}>{signed3(c.oos_ic)}</td>
                            <td className="pl-num">{c.standalone_sharpe.toFixed(2)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </div>
              )}
            </div>
          </section>
        </div>

        {/* ------------------------------------------------ stage 3 */}
        <section className="panel pl-card" ref={setStageRef(2)} id="pl-stage-3" tabIndex={-1}>
          <div className="panel__head">
            <span className="panel__title">③ {t("pl.stage3")}</span>
            <span className="panel__meta">{schemeName(form.scheme)}</span>
          </div>
          <div className="panel__body pl-body">
            <div className="pl-presets" data-testid="pl-presets">
              <span className="pl-presets__label">{t("pl.preset.title")}</span>
              {PRESET_IDS.map((id) => (
                <button
                  key={id}
                  className={`chip pl-preset${activePreset === id ? " is-on" : ""}`}
                  onClick={() => applyPreset(id)}
                  disabled={running}
                  title={t(`pl.preset.${id}Title` as MsgKey)}
                  aria-pressed={activePreset === id}
                  data-testid={`pl-preset-${id}`}
                >
                  {presetName(id)}
                </button>
              ))}
              {activePreset && (
                <span className="pl-badge pl-badge--ok" data-testid="pl-preset-applied">
                  ✓ {t("pl.preset.applied", { p: presetName(activePreset) })}
                </span>
              )}
              <span className="dim pl-hint pl-presets__hint">{t("pl.preset.hint")}</span>
            </div>
            <div className="pl-schemes" role="radiogroup" aria-label={t("pl.pf.scheme")}>
              {schemes.map((s) => (
                <button
                  key={s.id}
                  role="radio"
                  aria-checked={form.scheme === s.id}
                  className={`pl-scheme${form.scheme === s.id ? " is-on" : ""}`}
                  onClick={() => patch({ scheme: s.id })}
                  disabled={running}
                >
                  <span className="pl-scheme__name">{lang === "zh" ? s.zh : s.en}</span>
                  <span className="pl-scheme__desc">{lang === "zh" ? s.desc_zh : s.desc_en}</span>
                </button>
              ))}
            </div>
            <div className="pl-params">
              <NumField
                label={t("pl.pf.topN")}
                value={form.topN}
                range={limits.top_n}
                onChange={(v) => patch({ topN: v })}
                testId="pl-topn"
              />
              <NumField
                label={t("pl.pf.rebalance")}
                value={form.rebalance}
                range={limits.rebalance}
                onChange={(v) => patch({ rebalance: v })}
              />
              <NumField
                label={t("pl.pf.maxWeight")}
                value={form.maxWeightPct}
                range={[Math.round(limits.max_weight[0] * 100), Math.round(limits.max_weight[1] * 100)]}
                onChange={(v) => patch({ maxWeightPct: v })}
              />
              <NumField
                label={t("pl.pf.cost")}
                value={form.costBps}
                range={limits.cost_bps}
                onChange={(v) => patch({ costBps: v })}
              />
              <label className="field">
                <span className="field__label">{t("pl.pf.targetVol")}</span>
                <div className="pl-inline">
                  <input
                    type="checkbox"
                    className="fl-zoo-row__check"
                    checked={form.targetVolPct !== null}
                    onChange={(e) => patch({ targetVolPct: e.target.checked ? 15 : null })}
                    aria-label={t("pl.pf.targetVolOn")}
                  />
                  {form.targetVolPct === null ? (
                    <span className="dim">{t("pl.pf.off")}</span>
                  ) : (
                    <input
                      type="number"
                      className="input pl-num-input"
                      value={form.targetVolPct}
                      min={limits.target_vol_pct[0]}
                      max={limits.target_vol_pct[1]}
                      onChange={(e) => patch({ targetVolPct: Number(e.target.value) })}
                    />
                  )}
                </div>
              </label>
              <NumField
                label={t("pl.pf.volLookback")}
                value={form.volLookback}
                range={limits.vol_lookback}
                onChange={(v) => patch({ volLookback: v })}
              />
              <NumField
                label={t("pl.pf.holdBuffer")}
                value={form.holdBuffer}
                range={limits.hold_buffer}
                hint={t("pl.pf.holdBufferHint")}
                onChange={(v) => patch({ holdBuffer: v })}
              />
              <NumField
                label={t("pl.pf.tradeRate")}
                value={form.tradeRate}
                range={limits.trade_rate}
                step={0.1}
                hint={t("pl.pf.tradeRateHint")}
                onChange={(v) => patch({ tradeRate: v })}
              />
              <NumField
                label={t("pl.pf.shrink")}
                value={form.shrinkToEqual}
                range={limits.shrink_to_equal}
                step={0.1}
                hint={t("pl.pf.shrinkHint")}
                onChange={(v) => patch({ shrinkToEqual: v })}
                testId="pl-shrink"
              />
              <label className="field">
                <span className="field__label">{t("pl.pf.compare")}</span>
                <div className="pl-inline">
                  <input
                    type="checkbox"
                    className="fl-zoo-row__check"
                    checked={form.compare}
                    onChange={(e) => patch({ compare: e.target.checked })}
                    aria-label={t("pl.pf.compare")}
                  />
                  <span className="dim">{form.compare ? t("pl.pf.compareOn") : t("pl.pf.compareOff")}</span>
                </div>
              </label>
            </div>
            <p className="dim pl-hint">{t("pl.pf.hint")}</p>
            {result && (
              <div className="chip-row pl-chip-row">
                <span className="chip is-on">{schemeName(result.portfolio.scheme)}</span>
                <span className="chip">{t("pl.pf.effN", { n: result.portfolio.avg_effective_n.toFixed(1) })}</span>
                <span className="chip">{t("pl.pf.exposure", { v: result.portfolio.avg_exposure_pct.toFixed(0) })}</span>
                <span className="chip">{t("pl.pf.turnover", { v: result.portfolio.avg_turnover_pct.toFixed(1) })}</span>
                {result.portfolio.annual_turnover_x !== undefined && (
                  <span className="chip" title={t("pl.pf.annualTurnoverTitle")}>
                    {t("pl.pf.annualTurnover", { v: result.portfolio.annual_turnover_x.toFixed(1) })}
                  </span>
                )}
                {result.portfolio.breakeven_cost_bps !== undefined && (
                  <span className="chip" title={t("pl.pf.breakevenTitle")}>
                    {t("pl.pf.breakeven", {
                      v: result.portfolio.breakeven_cost_bps === null ? "—" : result.portfolio.breakeven_cost_bps.toFixed(1),
                    })}
                  </span>
                )}
                <span className="chip">{t("pl.pf.rebalances", { n: String(result.portfolio.rebalances) })}</span>
              </div>
            )}
          </div>
        </section>

        {/* ------------------------------------------------ stage 4 */}
        <section className="panel pl-card" ref={setStageRef(3)} id="pl-stage-4" tabIndex={-1}>
          <div className="panel__head">
            <span className="panel__title">④ {t("pl.stage4")}</span>
            <span className="pl-head-actions">
              {result && (
                <>
                  {mdCopied === "ok" && <span className="pl-badge pl-badge--ok" data-testid="pl-md-copied">✓ {t("pl.bt.mdCopied")}</span>}
                  {mdCopied === "fail" && <span className="pl-badge pl-badge--warn">{t("pl.bt.mdCopyFailed")}</span>}
                  <button className="btn btn--mini" onClick={copyMarkdown} data-testid="pl-copy-md">
                    {t("pl.bt.copyMd")}
                  </button>
                </>
              )}
              <span className="panel__meta">
                {bt ? `${bt.span.from} → ${bt.span.to}` : running ? t("pl.bt.running") : ""}
              </span>
            </span>
          </div>
          <div className="panel__body pl-body">
            <div className="pl-runbar">
              <button
                className="btn btn--primary"
                onClick={run}
                disabled={running || chosen.length === 0 || universeIssue !== null}
                title={universeMsg ?? undefined}
                data-testid="pl-run"
              >
                {running ? t("pl.bt.running") : t("pl.bt.run")}
              </button>
              <button
                className="btn"
                onClick={shareConfig}
                disabled={chosen.length === 0}
                title={t("pl.share.title")}
                data-testid="pl-share"
              >
                {t("pl.share.button")}
              </button>
              {shareCopied === "ok" && <span className="pl-badge pl-badge--ok" data-testid="pl-share-copied">✓ {t("pl.share.copied")}</span>}
              {shareCopied === "fail" && <span className="pl-badge pl-badge--warn">{t("pl.share.failed")}</span>}
              {shareLoaded && (
                <span className="chip pl-restored" data-testid="pl-share-loaded">
                  {t("pl.share.loaded")}
                </span>
              )}
              {restored && result && (
                <span className="chip pl-restored" data-testid="pl-restored">
                  {t("pl.bt.restored", { d: result.target_weights.as_of || result.backtest.span.to })}
                </span>
              )}
              <span className={`pl-hint ${universeMsg ? "pl-hint--warn" : "dim"}`} data-testid="pl-run-hint">
                {chosen.length === 0
                  ? t("pl.bt.needFactor")
                  : universeMsg ??
                    t("pl.bt.summary", {
                      n: String(chosen.length),
                      s: schemeName(form.scheme),
                      m: form.customOn
                        ? t("pl.uni.customSummary", { n: customSymbols.length, h: form.history })
                        : marketLabel(form.market),
                    })}
              </span>
            </div>
            <p className="pl-trials" data-testid="pl-trials">{t("pl.bt.trials", { n: String(trials) })}</p>
            {error && <div className="err">{error}</div>}

            {!bt ? (
              <div className="empty">{t("pl.bt.empty")}</div>
            ) : (
              <>
                {result && result.warnings.length > 0 && (
                  <ul className="pl-warnings">
                    {result.warnings.map((w) => (
                      <li key={w} className="pl-warning">
                        ⚠ {WARNING_KEYS[w] ? t(WARNING_KEYS[w]) : t("pl.warn.generic", { code: w })}
                      </li>
                    ))}
                  </ul>
                )}

                <div className="stat-grid pl-stats">
                  <Stat
                    label={t("bt.totalReturn")}
                    value={pct(bt.stats.total_return_pct)}
                    tone={bt.stats.total_return_pct}
                    sub={t("pl.bt.benchSub", { v: pct(bt.stats.benchmark.total_return_pct) })}
                  />
                  <Stat
                    label={t("pl.bt.excess")}
                    value={pct(bt.stats.excess_pct)}
                    tone={bt.stats.excess_pct}
                  />
                  <Stat
                    label={t("bt.cagr")}
                    value={pctOpt(bt.stats.cagr_pct)}
                    tone={bt.stats.cagr_pct ?? 0}
                    sub={t("pl.bt.benchSub", { v: pctOpt(bt.stats.benchmark.cagr_pct) })}
                  />
                  <Stat
                    label={t("bt.sharpe")}
                    value={bt.stats.sharpe.toFixed(2)}
                    tone={bt.stats.sharpe - bt.stats.benchmark.sharpe}
                    sub={t("pl.bt.benchSub", { v: bt.stats.benchmark.sharpe.toFixed(2) })}
                    testId="pl-sharpe"
                  />
                  <Stat label={t("bt.sortino")} value={bt.stats.sortino.toFixed(2)} />
                  <Stat label={t("pl.bt.calmar")} value={bt.stats.calmar.toFixed(2)} />
                  <Stat
                    label={t("bt.maxdd")}
                    value={pct(bt.stats.max_drawdown_pct)}
                    tone={-1}
                    sub={t("pl.bt.benchSub", { v: pct(bt.stats.benchmark.max_drawdown_pct) })}
                  />
                  <Stat
                    label={t("pl.bt.vol")}
                    value={`${bt.stats.ann_vol_pct.toFixed(1)}%`}
                    sub={t("pl.bt.benchSub", { v: `${bt.stats.benchmark.ann_vol_pct.toFixed(1)}%` })}
                  />
                  <Stat label={t("bt.winrate")} value={`${bt.stats.win_rate_pct.toFixed(1)}%`} />
                  {bt.stats.rolling_6m_beat_pct !== undefined && (
                    <Stat
                      label={t("pl.bt.rolling")}
                      value={bt.stats.rolling_6m_beat_pct === null ? "—" : `${bt.stats.rolling_6m_beat_pct.toFixed(1)}%`}
                      toneClass={hitTone(bt.stats.rolling_6m_beat_pct)}
                      sub={t("pl.bt.rollingSub")}
                      title={t("pl.bt.rollingTitle")}
                      testId="pl-rolling-hit"
                    />
                  )}
                </div>

                {bt.overfitting && (
                  <div className="pl-ofit" data-testid="pl-ofit">
                    <div className="pl-subhead">{t("pl.bt.ofit")}</div>
                    <div className="stat-grid pl-stats">
                      <Stat
                        label={t("pl.bt.ofit.psr")}
                        value={prob(bt.overfitting.psr)}
                        toneClass={probTone(bt.overfitting.psr)}
                        testId="pl-psr"
                      />
                      <Stat
                        label={t("pl.bt.ofit.dsr")}
                        value={prob(bt.overfitting.dsr)}
                        toneClass={probTone(bt.overfitting.dsr)}
                      />
                      <Stat label={t("pl.bt.ofit.trials")} value={String(bt.overfitting.trials)} />
                      <Stat
                        label={t("pl.bt.ofit.expMax")}
                        value={bt.overfitting.expected_max_sharpe_ann === null ? "—" : bt.overfitting.expected_max_sharpe_ann.toFixed(2)}
                        sub={t("pl.bt.ofit.expMaxTitle")}
                      />
                      <Stat
                        label={t("pl.bt.ofit.holdoutPsr")}
                        value={prob(bt.holdout.psr)}
                        toneClass={probTone(bt.holdout.psr)}
                      />
                      {bt.overfitting.t_stat !== undefined && (
                        <Stat
                          label={t("pl.bt.ofit.tstat")}
                          value={numOpt(bt.overfitting.t_stat)}
                          toneClass={tstatTone(bt.overfitting.t_stat)}
                          sub={t("pl.bt.ofit.tstatSub", { h: (bt.overfitting.hlz_hurdle ?? 3).toFixed(1) })}
                          title={t("pl.bt.ofit.tstatTitle")}
                          testId="pl-tstat"
                        />
                      )}
                      {bt.overfitting.min_track_record_days !== undefined && (
                        <Stat
                          label={t("pl.bt.ofit.mintrl")}
                          value={
                            bt.overfitting.min_track_record_days === null
                              ? t("pl.bt.ofit.mintrlNone")
                              : t("pl.bt.ofit.mintrlVal", {
                                  need: String(bt.overfitting.min_track_record_days),
                                  have: String(bt.overfitting.track_days ?? "—"),
                                })
                          }
                          toneClass={mintrlTone(bt.overfitting.min_track_record_days, bt.overfitting.track_days)}
                          title={t("pl.bt.ofit.mintrlTitle")}
                          small
                          testId="pl-mintrl"
                        />
                      )}
                    </div>
                    <p className="dim pl-hint">{t("pl.bt.ofit.note")}</p>
                  </div>
                )}

                <EquityChart equity={bt.equity_curve} benchmark={bt.benchmark_curve} drawdown={bt.drawdown_curve} />

                <div className="pl-two">
                  <div>
                    <div className="pl-subhead">
                      {t("pl.bt.split")}
                      {holdoutWarn && <span className="pl-badge pl-badge--warn">⚠ {t("pl.bt.holdoutWarn")}</span>}
                    </div>
                    <table className={`lab-stats pl-split${holdoutWarn ? " pl-split--warn" : ""}`}>
                      <thead>
                        <tr>
                          <th>{t("pp.cmp.metric")}</th>
                          <th className="pl-num">
                            {t("lab.tbl.insample")}
                            <small className="pl-th-sub">{bt.in_sample.from} → {bt.in_sample.to}</small>
                          </th>
                          <th className="pl-num">
                            {t("pl.bt.holdout")}
                            <small className="pl-th-sub">{bt.holdout.from} → {bt.holdout.to}</small>
                          </th>
                        </tr>
                      </thead>
                      <tbody>
                        <SplitRow label={t("bt.totalReturn")} a={bt.in_sample.total_return_pct} b={bt.holdout.total_return_pct} fmt={pct} />
                        <SplitRow label={t("bt.sharpe")} a={bt.in_sample.sharpe} b={bt.holdout.sharpe} fmt={num} warn={bt.holdout.sharpe < bt.in_sample.sharpe - 0.5} />
                        <SplitRow label={t("bt.maxdd")} a={bt.in_sample.max_drawdown_pct} b={bt.holdout.max_drawdown_pct} fmt={pct} invert />
                        <SplitRow label={t("pl.bt.excess")} a={bt.in_sample.excess_pct} b={bt.holdout.excess_pct} fmt={pct} warn={bt.holdout.excess_pct < 0} />
                      </tbody>
                    </table>
                    <p className="dim pl-hint">{t("pl.bt.splitNote")}</p>
                  </div>
                  <div>
                    <div className="pl-subhead">{t("pl.bt.yearly")}</div>
                    <table className="lab-stats">
                      <thead>
                        <tr>
                          <th>{t("pl.bt.year")}</th>
                          <th className="pl-num">{t("pl.bt.strategy")}</th>
                          <th className="pl-num">{t("fl.bt.bench")}</th>
                          <th className="pl-num">{t("pl.bt.excess")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bt.yearly_returns.map((y) => (
                          <tr key={y.year}>
                            <td>{y.year}</td>
                            <td className={`pl-num ${tone(y.ret_pct)}`}>{pct(y.ret_pct)}</td>
                            <td className="pl-num dim">{pct(y.bench_pct)}</td>
                            <td className={`pl-num ${tone(y.ret_pct - y.bench_pct)}`}>{pct(y.ret_pct - y.bench_pct)}</td>
                          </tr>
                        ))}
                        {bt.yearly_returns.length === 0 && (
                          <tr>
                            <td colSpan={4} className="dim">—</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>
                </div>

                <div className="pl-subhead">{t("pl.bt.monthly")}</div>
                <Heatmap rows={bt.monthly_returns} benchLabel={t("fl.bt.bench")} />

                {result && result.alternatives.length > 0 && (
                  <>
                    <div className="pl-subhead">
                      {t("pl.bt.alts")}
                      <span className="dim pl-subhead__note">{t("pl.bt.altsNote")}</span>
                    </div>
                    <div className="table-scroll pl-alts">
                      <table className="lab-stats">
                        <thead>
                          <tr>
                            <th>{t("pl.pf.scheme")}</th>
                            {(
                              [
                                ["total_return_pct", t("bt.totalReturn")],
                                ["sharpe", t("bt.sharpe")],
                                ["delta_sharpe_vs_equal_ann", t("pl.bt.deltaEq")],
                                ["p_value_vs_equal", t("pl.bt.pEq")],
                                ["psr", t("pl.bt.psr")],
                                ["max_drawdown_pct", t("bt.maxdd")],
                                ["ann_vol_pct", t("pl.bt.vol")],
                                ["avg_turnover_pct", t("pl.bt.turnover")],
                              ] as Array<[AltKey, string]>
                            ).map(([key, label]) => (
                              <th key={key} className="pl-num">
                                <button
                                  className={`pl-sort${altSort.key === key ? " is-on" : ""}`}
                                  onClick={() => toggleAltSort(key)}
                                  title={t("pl.bt.sortBy", { c: label })}
                                >
                                  {label} {altSort.key === key ? (altSort.dir === -1 ? "↓" : "↑") : ""}
                                </button>
                              </th>
                            ))}
                            <th />
                          </tr>
                        </thead>
                        <tbody>
                          {sortedAlts.map((a) => {
                            const current = a.scheme === result.portfolio.scheme;
                            return (
                              <tr key={a.scheme} className={current ? "pl-alt--current" : ""}>
                                <td>
                                  {schemeName(a.scheme)}
                                  {current && <span className="dim"> · {t("pl.bt.current")}</span>}
                                </td>
                                <td className={`pl-num ${tone(a.total_return_pct)}`}>{pct(a.total_return_pct)}</td>
                                <td className="pl-num">{a.sharpe.toFixed(2)}</td>
                                <td className={`pl-num ${tone(a.delta_sharpe_vs_equal_ann ?? 0)}`}>
                                  {signed2Opt(a.delta_sharpe_vs_equal_ann)}
                                </td>
                                <td className={`pl-num ${pTone(a.p_value_vs_equal, a.delta_sharpe_vs_equal_ann)}`} title={t("pl.bt.pEqTitle")}>
                                  {pOpt(a.p_value_vs_equal)}
                                </td>
                                <td className={`pl-num ${probTone(a.psr)}`}>{prob(a.psr)}</td>
                                <td className="pl-num dn">{pct(a.max_drawdown_pct)}</td>
                                <td className="pl-num">{a.ann_vol_pct.toFixed(1)}%</td>
                                <td className="pl-num">{a.avg_turnover_pct.toFixed(1)}%</td>
                                <td className="pl-num">
                                  {!current && (
                                    <button className="btn btn--mini" onClick={() => patch({ scheme: a.scheme })}>
                                      {t("pl.bt.useScheme")}
                                    </button>
                                  )}
                                </td>
                              </tr>
                            );
                          })}
                        </tbody>
                      </table>
                    </div>
                    <p className="dim pl-hint" data-testid="pl-alts-note">{t("pl.bt.altsEqNote")}</p>
                  </>
                )}

                {result?.sensitivity && (
                  <>
                    <div className="pl-subhead">
                      {t("pl.bt.sens")}
                      <span className="chip">{t("pl.bt.sens.median", { v: numOpt(result.sensitivity.median_sharpe) })}</span>
                      <span className="chip">{t("pl.bt.sens.min", { v: numOpt(result.sensitivity.min_sharpe) })}</span>
                      <span
                        className={`chip ${spikeTone(result.sensitivity.spike)}`}
                        title={t("pl.bt.sens.spikeTitle")}
                        data-testid="pl-spike"
                      >
                        {t("pl.bt.sens.spike", { v: signed2Opt(result.sensitivity.spike) })}
                      </span>
                    </div>
                    <SensitivityGrid
                      s={result.sensitivity}
                      chosenTopN={result.portfolio.top_n}
                      chosenRebalance={result.portfolio.rebalance}
                    />
                    <p className="dim pl-hint">{t("pl.bt.sens.note")}</p>
                  </>
                )}
              </>
            )}
          </div>
        </section>

        {/* -------------------------------------------- stages 5 + 6 */}
        <div className="pl-grid">
          <section className="panel pl-card" ref={setStageRef(4)} id="pl-stage-5" tabIndex={-1}>
            <div className="panel__head">
              <span className="panel__title">⑤ {t("pl.stage5")}</span>
            </div>
            <div className="panel__body pl-body">
              {!result || !bt ? (
                <div className="empty">{t("pl.bt.empty")}</div>
              ) : (
                <>
                  <div className="chip-row pl-chip-row">
                    <span className="chip" title={t("pl.risk.effNTitle")}>
                      {t("pl.pf.effN", { n: result.risk.concentration.avg_effective_n.toFixed(1) })}
                    </span>
                    <span className="chip" title={t("pl.risk.capTitle")}>
                      {t("pl.risk.cap", { v: result.risk.concentration.cap_binding_pct.toFixed(0) })}
                    </span>
                    <span className="chip">β {bt.stats.beta.toFixed(2)}</span>
                    <span className="chip">{t("pl.risk.te")} {bt.stats.tracking_error_pct.toFixed(1)}%</span>
                    <span className="chip">IR {bt.stats.information_ratio.toFixed(2)}</span>
                    <span className="chip">{t("pl.risk.corr")} {result.risk.correlation_to_benchmark.toFixed(2)}</span>
                  </div>

                  {(result.risk.capture || result.risk.cvar_95_pct !== undefined) && (
                    <div className="chip-row pl-chip-row" data-testid="pl-capture">
                      {result.risk.capture && (
                        <>
                          <span className={`chip ${captureTone(result.risk.capture.up, true)}`} title={t("pl.risk.captureTitle")}>
                            ↗ {t("pl.risk.captureUp", { v: ratio(result.risk.capture.up), n: String(result.risk.capture.up_periods) })}
                          </span>
                          <span className={`chip ${captureTone(result.risk.capture.down, false)}`} title={t("pl.risk.captureTitle")}>
                            ↘ {t("pl.risk.captureDown", { v: ratio(result.risk.capture.down), n: String(result.risk.capture.down_periods) })}
                          </span>
                        </>
                      )}
                      {result.risk.cvar_95_pct !== undefined && (
                        <span className="chip" title={t("pl.risk.cvarTitle")}>
                          {t("pl.risk.cvar", { v: numOpt(result.risk.cvar_95_pct) })}
                          {result.risk.bench_cvar_95_pct !== undefined && (
                            <span className="dim"> · {t("pl.risk.cvarBench", { v: numOpt(result.risk.bench_cvar_95_pct) })}</span>
                          )}
                        </span>
                      )}
                    </div>
                  )}

                  <div className="pl-subhead">
                    {t("pl.risk.exposure")}
                    <span className="dim pl-subhead__note">
                      {t("pl.pf.exposure", { v: result.portfolio.avg_exposure_pct.toFixed(0) })}
                    </span>
                  </div>
                  <Sparkline data={bt.exposure_curve} refValue={100} floor={0} />

                  {result.risk.rolling_beta && result.risk.rolling_beta.length >= 2 && (
                    <>
                      <div className="pl-subhead pl-subhead--case">
                        {t("pl.risk.rollingBeta")}
                        <span className="dim pl-subhead__note">
                          {t("pl.risk.rollingBetaNote", {
                            v: result.risk.rolling_beta[result.risk.rolling_beta.length - 1].value.toFixed(2),
                            lo: Math.min(...result.risk.rolling_beta.map((p) => p.value)).toFixed(2),
                            hi: Math.max(...result.risk.rolling_beta.map((p) => p.value)).toFixed(2),
                          })}
                        </span>
                      </div>
                      <Sparkline data={result.risk.rolling_beta} refValue={1} className="pl-spark--beta" testId="pl-rolling-beta" />
                    </>
                  )}

                  <div className="pl-subhead">{t("pl.risk.drawdowns")}</div>
                  <div className="table-scroll">
                    <table className="lab-stats">
                      <thead>
                        <tr>
                          <th>{t("pl.risk.peak")}</th>
                          <th>{t("pl.risk.trough")}</th>
                          <th>{t("pl.risk.recovery")}</th>
                          <th className="pl-num">{t("pl.risk.depth")}</th>
                          <th className="pl-num">{t("pl.risk.days")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.risk.drawdowns.map((d) => (
                          <tr key={`${d.peak}-${d.trough}`}>
                            <td>{d.peak}</td>
                            <td>{d.trough}</td>
                            <td className={d.recovery ? "" : "dn"}>{d.recovery ?? t("pl.risk.underwater")}</td>
                            <td className="pl-num dn">{pct(d.depth_pct)}</td>
                            <td className="pl-num">{d.days}</td>
                          </tr>
                        ))}
                        {result.risk.drawdowns.length === 0 && (
                          <tr>
                            <td colSpan={5} className="dim">—</td>
                          </tr>
                        )}
                      </tbody>
                    </table>
                  </div>

                  <div className="pl-two">
                    <ContribList title={t("pl.risk.contributors")} rows={result.risk.contributors} positive />
                    <ContribList title={t("pl.risk.detractors")} rows={result.risk.detractors} />
                  </div>
                  <p className="dim pl-hint">{t("pl.risk.note")}</p>

                  {result.risk.regimes && (
                    <>
                      <div className="pl-subhead">{t("pl.risk.regimes")}</div>
                      {result.risk.regimes.length === 0 ? (
                        <p className="dim pl-hint">{t("pl.risk.tooShort")}</p>
                      ) : (
                        <RegimeTable rows={result.risk.regimes} />
                      )}
                      <p className="dim pl-hint">{t("pl.risk.regimesNote")}</p>
                    </>
                  )}

                  {result.risk.attribution && (
                    <>
                      <div className="pl-subhead">{t("pl.risk.attr")}</div>
                      <AttributionBlock a={result.risk.attribution} sectorLabel={sectorLabel} />
                      <p className="dim pl-hint">{t("pl.risk.attrNote")}</p>
                    </>
                  )}

                  {result.capacity && (
                    <>
                      <div className="pl-subhead">{t("pl.cap.title")}</div>
                      <CapacityBlock c={result.capacity} />
                    </>
                  )}
                </>
              )}
            </div>
          </section>

          <section className="panel pl-card" ref={setStageRef(5)} id="pl-stage-6" tabIndex={-1}>
            <div className="panel__head">
              <span className="panel__title">⑥ {t("pl.stage6")}</span>
              {result && (
                <span className="panel__meta">
                  {t("pl.deploy.asOf", { d: result.target_weights.as_of })} · {t("pl.pf.exposure", { v: result.target_weights.exposure_pct.toFixed(0) })}
                </span>
              )}
            </div>
            <div className="panel__body pl-body">
              {!result ? (
                <div className="empty">{t("pl.bt.empty")}</div>
              ) : (
                <>
                  <div className="table-scroll pl-weights-scroll">
                    <table className="lab-stats pl-weights" data-testid="pl-weights">
                      <thead>
                        <tr>
                          <th>#</th>
                          <th>{t("pl.deploy.symbol")}</th>
                          {hasSectors && <th>{t("pl.deploy.sector")}</th>}
                          <th>{t("pl.deploy.weight")}</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.target_weights.weights.map((w) => (
                          <tr key={w.symbol}>
                            <td className="dim">{w.score_rank}</td>
                            <td><b>{w.symbol}</b></td>
                            {hasSectors && <td className="dim">{sectorLabel(groupOf(w.symbol, w.group) ?? "—")}</td>}
                            <td>
                              <div className="pl-bar">
                                <div
                                  className="pl-bar__fill"
                                  style={{ width: `${Math.min(100, (w.weight_pct / maxWeight(result)) * 100)}%` }}
                                />
                                <span className="pl-bar__val">{w.weight_pct.toFixed(1)}%</span>
                              </div>
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>

                  {result.target_weights.groups && result.target_weights.groups.length > 0 && (
                    <>
                      <div className="pl-subhead">{t("pl.deploy.groups")}</div>
                      <SectorStack groups={result.target_weights.groups} sectorLabel={sectorLabel} />
                    </>
                  )}

                  <label className="field">
                    <span className="field__label">{t("pl.deploy.name")}</span>
                    <input
                      className="input"
                      value={deployName}
                      maxLength={60}
                      onChange={(e) => setDeployName(e.target.value)}
                    />
                  </label>
                  <div className="pl-runbar">
                    <button
                      className="btn btn--primary"
                      onClick={deploy}
                      disabled={deployed}
                      title={t("pp.deployTitle")}
                      data-testid="pl-deploy"
                    >
                      {deployed ? t("pp.deployed") : t("pl.deploy.button")}
                    </button>
                    <button className="btn" onClick={copyCsv}>
                      {t("pl.deploy.copyCsv")}
                    </button>
                    {deployed && <span className="pl-badge pl-badge--ok" data-testid="pl-deployed">✓ {t("pl.deploy.done")}</span>}
                    {copied === "ok" && <span className="pl-badge pl-badge--ok">✓ {t("pl.deploy.copied")}</span>}
                    {copied === "fail" && <span className="pl-badge pl-badge--warn">{t("pl.deploy.copyFailed")}</span>}
                  </div>
                  <p className="dim pl-hint">{t("pl.deploy.note")}</p>

                  <TicketCard spec={result.spec ?? buildRequest()} sectorLabel={sectorLabel} />

                  <MemoCard result={result} enabled={aiEnabled} lang={lang} />
                </>
              )}
            </div>
          </section>
        </div>

        <p className="lab-disclaimer">{t("pl.disclaimer")}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------ sub-components

function NumField({
  label, value, range, step, hint, onChange, testId,
}: {
  label: string;
  value: number;
  range: [number, number];
  step?: number;
  hint?: string;
  onChange: (v: number) => void;
  testId?: string;
}) {
  return (
    <label className="field" title={hint}>
      <span className="field__label">
        {label} <span className="pl-range">{range[0]}–{range[1]}</span>
      </span>
      <input
        type="number"
        className="input pl-num-input"
        value={Number.isFinite(value) ? value : ""}
        min={range[0]}
        max={range[1]}
        step={step}
        onChange={(e) => onChange(e.target.value === "" ? range[0] : Number(e.target.value))}
        data-testid={testId}
      />
      {hint && <span className="pl-field-hint">{hint}</span>}
    </label>
  );
}

function Stat({
  label, value, tone: v, toneClass, sub, small, testId, title,
}: {
  label: string; value: string; tone?: number; toneClass?: string; sub?: string; small?: boolean; testId?: string; title?: string;
}) {
  const cls = toneClass ?? (v === undefined ? "" : v > 0 ? "up" : v < 0 ? "dn" : "");
  return (
    <div className="stat" data-testid={testId} title={title}>
      <div className="stat__label">{label}</div>
      <div className={`stat__value ${cls}${small ? " pl-stat--small" : ""}`}>{value}</div>
      {sub && <div className="dim pl-stat__sub">{sub}</div>}
    </div>
  );
}

function SplitRow({
  label, a, b, fmt, invert, warn,
}: { label: string; a: number; b: number; fmt: (v: number) => string; invert?: boolean; warn?: boolean }) {
  const delta = (b - a) * (invert ? -1 : 1);
  const cls = delta > 0.01 ? "up" : delta < -0.01 ? "dn" : "";
  return (
    <tr className={warn ? "pl-split__row--warn" : ""}>
      <td>{label}</td>
      <td className="pl-num dim">{fmt(a)}</td>
      <td className={`pl-num ${cls}`}>{fmt(b)}{warn ? " ⚠" : ""}</td>
    </tr>
  );
}

/** Year rows × 12 month cells; colour intensity scales with |return| across
 * the whole table so one blowout month reads as the outlier it is. */
function Heatmap({
  rows, benchLabel,
}: { rows: PipelineResult["backtest"]["monthly_returns"]; benchLabel: string }) {
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
  const byKey = new Map(rows.map((r) => [`${r.year}-${r.month}`, r]));
  const maxAbs = Math.max(0.01, ...rows.map((r) => Math.abs(r.ret_pct)));
  if (years.length === 0) return <div className="empty">—</div>;
  return (
    <div className="pl-heat" role="table">
      <div className="pl-heat__row pl-heat__head" role="row">
        <span className="pl-heat__year" />
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} className="pl-heat__cell pl-heat__month" role="columnheader">{i + 1}</span>
        ))}
      </div>
      {years.map((y) => (
        <div key={y} className="pl-heat__row" role="row">
          <span className="pl-heat__year" role="rowheader">{y}</span>
          {Array.from({ length: 12 }, (_, i) => {
            const r = byKey.get(`${y}-${i + 1}`);
            if (!r) return <span key={i} className="pl-heat__cell pl-heat__cell--none" role="cell" />;
            const a = 0.12 + 0.75 * Math.min(1, Math.abs(r.ret_pct) / maxAbs);
            const bg = r.ret_pct >= 0 ? `rgba(61, 220, 132, ${a.toFixed(2)})` : `rgba(255, 92, 108, ${a.toFixed(2)})`;
            return (
              <span
                key={i}
                className="pl-heat__cell"
                role="cell"
                style={{ background: bg }}
                title={`${y}-${String(i + 1).padStart(2, "0")} · ${pct(r.ret_pct)} · ${benchLabel} ${pct(r.bench_pct)}`}
              >
                {Math.abs(r.ret_pct) >= 10 ? r.ret_pct.toFixed(0) : r.ret_pct.toFixed(1)}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

function ContribList({
  title, rows, positive,
}: { title: string; rows: PipelineContributor[]; positive?: boolean }) {
  const { t } = useT();
  const max = Math.max(0.01, ...rows.map((r) => Math.abs(r.contribution_pct)));
  return (
    <div>
      <div className="pl-subhead">{title}</div>
      {rows.length === 0 ? (
        <div className="empty">—</div>
      ) : (
        <ul className="pl-contrib">
          {rows.map((r) => (
            <li
              key={r.symbol}
              className="pl-contrib__row"
              title={t("pl.risk.contribTitle", { w: r.avg_weight_pct.toFixed(1), d: String(r.days_held) })}
            >
              <span className="pl-contrib__sym">{r.symbol}</span>
              <span className="pl-bar pl-bar--contrib">
                <span
                  className={`pl-bar__fill ${positive ? "pl-bar__fill--up" : "pl-bar__fill--dn"}`}
                  style={{ width: `${(Math.abs(r.contribution_pct) / max) * 100}%` }}
                />
              </span>
              <span className={`pl-contrib__val ${tone(r.contribution_pct)}`}>{pct(r.contribution_pct)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** A series as a tiny polyline with one dashed reference line (100% for
 * gross exposure, 1.0 for rolling beta). The y-range always contains the
 * reference and, when given, `floor`, so the line never hides the context. */
function Sparkline({
  data, refValue, floor, className, testId,
}: { data: Point[]; refValue: number; floor?: number; className?: string; testId?: string }) {
  if (data.length < 2) return <div className="empty">—</div>;
  const w = 100;
  const h = 26;
  const vals = data.map((p) => p.value);
  const lo = Math.min(refValue, floor ?? Infinity, ...vals);
  const hi = Math.max(refValue, ...vals);
  const pad = Math.max((hi - lo) * 0.08, 1e-6);
  const y = (v: number) => h - 1 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (h - 2);
  const pts = data.map((p, i) => `${((i / (data.length - 1)) * w).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ");
  return (
    <svg
      className={`pl-spark${className ? ` ${className}` : ""}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid={testId}
    >
      <line x1="0" y1={y(refValue)} x2={w} y2={y(refValue)} className="pl-spark__ref" />
      <polyline points={pts} className="pl-spark__line" />
    </svg>
  );
}

/** Information-horizon curve: one bar per forward horizon, positive IC up
 * from the axis and negative down, value printed at the bar tip. A null IC
 * (too few samples) is a dashed empty slot so the gap stays visible. */
function IcDecayBars({ rows }: { rows: Array<{ horizon: number; ic: number | null }> }) {
  const { t } = useT();
  const byH = new Map(rows.map((r) => [r.horizon, r.ic]));
  const horizons = IC_HORIZONS.every((h) => byH.has(h)) ? IC_HORIZONS : rows.map((r) => r.horizon);
  const w = 280;
  const h = 96;
  const top = 14;
  const bottom = 16;
  const plotH = h - top - bottom;
  const maxAbs = Math.max(0.005, ...rows.map((r) => Math.abs(r.ic ?? 0)));
  const axisY = top + plotH / 2;
  const scale = (plotH / 2 - 2) / maxAbs;
  const slot = w / horizons.length;
  const barW = Math.min(26, slot * 0.6);
  return (
    <svg className="pl-decay" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={t("pl.sig.decay")} data-testid="pl-ic-decay">
      <line x1="0" y1={axisY} x2={w} y2={axisY} className="pl-decay__axis" />
      {horizons.map((hz, i) => {
        const ic = byH.get(hz) ?? null;
        const cx = slot * i + slot / 2;
        const x = cx - barW / 2;
        if (ic === null) {
          return (
            <g key={hz}>
              <title>{t("pl.sig.decayNone", { h: String(hz) })}</title>
              <rect x={x} y={axisY - 6} width={barW} height={12} className="pl-decay__none" />
              <text x={cx} y={axisY - 9} className="pl-decay__val">—</text>
              <text x={cx} y={h - 4} className="pl-decay__h">{hz}</text>
            </g>
          );
        }
        const len = Math.abs(ic) * scale;
        const up = ic >= 0;
        const y = up ? axisY - len : axisY;
        const labelY = up ? Math.max(9, axisY - len - 3) : Math.min(h - bottom - 1, axisY + len + 9);
        return (
          <g key={hz}>
            <title>{t("pl.sig.decayBar", { h: String(hz), v: signed3(ic) })}</title>
            <rect x={x} y={y} width={barW} height={Math.max(0.5, len)} className={up ? "pl-decay__bar--up" : "pl-decay__bar--dn"} />
            <text x={cx} y={labelY} className="pl-decay__val">{signed3(ic)}</text>
            <text x={cx} y={h - 4} className="pl-decay__h">{hz}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** V3 quintile check: five bars, bucket 1 (lowest score) → 5 (highest) left to
 * right, annualised return up from the axis when positive and down when
 * negative. A null bucket is a dashed empty slot, as in the decay chart. */
function QuantileBars({ q }: { q: PipelineQuantiles }) {
  const { t } = useT();
  const buckets = [...q.buckets].sort((a, b) => a.bucket - b.bucket);
  const w = 280;
  const h = 96;
  const top = 14;
  const bottom = 16;
  const plotH = h - top - bottom;
  const maxAbs = Math.max(0.5, ...buckets.map((b) => Math.abs(b.ann_return_pct ?? 0)));
  const axisY = top + plotH / 2;
  const scale = (plotH / 2 - 2) / maxAbs;
  const slot = w / buckets.length;
  const barW = Math.min(34, slot * 0.6);
  return (
    <svg
      className="pl-decay pl-quant"
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={t("pl.sig.quantiles")}
      data-testid="pl-quantiles"
    >
      <line x1="0" y1={axisY} x2={w} y2={axisY} className="pl-decay__axis" />
      {buckets.map((b, i) => {
        const cx = slot * i + slot / 2;
        const x = cx - barW / 2;
        if (b.ann_return_pct === null) {
          return (
            <g key={b.bucket}>
              <title>{t("pl.sig.bucketNone", { n: String(b.bucket) })}</title>
              <rect x={x} y={axisY - 6} width={barW} height={12} className="pl-decay__none" data-bucket={b.bucket} />
              <text x={cx} y={axisY - 9} className="pl-decay__val">—</text>
              <text x={cx} y={h - 4} className="pl-decay__h">{b.bucket}</text>
            </g>
          );
        }
        const v = b.ann_return_pct;
        const len = Math.abs(v) * scale;
        const up = v >= 0;
        const y = up ? axisY - len : axisY;
        const labelY = up ? Math.max(9, axisY - len - 3) : Math.min(h - bottom - 1, axisY + len + 9);
        return (
          <g key={b.bucket}>
            <title>{t("pl.sig.bucket", { n: String(b.bucket), v: signed1(v) })}</title>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(0.5, len)}
              className={up ? "pl-decay__bar--up" : "pl-decay__bar--dn"}
              data-bucket={b.bucket}
            />
            <text x={cx} y={labelY} className="pl-decay__val">{signed1(v)}%</text>
            <text x={cx} y={h - 4} className="pl-decay__h">{b.bucket}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** V3 regime table: portfolio vs benchmark in each vol tercile and trend state. */
function RegimeTable({ rows }: { rows: PipelineRegime[] }) {
  const { t } = useT();
  const label = (id: string) => (REGIME_IDS.has(id) ? t(`pl.regime.${id}` as MsgKey) : id);
  return (
    <div className="table-scroll">
      <table className="lab-stats" data-testid="pl-regimes">
        <thead>
          <tr>
            <th>{t("pl.risk.regime")}</th>
            <th className="pl-num">{t("pl.risk.days")}</th>
            <th className="pl-num">{t("pl.risk.ann")}</th>
            <th className="pl-num">{t("pl.risk.benchAnn")}</th>
            <th className="pl-num">{t("bt.sharpe")}</th>
            <th className="pl-num">{t("pl.risk.hit")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.regime}>
              <td>{label(r.regime)}</td>
              <td className="pl-num">{r.days}</td>
              <td className={`pl-num ${tone(r.ann_return_pct ?? 0)}`}>{pctOpt(r.ann_return_pct)}</td>
              <td className="pl-num dim">{pctOpt(r.bench_ann_return_pct)}</td>
              <td className="pl-num">{numOpt(r.sharpe)}</td>
              <td className={`pl-num ${r.hit_rate_pct === null ? "" : tone(r.hit_rate_pct - 50)}`}>
                {r.hit_rate_pct === null ? "—" : `${r.hit_rate_pct.toFixed(1)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** V3 Brinson-Fachler attribution: three headline effects plus a per-sector
 * table whose active weight is a signed bar around zero. */
function AttributionBlock({ a, sectorLabel }: { a: PipelineAttribution; sectorLabel: (id: string) => string }) {
  const { t } = useT();
  const maxActive = Math.max(0.5, ...a.groups.map((g) => Math.abs(g.avg_weight_pct - g.bench_weight_pct)));
  return (
    <>
      <div className="chip-row pl-chip-row" data-testid="pl-attr-chips">
        <span className={`chip ${tone(a.allocation_pct)}`}>{t("pl.risk.attr.alloc", { v: signed1(a.allocation_pct) })}</span>
        <span className={`chip ${tone(a.selection_pct)}`}>{t("pl.risk.attr.sel", { v: signed1(a.selection_pct) })}</span>
        <span className={`chip ${tone(a.interaction_pct)}`}>{t("pl.risk.attr.inter", { v: signed1(a.interaction_pct) })}</span>
      </div>
      {a.groups.length === 0 ? (
        <p className="dim pl-hint">{t("pl.risk.tooShort")}</p>
      ) : (
        <div className="table-scroll">
          <table className="lab-stats" data-testid="pl-attribution">
            <thead>
              <tr>
                <th>{t("pl.risk.sector")}</th>
                <th className="pl-num">{t("pl.risk.avgW")}</th>
                <th className="pl-num">{t("pl.risk.benchW")}</th>
                <th className="pl-num">{t("pl.risk.activeW")}</th>
                <th className="pl-num">{t("pl.risk.allocCol")}</th>
                <th className="pl-num">{t("pl.risk.selCol")}</th>
              </tr>
            </thead>
            <tbody>
              {a.groups.map((g) => {
                const active = g.avg_weight_pct - g.bench_weight_pct;
                const half = (Math.abs(active) / maxActive) * 50;
                return (
                  <tr key={g.group}>
                    <td>{sectorLabel(g.group)}</td>
                    <td className="pl-num">{g.avg_weight_pct.toFixed(1)}%</td>
                    <td className="pl-num dim">{g.bench_weight_pct.toFixed(1)}%</td>
                    <td className="pl-num">
                      <div className="pl-active">
                        <span className="pl-abar" aria-hidden="true">
                          <span className="pl-abar__zero" />
                          <span
                            className={`pl-abar__fill ${active >= 0 ? "pl-abar__fill--up" : "pl-abar__fill--dn"}`}
                            style={active >= 0 ? { left: "50%", width: `${half}%` } : { left: `${50 - half}%`, width: `${half}%` }}
                          />
                        </span>
                        <span className={`pl-active__val ${tone(active)}`}>{signed1(active)}%</span>
                      </div>
                    </td>
                    <td className={`pl-num ${tone(g.allocation_pct)}`}>{signed1(g.allocation_pct)}%</td>
                    <td className={`pl-num ${tone(g.selection_pct)}`}>{signed1(g.selection_pct)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** V3 sector mix of the target book: one horizontal stacked bar and a legend. */
function SectorStack({
  groups, sectorLabel,
}: { groups: Array<{ group: string; weight_pct: number }>; sectorLabel: (id: string) => string }) {
  const total = Math.max(0.01, groups.reduce((acc, g) => acc + Math.max(0, g.weight_pct), 0));
  return (
    <div data-testid="pl-sector-stack">
      <div className="pl-stack" role="img" aria-label={groups.map((g) => `${sectorLabel(g.group)} ${g.weight_pct.toFixed(1)}%`).join(", ")}>
        {groups.map((g, i) => (
          <span
            key={g.group}
            className="pl-stack__seg"
            style={{ width: `${(Math.max(0, g.weight_pct) / total) * 100}%`, background: STACK_COLORS[i % STACK_COLORS.length] }}
            title={`${sectorLabel(g.group)} · ${g.weight_pct.toFixed(1)}%`}
          />
        ))}
      </div>
      <ul className="pl-legend">
        {groups.map((g, i) => (
          <li key={g.group} className="pl-legend__item">
            <span className="pl-legend__dot" style={{ background: STACK_COLORS[i % STACK_COLORS.length] }} />
            {sectorLabel(g.group)}
            <span className="pl-legend__val">{g.weight_pct.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** V6 per-symbol data health (stage ①): collapsed by default, worst coverage
 * first as the server sends it; stale names carry a badge with the bars
 * since their last print. */
function HealthTable({ rows, sectorLabel }: { rows: PipelineHealthRow[]; sectorLabel: (id: string) => string }) {
  const { t } = useT();
  const minCov = Math.min(...rows.map((r) => r.coverage_pct));
  const stale = rows.filter((r) => r.stale).length;
  return (
    <details className="pl-health" data-testid="pl-health">
      <summary className="pl-health__summary" data-testid="pl-health-summary">
        <span className="pl-health__title">{t("pl.health.title")}</span>
        <span className="dim">{t("pl.health.head", { n: rows.length, min: minCov.toFixed(1) })}</span>
        {stale > 0 && (
          <>
            <span className="dim">·</span>
            <span className="pl-badge pl-badge--warn">{t("pl.health.staleCount", { n: stale })}</span>
          </>
        )}
      </summary>
      <div className="table-scroll pl-health__scroll">
        <table className="lab-stats pl-health__table" data-testid="pl-health-table">
          <thead>
            <tr>
              <th>{t("pl.health.symbol")}</th>
              <th>{t("pl.health.sector")}</th>
              <th className="pl-num">{t("pl.health.coverage")}</th>
              <th className="pl-num">{t("pl.health.gaps")}</th>
              <th>{t("pl.health.first")}</th>
              <th>{t("pl.health.last")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className={r.stale ? "pl-health__row--stale" : ""} data-stale={r.stale ? "true" : undefined}>
                <td>
                  <b>{r.symbol}</b>
                  {r.stale && (
                    <span className="pl-badge pl-badge--warn pl-chip--mini" data-testid="pl-stale">
                      {t("pl.health.stale")}
                      {r.stale_days !== undefined && ` · ${t("pl.health.staleDays", { n: r.stale_days })}`}
                    </span>
                  )}
                </td>
                <td className="dim">{sectorLabel(r.group)}</td>
                <td className={`pl-num ${covTone(r.coverage_pct)}`}>{r.coverage_pct.toFixed(1)}%</td>
                <td className={`pl-num ${r.gaps > 0 ? "pl-tone--warn" : ""}`}>{r.gaps}</td>
                <td className="dim">{r.first ?? "—"}</td>
                <td className={r.stale ? "pl-tone--warn" : "dim"}>{r.last ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim pl-hint">{t("pl.health.note")}</p>
    </details>
  );
}

/** V6 factor correlation heatmap (stage ②): n×n cells on a diverging scale —
 * −1 red, 0 dark, +1 green — value printed in each, circled-digit index
 * labels whose hover shows the expression; a null pair is a dashed slot. */
function CorrHeatmap({ m, labels }: { m: Array<Array<number | null>>; labels: string[] }) {
  const { t } = useT();
  const n = m.length;
  const name = (i: number) => labels[i] ?? `#${i + 1}`;
  const bg = (v: number) => {
    const a = 0.08 + 0.72 * Math.min(1, Math.abs(v));
    return v >= 0 ? `rgba(61, 220, 132, ${a.toFixed(2)})` : `rgba(255, 92, 108, ${a.toFixed(2)})`;
  };
  return (
    <div className="pl-corr" data-testid="pl-corr">
      <div
        className="pl-corr__grid"
        role="table"
        aria-label={t("pl.sig.corr")}
        style={{ gridTemplateColumns: `28px repeat(${n}, minmax(44px, 56px))` }}
      >
        <span className="pl-corr__hdr" role="columnheader" />
        {m.map((_, j) => (
          <span key={`c${j}`} className="pl-corr__hdr" role="columnheader" title={t("pl.sig.corrFactor", { i: circled(j), e: name(j) })}>
            {circled(j)}
          </span>
        ))}
        {m.map((row, i) => (
          <Fragment key={`r${i}`}>
            <span className="pl-corr__hdr" role="rowheader" title={t("pl.sig.corrFactor", { i: circled(i), e: name(i) })}>
              {circled(i)}
            </span>
            {Array.from({ length: n }, (_, j) => {
              const v = row[j] ?? null;
              const pair = { a: circled(i), b: circled(j) };
              if (v === null) {
                return (
                  <span key={j} className="pl-corr__cell pl-corr__cell--none" role="cell" title={t("pl.sig.corrNone", pair)}>
                    —
                  </span>
                );
              }
              return (
                <span
                  key={j}
                  className={`pl-corr__cell${i === j ? " is-diag" : ""}`}
                  role="cell"
                  style={{ background: bg(v) }}
                  title={`${t("pl.sig.corrCell", { ...pair, v: v.toFixed(2) })}\n${name(i)}\n${name(j)}`}
                  data-corr={v.toFixed(2)}
                >
                  {v.toFixed(2)}
                </span>
              );
            })}
          </Fragment>
        ))}
      </div>
      <ul className="pl-corr__legend">
        {labels.slice(0, n).map((e, i) => (
          <li key={e}>
            <span className="pl-corr__idx">{circled(i)}</span>
            <code className="pl-factor__expr">{e}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** V6 capacity (stage ⑤): the square-root-impact curve as a four-row table
 * plus a headline chip at the breakeven AUM. A grid that is null throughout
 * means the panel had no volume, and the block says so instead of a number. */
function CapacityBlock({ c }: { c: PipelineCapacity }) {
  const { t } = useT();
  const allNull = c.aum_grid.every((_, i) => c.net_excess_pct_ann[i] == null && c.impact_drag_pct_ann[i] == null);
  const be = c.breakeven_aum;
  const headTone = be === null || be < 1e7 ? "pl-tone--bad" : be < 1e8 ? "pl-tone--warn" : "pl-tone--ok";
  return (
    <div className="pl-cap" data-testid="pl-capacity">
      <div className="chip-row pl-chip-row">
        {allNull ? (
          <span className="chip pl-tone--warn" data-testid="pl-capacity-chip">{t("pl.cap.noVolume")}</span>
        ) : (
          <span className={`chip ${headTone}`} title={t("pl.cap.headlineTitle")} data-testid="pl-capacity-chip">
            {be === null ? t("pl.cap.none") : t("pl.cap.headline", { v: fmtAum(be) })}
          </span>
        )}
        {c.excess_pct_ann !== null && (
          <span className="chip">{t("pl.cap.excess", { v: signed1(c.excess_pct_ann) })}</span>
        )}
        {c.costed_trade_pct !== undefined && c.costed_trade_pct !== null && (
          <span className="chip dim" title={t("pl.cap.costedTitle")} data-testid="pl-capacity-costed">
            {t("pl.cap.costed", { v: c.costed_trade_pct.toFixed(0) })}
          </span>
        )}
      </div>
      <div className="table-scroll">
        <table className="lab-stats pl-cap__table" data-testid="pl-capacity-table">
          <thead>
            <tr>
              <th>{t("pl.cap.aum")}</th>
              <th className="pl-num">{t("pl.cap.drag")}</th>
              <th className="pl-num">{t("pl.cap.net")}</th>
              <th className="pl-num" title={t("pl.cap.partTitle")}>{t("pl.cap.part")}</th>
            </tr>
          </thead>
          <tbody>
            {c.aum_grid.map((aum, i) => {
              const net = c.net_excess_pct_ann[i] ?? null;
              return (
                <tr key={aum} className={net !== null && net <= 0 ? "pl-cap__row--under" : ""}>
                  <td><b>{fmtAum(aum)}</b></td>
                  <td className="pl-num dn">{pct2Opt(c.impact_drag_pct_ann[i])}</td>
                  <td className={`pl-num ${net === null ? "" : tone(net)}`}>{pctOpt(net)}</td>
                  <td className="pl-num dim">{pct2Opt(c.participation_pct[i])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {allNull && <p className="dim pl-hint" data-testid="pl-capacity-novolume">{t("pl.cap.noVolume")}</p>}
      <p className="dim pl-hint">{t("pl.cap.note")}</p>
    </div>
  );
}

/** V4 parameter-sensitivity heatmap: rows follow `top_n`, columns follow
 * `rebalance`, each cell prints its Sharpe and is shaded by it (red below zero,
 * green above, intensity relative to the grid's extremes). The chosen
 * configuration is outlined; a null cell is a dashed empty slot. */
function SensitivityGrid({
  s, chosenTopN, chosenRebalance,
}: { s: PipelineSensitivity; chosenTopN: number; chosenRebalance: number }) {
  const { t } = useT();
  const sharpes = s.cells.flat().flatMap((c) => (c ? [c.sharpe] : []));
  const maxPos = Math.max(0.5, ...sharpes);
  const maxNeg = Math.max(0.5, ...sharpes.map((v) => -v));
  const bg = (v: number) =>
    v >= 0
      ? `rgba(61, 220, 132, ${(0.1 + 0.7 * Math.min(1, v / maxPos)).toFixed(2)})`
      : `rgba(255, 92, 108, ${(0.1 + 0.7 * Math.min(1, -v / maxNeg)).toFixed(2)})`;
  return (
    <div className="pl-sens" data-testid="pl-sens">
      <div className="pl-sens__axes dim">
        {t("pl.bt.sens.rows")} · {t("pl.bt.sens.cols")}
      </div>
      <div className="pl-sens__grid" role="table" aria-label={t("pl.bt.sens")} style={{ gridTemplateColumns: `72px repeat(${s.rebalance.length}, minmax(56px, 1fr))` }}>
        <span className="pl-sens__corner" role="columnheader">{t("pl.bt.sens.corner")}</span>
        {s.rebalance.map((r) => (
          <span key={`c${r}`} className="pl-sens__hdr" role="columnheader">{r}</span>
        ))}
        {s.top_n.map((n, i) => (
          <SensitivityRow
            key={n}
            topN={n}
            rebalance={s.rebalance}
            cells={s.cells[i] ?? []}
            chosenRebalance={n === chosenTopN ? chosenRebalance : null}
            bg={bg}
          />
        ))}
      </div>
    </div>
  );
}

function SensitivityRow({
  topN, rebalance, cells, chosenRebalance, bg,
}: {
  topN: number;
  rebalance: number[];
  cells: Array<PipelineSensitivity["cells"][number][number]>;
  chosenRebalance: number | null;
  bg: (v: number) => string;
}) {
  const { t } = useT();
  return (
    <>
      <span className="pl-sens__hdr" role="rowheader">{topN}</span>
      {rebalance.map((r, j) => {
        const c = cells[j] ?? null;
        const chosen = r === chosenRebalance;
        const cls = `pl-sens__cell${chosen ? " is-chosen" : ""}`;
        if (!c) {
          return (
            <span key={r} className={`${cls} pl-sens__cell--none`} role="cell" title={t("pl.bt.sens.cellNone", { n: topN, r })}>
              —
            </span>
          );
        }
        const title =
          t("pl.bt.sens.cell", { n: topN, r, s: c.sharpe.toFixed(2), e: signed1(c.excess_pct), d: c.max_drawdown_pct.toFixed(1) }) +
          (chosen ? t("pl.bt.sens.cellChosen") : "");
        return (
          <span
            key={r}
            className={cls}
            role="cell"
            style={{ background: bg(c.sharpe) }}
            title={title}
            aria-label={chosen ? t("pl.bt.sens.chosen") : undefined}
            data-chosen={chosen ? "true" : undefined}
          >
            {c.sharpe.toFixed(2)}
          </span>
        );
      })}
    </>
  );
}

type Translate = (key: MsgKey, vars?: Record<string, string | number>) => string;

/** V4 Markdown report: the same numbers the page shows, in the current UI
 * language, laid out for a chat window or a notebook. No curves. */
function markdownReport(
  r: PipelineResult,
  t: Translate,
  names: { market: string; scheme: string; weighting: string; sector: (symbol: string, group?: string) => string | undefined },
): string {
  const bt = r.backtest;
  const st = bt.stats;
  const b = st.benchmark;
  const o = bt.overfitting;
  const dash = "—";
  const pc = (v: number | null | undefined) => (v === null || v === undefined ? dash : pct(v));
  const p1 = (v: number | null | undefined) => (v === null || v === undefined ? dash : `${v.toFixed(1)}%`);
  const esc = (v: string) => v.replaceAll("|", "\\|");
  const row = (cells: Array<string | number>) => `| ${cells.map((c) => esc(String(c))).join(" | ")} |`;
  const table = (head: string[], rows: Array<Array<string | number>>) =>
    [row(head), `|${head.map((_, i) => (i === 0 ? "---" : "---:")).join("|")}|`, ...rows.map(row)].join("\n");
  const out: string[] = [];

  out.push(`# ${t("pl.md.title")}`);
  out.push("");
  out.push(t("pl.md.meta", { m: names.market, s: names.scheme, n: r.signal.components.length, w: names.weighting }));
  out.push(t("pl.md.span", { from: bt.span.from, to: bt.span.to, k: r.universe.symbols, d: new Date().toISOString().slice(0, 10) }));
  out.push("");

  out.push(`## ${t("pl.md.factors")}`);
  for (const c of r.signal.components) {
    const inv = c.invert ? ` · ${t("fl.bt.inverted")}` : "";
    const active = c.active_pct !== undefined && c.active_pct < 100 ? ` · ${t("pl.sig.active", { v: c.active_pct.toFixed(0) })}` : "";
    out.push(
      `- \`${c.expression}\`${inv} — ${t("pl.md.factorRow", {
        w: (c.weight * 100).toFixed(0), is: signed3(c.is_ic), oos: signed3(c.oos_ic), s: c.standalone_sharpe.toFixed(2),
      })}${active}`,
    );
  }
  out.push("");

  out.push(`## ${t("pl.md.headline")}`);
  const headRows: Array<Array<string | number>> = [
    [t("bt.totalReturn"), pct(st.total_return_pct), pct(b.total_return_pct)],
    [t("pl.bt.excess"), pct(st.excess_pct), dash],
    [t("bt.cagr"), pc(st.cagr_pct), pc(b.cagr_pct)],
    [t("bt.sharpe"), st.sharpe.toFixed(2), b.sharpe.toFixed(2)],
    [t("bt.sortino"), st.sortino.toFixed(2), dash],
    [t("pl.bt.calmar"), st.calmar.toFixed(2), dash],
    [t("bt.maxdd"), pct(st.max_drawdown_pct), pct(b.max_drawdown_pct)],
    [t("pl.bt.vol"), p1(st.ann_vol_pct), p1(b.ann_vol_pct)],
    [t("bt.winrate"), p1(st.win_rate_pct), dash],
  ];
  if (st.rolling_6m_beat_pct !== undefined) headRows.push([t("pl.bt.rolling"), p1(st.rolling_6m_beat_pct), dash]);
  out.push(table([t("pp.cmp.metric"), t("pl.bt.strategy"), t("fl.bt.bench")], headRows));
  out.push("");

  out.push(`## ${t("pl.md.split")}`);
  out.push(
    table(
      [t("pp.cmp.metric"), `${t("lab.tbl.insample")} ${bt.in_sample.from} → ${bt.in_sample.to}`, `${t("pl.bt.holdout")} ${bt.holdout.from} → ${bt.holdout.to}`],
      [
        [t("bt.totalReturn"), pct(bt.in_sample.total_return_pct), pct(bt.holdout.total_return_pct)],
        [t("bt.sharpe"), bt.in_sample.sharpe.toFixed(2), bt.holdout.sharpe.toFixed(2)],
        [t("bt.maxdd"), pct(bt.in_sample.max_drawdown_pct), pct(bt.holdout.max_drawdown_pct)],
        [t("pl.bt.excess"), pct(bt.in_sample.excess_pct), pct(bt.holdout.excess_pct)],
      ],
    ),
  );
  out.push("");

  if (o) {
    out.push(`## ${t("pl.md.ofit")}`);
    const mintrl =
      o.min_track_record_days === undefined
        ? dash
        : o.min_track_record_days === null
          ? t("pl.bt.ofit.mintrlNone")
          : t("pl.bt.ofit.mintrlVal", { need: o.min_track_record_days, have: o.track_days ?? dash });
    out.push(
      t("pl.md.ofitLine", {
        psr: prob(o.psr), dsr: prob(o.dsr), t: numOpt(o.t_stat), h: (o.hlz_hurdle ?? 3).toFixed(1), mintrl, n: o.trials,
      }),
    );
    out.push("");
  }

  const sens = r.sensitivity;
  if (sens) {
    out.push(`## ${t("pl.md.sens", { tn: sens.top_n.join("/"), rb: sens.rebalance.join("/") })}`);
    out.push(t("pl.md.sensLine", { med: numOpt(sens.median_sharpe), min: numOpt(sens.min_sharpe), spike: signed2Opt(sens.spike) }));
    out.push("");
    out.push(
      table(
        [t("pl.bt.sens.corner"), ...sens.rebalance.map(String)],
        sens.top_n.map((n, i) => [
          n,
          ...sens.rebalance.map((rb, j) => {
            const c = sens.cells[i]?.[j];
            if (!c) return dash;
            const v = c.sharpe.toFixed(2);
            return n === r.portfolio.top_n && rb === r.portfolio.rebalance ? `**${v}**` : v;
          }),
        ]),
      ),
    );
    out.push("");
    out.push(`> ${t("pl.bt.sens.note")}`);
    out.push("");
  }

  const cap = r.capacity;
  if (cap) {
    out.push(`## ${t("pl.cap.title")}`);
    out.push(cap.breakeven_aum === null ? t("pl.cap.none") : t("pl.cap.headline", { v: fmtAum(cap.breakeven_aum) }));
    out.push("");
    out.push(
      table(
        [t("pl.cap.aum"), t("pl.cap.drag"), t("pl.cap.net"), t("pl.cap.part")],
        cap.aum_grid.map((aum, i) => [
          fmtAum(aum),
          pct2Opt(cap.impact_drag_pct_ann[i]),
          pc(cap.net_excess_pct_ann[i]),
          pct2Opt(cap.participation_pct[i]),
        ]),
      ),
    );
    out.push("");
    out.push(`> ${t("pl.cap.note")}`);
    out.push("");
  }

  out.push(`## ${t("pl.md.risk")}`);
  const risk = r.risk;
  const chips = [
    `β ${st.beta.toFixed(2)}`,
    `${t("pl.risk.te")} ${st.tracking_error_pct.toFixed(1)}%`,
    `IR ${st.information_ratio.toFixed(2)}`,
    `${t("pl.risk.corr")} ${risk.correlation_to_benchmark.toFixed(2)}`,
    t("pl.pf.effN", { n: risk.concentration.avg_effective_n.toFixed(1) }),
    t("pl.risk.cap", { v: risk.concentration.cap_binding_pct.toFixed(0) }),
    t("pl.pf.exposure", { v: r.portfolio.avg_exposure_pct.toFixed(0) }),
    t("pl.pf.annualTurnover", { v: (r.portfolio.annual_turnover_x ?? 0).toFixed(1) }),
  ];
  if (risk.capture) {
    chips.push(t("pl.risk.captureUp", { v: ratio(risk.capture.up), n: risk.capture.up_periods }));
    chips.push(t("pl.risk.captureDown", { v: ratio(risk.capture.down), n: risk.capture.down_periods }));
  }
  if (risk.cvar_95_pct !== undefined) chips.push(t("pl.risk.cvar", { v: numOpt(risk.cvar_95_pct) }));
  if (risk.attribution) {
    chips.push(t("pl.risk.attr.alloc", { v: signed1(risk.attribution.allocation_pct) }));
    chips.push(t("pl.risk.attr.sel", { v: signed1(risk.attribution.selection_pct) }));
  }
  out.push(chips.map((c) => `- ${c}`).join("\n"));
  out.push("");

  out.push(`## ${t("pl.md.weights", { d: r.target_weights.as_of, e: r.target_weights.exposure_pct.toFixed(0) })}`);
  const top = r.target_weights.weights.slice(0, 5);
  const withSector = top.some((w) => names.sector(w.symbol, w.group) !== undefined);
  out.push(
    table(
      ["#", t("pl.deploy.symbol"), ...(withSector ? [t("pl.deploy.sector")] : []), t("pl.deploy.weight")],
      top.map((w) => [
        w.score_rank,
        w.symbol,
        ...(withSector ? [names.sector(w.symbol, w.group) ?? dash] : []),
        `${w.weight_pct.toFixed(1)}%`,
      ]),
    ),
  );
  out.push("");

  out.push(`## ${t("pl.md.warnings")}`);
  out.push(
    r.warnings.length === 0
      ? t("pl.md.none")
      : r.warnings.map((w) => `- ⚠ ${WARNING_KEYS[w] ? t(WARNING_KEYS[w]) : t("pl.warn.generic", { code: w })}`).join("\n"),
  );
  out.push("");
  out.push(`_${t("pl.disclaimer")}_`);
  return out.join("\n");
}

/** Exactly the summary the page displays — never the curves — so the memo
 * cannot cite a number the user has not seen. Truncations per the contract. */
function memoRequest(r: PipelineResult, lang: Lang): PipelineMemoRequest {
  return {
    spec: r.spec,
    universe: r.universe,
    signal: {
      weighting: r.signal.weighting,
      components: r.signal.components.map((c) => ({
        expression: c.expression,
        is_ic: c.is_ic,
        oos_ic: c.oos_ic,
        weight: c.weight,
        standalone_sharpe: c.standalone_sharpe,
      })),
      max_pair_corr: r.signal.max_pair_corr,
      ic_by_horizon: r.signal.ic_by_horizon,
      composite_is_ic: r.signal.composite_is_ic,
      composite_oos_ic: r.signal.composite_oos_ic,
      quantiles: r.signal.quantiles,
    },
    portfolio: r.portfolio,
    stats: r.backtest.stats,
    in_sample: r.backtest.in_sample,
    holdout: r.backtest.holdout,
    overfitting: r.backtest.overfitting,
    risk: {
      drawdowns: r.risk.drawdowns.slice(0, 3),
      contributors: r.risk.contributors.slice(0, 3),
      detractors: r.risk.detractors.slice(0, 3),
      concentration: r.risk.concentration,
      correlation_to_benchmark: r.risk.correlation_to_benchmark,
      capture: r.risk.capture,
      cvar_95_pct: r.risk.cvar_95_pct,
      bench_cvar_95_pct: r.risk.bench_cvar_95_pct,
      regimes: r.risk.regimes,
      attribution: r.risk.attribution
        ? {
            allocation_pct: r.risk.attribution.allocation_pct,
            selection_pct: r.risk.attribution.selection_pct,
            interaction_pct: r.risk.attribution.interaction_pct,
            groups: r.risk.attribution.groups.slice(0, 5),
          }
        : undefined,
    },
    warnings: r.warnings,
    lang,
  };
}

/** V5 rebalance ticket (stage ⑥): NAV + current holdings → whole-share buy /
 * sell orders against the latest target book. The spec posted is the run on
 * screen (or the form's when none), so the ticket matches the numbers above;
 * a new run clears the previous ticket for the same reason. */
function TicketCard({ spec, sectorLabel }: { spec: PipelineRunRequest; sectorLabel: (id: string) => string }) {
  const { t } = useT();
  const [nav, setNav] = useState<number>(100000);
  const [holdingsText, setHoldingsText] = useState("");
  const [minTradePct, setMinTradePct] = useState<number>(0.25);
  const [ticket, setTicket] = useState<PipelineOrders | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [csvCopied, setCsvCopied] = useState<"idle" | "ok" | "fail">("idle");

  // Keyed on content, not identity: the caller may rebuild the spec object per render.
  const specKey = JSON.stringify(spec);
  useEffect(() => {
    setTicket(null);
    setError(null);
  }, [specKey]);

  const lines = useMemo(() => parseHoldings(holdingsText), [holdingsText]);
  const badLines = lines.filter((l) => l.symbol === undefined);
  const navOk = Number.isFinite(nav) && nav > 0;
  const minOk = Number.isFinite(minTradePct) && minTradePct >= MIN_TRADE_RANGE[0] && minTradePct <= MIN_TRADE_RANGE[1];
  const issue = !navOk ? t("pl.tk.navInvalid") : !minOk ? t("pl.tk.minInvalid") : badLines.length > 0 ? t("pl.tk.fixLines") : null;

  const build = async () => {
    if (pending || issue !== null) return;
    setPending(true);
    setError(null);
    setCsvCopied("idle");
    const current: Record<string, number> = {};
    for (const l of lines) {
      if (l.symbol === undefined || l.shares === undefined) continue;
      current[l.symbol] = (current[l.symbol] ?? 0) + l.shares;
    }
    try {
      setTicket(await api.pipelineOrders({ spec, nav, current, min_trade_pct: minTradePct }));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  const copyCsv = async () => {
    if (!ticket) return;
    const rows = [
      "side,symbol,shares,price,notional,from_weight_pct,to_weight_pct,group",
      ...ticket.orders.map((o) =>
        [o.side, o.symbol, o.shares, o.price, o.notional.toFixed(2), o.from_weight_pct.toFixed(2), o.to_weight_pct.toFixed(2), o.group ?? ""].join(","),
      ),
    ];
    const ok = await copyText(rows.join("\n"));
    setCsvCopied(ok ? "ok" : "fail");
    window.setTimeout(() => setCsvCopied("idle"), 2500);
  };

  const sm = ticket?.summary;
  return (
    <div className="pl-ticket" data-testid="pl-ticket">
      <div className="pl-memo__head">
        <span className="pl-subhead" style={{ marginTop: 0 }}>{t("pl.tk.title")}</span>
        {ticket && (
          <span className="dim pl-hint" data-testid="pl-ticket-dates">
            {t("pl.tk.asOf", { d: ticket.as_of, p: ticket.price_date })}
          </span>
        )}
      </div>
      <p className="dim pl-hint">{t("pl.tk.hint")}</p>
      <div className="pl-ticket__form">
        <label className="field">
          <span className="field__label">{t("pl.tk.nav")}</span>
          <input
            type="number"
            className="input pl-num-input"
            value={Number.isFinite(nav) ? nav : ""}
            min={1}
            step={1000}
            onChange={(e) => setNav(e.target.value === "" ? Number.NaN : Number(e.target.value))}
            aria-label={t("pl.tk.nav")}
            data-testid="pl-ticket-nav"
          />
        </label>
        <label className="field">
          <span className="field__label">
            {t("pl.tk.minTrade")} <span className="pl-range">{MIN_TRADE_RANGE[0]}–{MIN_TRADE_RANGE[1]}</span>
          </span>
          <input
            type="number"
            className="input pl-num-input"
            value={Number.isFinite(minTradePct) ? minTradePct : ""}
            min={MIN_TRADE_RANGE[0]}
            max={MIN_TRADE_RANGE[1]}
            step={0.05}
            onChange={(e) => setMinTradePct(e.target.value === "" ? Number.NaN : Number(e.target.value))}
            aria-label={t("pl.tk.minTrade")}
            data-testid="pl-ticket-min"
          />
        </label>
        <label className="field pl-ticket__holdings">
          <span className="field__label">{t("pl.tk.holdings")}</span>
          <textarea
            className="textarea pl-symbols"
            value={holdingsText}
            placeholder={t("pl.tk.holdingsPh")}
            onChange={(e) => setHoldingsText(e.target.value)}
            aria-label={t("pl.tk.holdings")}
            spellCheck={false}
            data-testid="pl-ticket-holdings"
          />
          {badLines.length > 0 && (
            <ul className="pl-badlines" data-testid="pl-ticket-badlines">
              {badLines.map((l) => (
                <li key={l.line}>⚠ {t("pl.tk.badLine", { n: l.line, s: l.text })}</li>
              ))}
            </ul>
          )}
        </label>
      </div>
      <div className="pl-runbar">
        <button className="btn btn--primary" onClick={build} disabled={pending || issue !== null} title={issue ?? undefined} data-testid="pl-ticket-build">
          {pending ? t("pl.tk.building") : t("pl.tk.build")}
        </button>
        {pending && <span className="spinner" aria-hidden="true" />}
        {issue && <span className="pl-hint pl-hint--warn" data-testid="pl-ticket-issue">{issue}</span>}
        {ticket && (
          <>
            <button className="btn" onClick={copyCsv} data-testid="pl-ticket-csv">
              {t("pl.tk.copyCsv")}
            </button>
            {csvCopied === "ok" && <span className="pl-badge pl-badge--ok" data-testid="pl-ticket-csv-copied">✓ {t("pl.deploy.copied")}</span>}
            {csvCopied === "fail" && <span className="pl-badge pl-badge--warn">{t("pl.deploy.copyFailed")}</span>}
          </>
        )}
      </div>
      {error && <div className="err" data-testid="pl-ticket-error">{error}</div>}
      {ticket && sm && (
        <>
          <div className="chip-row pl-chip-row" data-testid="pl-ticket-summary">
            <span className="chip">{t("pl.tk.counts", { b: sm.buys, s: sm.sells })}</span>
            <span className="chip" title={t("pl.tk.turnoverTitle")} data-testid="pl-ticket-turnover">
              {t("pl.tk.turnover", { v: sm.turnover_pct.toFixed(1) })}
            </span>
            <span className="chip" title={t("pl.tk.costTitle")}>{t("pl.tk.cost", { v: money(sm.est_cost) })}</span>
            {sm.cash_unknown || sm.cash_before === null || sm.cash_after === null ? (
              <span className="chip pl-tone--warn" title={t("pl.tk.unpriced", { list: ticket.unpriced.join(", ") })} data-testid="pl-ticket-cash-unknown">
                {t("pl.tk.cashUnknown")}
              </span>
            ) : (
              <span className="chip" data-testid="pl-ticket-cash">{t("pl.tk.cash", { a: money(sm.cash_before), b: money(sm.cash_after) })}</span>
            )}
            <span className="chip">{t("pl.tk.exposure", { v: sm.target_exposure_pct.toFixed(0) })}</span>
          </div>
          {ticket.unpriced.length > 0 && (
            <div className="pl-badge pl-badge--warn pl-dropped" data-testid="pl-ticket-unpriced">
              ⚠ {t("pl.tk.unpriced", { list: ticket.unpriced.join(", ") })}
            </div>
          )}
          {ticket.orders.length === 0 ? (
            <div className="empty">{t("pl.tk.empty")}</div>
          ) : (
            <div className="table-scroll pl-weights-scroll">
              <table className="lab-stats pl-orders" data-testid="pl-ticket-table">
                <thead>
                  <tr>
                    <th>{t("pl.tk.side")}</th>
                    <th>{t("pl.deploy.symbol")}</th>
                    <th className="pl-num">{t("pl.tk.shares")}</th>
                    <th className="pl-num">{t("pl.tk.price")}</th>
                    <th className="pl-num">{t("pl.tk.notional")}</th>
                    <th className="pl-num">{t("pl.tk.weights")}</th>
                    <th>{t("pl.deploy.sector")}</th>
                  </tr>
                </thead>
                <tbody>
                  {ticket.orders.map((o) => (
                    <OrderRow key={`${o.side}-${o.symbol}`} o={o} sectorLabel={sectorLabel} />
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <p className="dim pl-hint" data-testid="pl-ticket-note">{t("pl.tk.note")}</p>
        </>
      )}
    </div>
  );
}

function OrderRow({ o, sectorLabel }: { o: PipelineOrder; sectorLabel: (id: string) => string }) {
  const { t } = useT();
  return (
    <tr className={`pl-order pl-order--${o.side}`} data-side={o.side}>
      <td>
        <span className={`pl-side pl-side--${o.side}`}>{o.side === "buy" ? t("pl.tk.buy") : t("pl.tk.sell")}</span>
      </td>
      <td><b>{o.symbol}</b></td>
      <td className="pl-num">{o.shares.toLocaleString("en-US")}</td>
      <td className="pl-num">{price(o.price)}</td>
      <td className="pl-num">{money(o.notional)}</td>
      <td className="pl-num">
        <span className="dim">{o.from_weight_pct.toFixed(1)}%</span> → {o.to_weight_pct.toFixed(1)}%
      </td>
      <td className="dim">{o.group ? sectorLabel(o.group) : "—"}</td>
    </tr>
  );
}

/** AI investment-committee memo (stage ⑥). The button is live only when the
 * server reports an AI key; a new run clears the previous memo so the verdict
 * always refers to the numbers on screen. */
function MemoCard({ result, enabled, lang }: { result: PipelineResult; enabled: boolean; lang: Lang }) {
  const { t } = useT();
  const [memo, setMemo] = useState<PipelineMemo | null>(null);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setMemo(null);
    setError(null);
  }, [result]);

  const generate = async () => {
    if (pending || !enabled) return;
    setPending(true);
    setError(null);
    try {
      setMemo(await api.pipelineMemo(memoRequest(result, lang)));
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setPending(false);
    }
  };

  return (
    <div className="pl-memo" data-testid="pl-memo">
      <div className="pl-memo__head">
        <span className="pl-subhead" style={{ marginTop: 0 }}>{t("pl.memo.title")}</span>
        <button
          className="btn btn--mini"
          onClick={generate}
          disabled={!enabled || pending}
          data-testid="pl-memo-btn"
        >
          {pending ? t("pl.memo.loading") : t("pl.memo.button")}
        </button>
        {pending && <span className="spinner" aria-hidden="true" />}
        {!enabled && <span className="dim pl-hint" data-testid="pl-memo-disabled">{t("pl.memo.disabled")}</span>}
      </div>
      {!memo && !error && <p className="dim pl-hint">{t("pl.memo.hint")}</p>}
      {error && <div className="err">{error}</div>}
      {memo && (
        <>
          <div className="pl-memo__head">
            <span className={`pl-verdict pl-verdict--${memo.verdict}`} data-testid="pl-memo-verdict">
              {t(`pl.memo.verdict.${memo.verdict}` as MsgKey)}
            </span>
            <p className="pl-memo__headline" data-testid="pl-memo-headline">{memo.headline}</p>
          </div>
          <div className="pl-memo__lists">
            <MemoList title={t("pl.memo.strengths")} items={memo.strengths} />
            <MemoList title={t("pl.memo.concerns")} items={memo.concerns} />
            <MemoList title={t("pl.memo.next")} items={memo.next_steps} />
          </div>
          {memo.honesty_note && <p className="dim pl-hint">{memo.honesty_note}</p>}
          <div className="pl-memo__footer">{t("pl.memo.footer", { model: memo.model })}</div>
        </>
      )}
    </div>
  );
}

function MemoList({ title, items }: { title: string; items: string[] }) {
  if (items.length === 0) return null;
  return (
    <div>
      <div className="pl-subhead">{title}</div>
      <ul className="pl-memo__list">
        {items.map((s, i) => (
          <li key={i}>{s}</li>
        ))}
      </ul>
    </div>
  );
}

// ------------------------------------------------------------------ helpers

const maxWeight = (r: PipelineResult) => Math.max(0.01, ...r.target_weights.weights.map((w) => w.weight_pct));
/** V5 ticket amounts: account currency, two decimals, thousands separators. */
const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Reference prices: two decimals above 1, four significant digits below (sub-dollar crypto). */
const price = (v: number) => (Math.abs(v) >= 1 ? money(v) : v.toPrecision(4));
const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "dn" : "");
const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const pctOpt = (v: number | null) => (v === null ? "—" : pct(v));
const num = (v: number) => v.toFixed(2);
const numOpt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));
const signed1 = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
const signed1Opt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : signed1(v));
const signed2Opt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`);
const signed3 = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(3)}`;
const signed3Opt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : signed3(v));
/** Probabilities (PSR / DSR) print as 0.xx; a null means too short a track. */
const prob = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));
/** ≥ 0.95 is the usual bar for PSR/DSR; 0.8–0.95 is borderline; below is luck territory. */
const probTone = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v >= 0.95 ? "pl-tone--ok" : v >= 0.8 ? "pl-tone--warn" : "pl-tone--bad";
/** Harvey-Liu-Zhu: ≥ 3 clears the multiple-testing hurdle, 2–3 is borderline, < 2 is not a finding. */
const tstatTone = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v >= 3 ? "pl-tone--ok" : v >= 2 ? "pl-tone--warn" : "pl-tone--bad";
/** MinTRL: fine once the track is at least as long as required; null means Sharpe ≤ 0 (no length suffices). */
const mintrlTone = (need: number | null | undefined, have: number | undefined) =>
  need === undefined ? "" : need === null ? "pl-tone--bad" : have !== undefined && have >= need ? "pl-tone--ok" : "pl-tone--warn";
/** V3.1 p-value vs 1/N: green only when the scheme beats equal weight AND the gap is significant. */
const pOpt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(3));
const pTone = (p: number | null | undefined, delta: number | undefined) =>
  p !== null && p !== undefined && p < 0.05 && (delta ?? 0) > 0 ? "pl-tone--ok" : "dim";
const ratio = (v: number | null) => (v === null ? "—" : v.toFixed(2));
/** V4 rolling half-year hit rate vs 1/N: ≥ 60 is a real edge, 45–60 a coin toss, below that the benchmark wins. */
const hitTone = (v: number | null) => (v === null ? "" : v >= 60 ? "pl-tone--ok" : v >= 45 ? "pl-tone--warn" : "pl-tone--bad");
/** V4 spike = chosen Sharpe − grid median: ≤ 0.2 plateau, 0.2–0.5 borderline, > 0.5 the server flags a parameter spike. */
const spikeTone = (v: number | null) => (v === null ? "" : v <= 0.2 ? "pl-tone--ok" : v <= 0.5 ? "pl-tone--warn" : "pl-tone--bad");
/** Up-capture above 1 and down-capture below 1 are the good directions. */
const captureTone = (v: number | null, up: boolean) => (v === null ? "" : (up ? v >= 1 : v <= 1) ? "up" : "dn");
/** V6 two-decimal percentages (impact drag, participation); null prints as a dash. */
const pct2Opt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v.toFixed(2)}%`);
/** V6 data coverage: ≥ 95% clean, 80–95% patchy, below that the name barely contributes. */
const covTone = (v: number) => (v >= 95 ? "pl-tone--ok" : v >= 80 ? "pl-tone--warn" : "pl-tone--bad");
/** V6 factor index labels ①②③…; falls back to plain numbers past ⑳. */
const circled = (i: number) => (i < 20 ? String.fromCodePoint(0x2460 + i) : String(i + 1));
/** V6 AUM in K / M / B with up to three significant digits and no trailing zeros: 1M, 10M, 2.65B, 43.4M. */
function fmtAum(v: number): string {
  const units: Array<[number, string]> = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [u, suffix] of units) {
    if (Math.abs(v) >= u) return `${trimNum(v / u)}${suffix}`;
  }
  return trimNum(v);
}
function trimNum(x: number): string {
  const s = Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
