import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  api,
  type PipelineAlternative,
  type PipelineConfig,
  type PipelineFactorSpec,
  type PipelineResult,
  type PipelineRunRequest,
  type PipelineSignalWeighting,
} from "../../api";
import { useT, type MsgKey } from "../../i18n";
import { buildPipelineShare, takePipelineShare } from "../../share";
import { deployPaper, savedFactors, type SavedFactor } from "../../store";
import { SectorStack } from "./charts";
import { copyText } from "./clipboard";
import {
  FALLBACK_CONFIG,
  FORM_KEY,
  HISTORIES,
  SECTOR_IDS,
  SIGNAL_WEIGHTINGS,
  STAGE_COUNT,
  SYMBOL_LIMITS,
  WATCHLIST_KEYS,
} from "./constants";
import {
  formFromDefaults,
  formFromShare,
  loadForm,
  loadLast,
  loadTrials,
  matchesPreset,
  parseSymbols,
  presetFields,
  saveLast,
  saveTrials,
  type AltKey,
  type FactorOption,
  type FormState,
  type PresetId,
} from "./form";
import { maxWeight, signed3 } from "./format";
import { MemoCard } from "./MemoCard";
import { markdownReport } from "./report";
import { BacktestResults } from "./stages/BacktestResults";
import { PortfolioForm } from "./stages/PortfolioForm";
import { RiskResults } from "./stages/RiskResults";
import { SignalResult } from "./stages/SignalResult";
import { UniverseResult } from "./stages/UniverseResult";
import { TicketCard } from "./TicketCard";

interface Props {
  hidden: boolean;
}

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
                <UniverseResult result={result} universe={universe} history={form.history} sectorLabel={sectorLabel} />
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
              {result && <SignalResult result={result} weightingLabel={weightingLabel} />}
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
            <PortfolioForm
              form={form}
              patch={patch}
              running={running}
              limits={limits}
              schemes={schemes}
              result={result}
              activePreset={activePreset}
              applyPreset={applyPreset}
              schemeName={schemeName}
            />
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
              <BacktestResults
                result={result}
                bt={bt}
                holdoutWarn={holdoutWarn}
                altSort={altSort}
                toggleAltSort={toggleAltSort}
                sortedAlts={sortedAlts}
                schemeName={schemeName}
                patch={patch}
              />
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
                <RiskResults result={result} bt={bt} sectorLabel={sectorLabel} />
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
