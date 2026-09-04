import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type PipelineAlternative,
  type PipelineAttribution,
  type PipelineConfig,
  type PipelineContributor,
  type PipelineFactorSpec,
  type PipelineMemo,
  type PipelineMemoRequest,
  type PipelineQuantiles,
  type PipelineRegime,
  type PipelineResult,
  type PipelineRunRequest,
  type PipelineSignalWeighting,
  type Point,
} from "../api";
import { useT, type Lang, type MsgKey } from "../i18n";
import { deployPaper, savedFactors, type SavedFactor } from "../store";
import { EquityChart } from "./EquityChart";

interface Props {
  hidden: boolean;
}

const FORM_KEY = "aiquant.pipeline.form";
/** V3: how many runs this browser has made, sent as `prior_trials` so the
 * Deflated Sharpe penalises repeated tinkering honestly. */
const TRIALS_KEY = "aiquant.pipeline.trials";
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
}

/** V2 select options; used when the server predates `config.signal_weightings`. */
const SIGNAL_WEIGHTINGS: PipelineSignalWeighting[] = ["ic_expanding", "ic", "equal"];
const IC_HORIZONS = [1, 2, 3, 5, 10, 15, 20];

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
};

function formFromDefaults(d: PipelineConfig["defaults"], base?: Partial<FormState>): FormState {
  return {
    market: "us",
    selected: [],
    inverts: {},
    custom: {},
    compare: true,
    ...base,
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
  const [result, setResult] = useState<PipelineResult | null>(null);
  const [altSort, setAltSort] = useState<{ key: AltKey; dir: 1 | -1 }>({ key: "sharpe", dir: -1 });
  const [deployName, setDeployName] = useState("");
  const [deployed, setDeployed] = useState(false);
  const [copied, setCopied] = useState<"idle" | "ok" | "fail">("idle");
  const [stage, setStage] = useState(1);
  const [trials, setTrials] = useState<number>(loadTrials);
  const [aiEnabled, setAiEnabled] = useState(false);
  const stageRefs = useRef<Array<HTMLElement | null>>([]);

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
  });

  const run = async () => {
    if (running || chosen.length === 0) return;
    setRunning(true);
    setError(null);
    setDeployed(false);
    setCopied("idle");
    try {
      const res = await api.pipelineRun(buildRequest());
      setResult(res);
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
    const csv = rows.join("\n");
    let ok = false;
    try {
      await navigator.clipboard.writeText(csv);
      ok = true;
    } catch {
      try {
        const ta = document.createElement("textarea");
        ta.value = csv;
        ta.setAttribute("readonly", "");
        ta.style.position = "fixed";
        ta.style.opacity = "0";
        document.body.appendChild(ta);
        ta.select();
        ok = document.execCommand("copy");
        document.body.removeChild(ta);
      } catch {
        ok = false;
      }
    }
    setCopied(ok ? "ok" : "fail");
    window.setTimeout(() => setCopied("idle"), 2500);
  };

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
                {configState === "loading" ? t("pl.configLoading") : t("pl.uni.size", { n: String(universe.length) })}
              </span>
            </div>
            <div className="panel__body pl-body">
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
              {result && (
                <div className="stat-grid pl-stats">
                  <Stat label={t("pl.uni.covered")} value={`${result.universe.symbols} / ${universe.length || result.universe.symbols}`} />
                  <Stat label={t("pl.uni.bars")} value={String(result.universe.bars)} />
                  <Stat label={t("pl.uni.span")} value={`${result.universe.from} → ${result.universe.to}`} small />
                </div>
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
            <span className="panel__meta">
              {bt ? `${bt.span.from} → ${bt.span.to}` : running ? t("pl.bt.running") : ""}
            </span>
          </div>
          <div className="panel__body pl-body">
            <div className="pl-runbar">
              <button
                className="btn btn--primary"
                onClick={run}
                disabled={running || chosen.length === 0}
                data-testid="pl-run"
              >
                {running ? t("pl.bt.running") : t("pl.bt.run")}
              </button>
              <span className="dim pl-hint">
                {chosen.length === 0
                  ? t("pl.bt.needFactor")
                  : t("pl.bt.summary", {
                      n: String(chosen.length),
                      s: schemeName(form.scheme),
                      m: marketLabel(form.market),
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
/** Up-capture above 1 and down-capture below 1 are the good directions. */
const captureTone = (v: number | null, up: boolean) => (v === null ? "" : (up ? v >= 1 : v <= 1) ? "up" : "dn");
