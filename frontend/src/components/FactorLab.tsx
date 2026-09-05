import { useEffect, useRef, useState } from "react";
import {
  api,
  streamNDJSON,
  type CompositeResult,
  type FactorBacktestResult,
  type FactorCheck,
} from "../api";
import { useT } from "../i18n";
import {
  deleteFactor,
  factorLessons,
  saveFactorLessons,
  saveFactors,
  savedFactors,
  type SavedFactor,
  factorTrials,
  saveFactorTrials,
} from "../store";
import { buildFactorShare, takeFactorShare } from "../share";
import { deployPaper } from "../store";
import { DeployButton } from "./DeployButton";
import { EquityChart } from "./EquityChart";
import { EvolveLab } from "./EvolveLab";
import { ExplainButton } from "./ExplainButton";
import { FactorReportButton } from "./FactorReport";
import { ShareButton } from "./ShareButton";

/** One evaluated candidate (or a failed parse). */
interface FactorRow {
  round: number;
  expression: string;
  hypothesis?: string;
  error?: string;
  accepted?: boolean;
  reasons?: string[];
  is_ic?: number;
  is_icir?: number;
  oos_ic?: number;
  oos_icir?: number;
  stability?: number;
  max_zoo_corr?: number;
  complexity?: number;
  turnover?: number;
  spread_after_cost_pct?: number;
  t_stat?: number;
}

interface LoopItem {
  kind: "round" | "candidate" | "feedback";
  round: number;
  row?: FactorRow;
  text?: string;
}

interface Props {
  hidden: boolean;
  aiEnabled: boolean;
}

/** Loop-engineered factor mining: every round Claude proposes factor
 * expressions, a real cross-sectional evaluator scores them (rank IC vs
 * forward returns, holdout confirmation, redundancy vs the accepted zoo),
 * and the compressed feedback steers the next round — Chain-of-Alpha style. */
export function FactorLab({ hidden, aiEnabled }: Props) {
  const { t } = useT();
  const [market, setMarket] = useState("us");
  const [horizon, setHorizon] = useState(10);
  const [rounds, setRounds] = useState(3);
  const [perRound, setPerRound] = useState(4);
  const [mode, setMode] = useState("standard");
  const [engine, setEngine] = useState<"llm" | "gp">("llm");
  const [saved, setSaved] = useState<SavedFactor[]>(savedFactors);
  const [btFor, setBtFor] = useState<string | null>(null);
  const [btResult, setBtResult] = useState<FactorBacktestResult | null>(null);
  const [btError, setBtError] = useState<string | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [weighting, setWeighting] = useState("ic");
  const [compositeResult, setCompositeResult] = useState<CompositeResult | null>(null);
  const [compositing, setCompositing] = useState(false);
  const [health, setHealth] = useState<Record<string, FactorCheck | "pending" | "failed">>({});
  const [checking, setChecking] = useState(false);
  const [transfer, setTransfer] = useState<Record<string, FactorCheck | "pending" | "failed">>({});

  const [running, setRunning] = useState(false);
  const [items, setItems] = useState<LoopItem[]>([]);
  const [zoo, setZoo] = useState<FactorRow[]>([]);
  const [meta, setMeta] = useState<{ universe: number; from: string; to: string } | null>(null);
  const [currentRound, setCurrentRound] = useState(0);
  const [totalRounds, setTotalRounds] = useState(0);
  const [evaluated, setEvaluated] = useState(0);
  const [finished, setFinished] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const abortRef = useRef<AbortController | null>(null);
  const logRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  // Shared-link replay (?s=fb): run the factor portfolio test directly.
  useEffect(() => {
    const share = takeFactorShare();
    if (!share) return;
    void (async () => {
      setBtFor(share.expression);
      try {
        setBtResult(await api.factorBacktest({ ...share }));
      } catch (err) {
        setBtError((err as Error).message);
      } finally {
        setBtFor(null);
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight });
  }, [items]);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setItems([]);
    setZoo([]);
    setMeta(null);
    setError(null);
    setFinished(false);
    setEvaluated(0);
    setCurrentRound(0);
    setTotalRounds(rounds);

    const controller = new AbortController();
    abortRef.current = controller;

    try {
      // Cross-session memory: replay accepted factors (this market) and
      // stored lessons so the loop continues where earlier sessions stopped.
      const memory = {
        accepted: savedFactors()
          .filter((f) => f.market === market)
          .map((f) => f.expression)
          .slice(0, 20),
        lessons: factorLessons(),
        trials: factorTrials(),
      };
      await streamNDJSON(
        "/api/factors/mine",
        { market, horizon, rounds, per_round: perRound, mode, memory },
        (event) => {
          const e = event as Record<string, unknown> & { type: string };
          switch (e.type) {
            case "start":
              setMeta({
                universe: (e.universe as string[]).length,
                from: (e.span as { from: string }).from,
                to: (e.span as { to: string }).to,
              });
              break;
            case "round":
              setCurrentRound(e.round as number);
              setItems((prev) => [...prev, { kind: "round", round: e.round as number }]);
              break;
            case "eval": {
              const row = e as unknown as FactorRow;
              setItems((prev) => [...prev, { kind: "candidate", round: row.round, row }]);
              setEvaluated((n) => n + 1);
              if (row.accepted) setZoo((prev) => [...prev, row]);
              break;
            }
            case "feedback":
              setItems((prev) => [
                ...prev,
                { kind: "feedback", round: e.round as number, text: e.text as string },
              ]);
              break;
            case "done": {
              setFinished(true);
              const zooDone = (e.zoo as FactorRow[]) ?? [];
              if (zooDone.length) {
                setSaved(
                  saveFactors(
                    zooDone.map((f) => ({
                      expression: f.expression,
                      hypothesis: f.hypothesis,
                      market,
                      horizon,
                      is_ic: f.is_ic ?? 0,
                      is_icir: f.is_icir ?? 0,
                      oos_ic: f.oos_ic ?? 0,
                      savedAt: new Date().toISOString(),
                    })),
                  ),
                );
              }
              const lessons = (e.lessons as string[]) ?? [];
              if (lessons.length) saveFactorLessons(lessons);
              if (typeof e.trials === "number") saveFactorTrials(e.trials);
              break;
            }
            case "error":
              setError(e.message as string);
              break;
          }
        },
        controller.signal,
      );
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const runFactorBacktest = async (f: SavedFactor) => {
    setBtFor(f.expression);
    setBtError(null);
    try {
      setBtResult(
        await api.factorBacktest({
          expression: f.expression,
          market: f.market,
          top_n: 5,
          rebalance: f.horizon,
          invert: f.is_ic < 0, // negative IC = signal works inverted
        }),
      );
    } catch (err) {
      setBtError((err as Error).message);
      setBtResult(null);
    } finally {
      setBtFor(null);
    }
  };

  const key = (f: SavedFactor) => `${f.market}|${f.expression}`;

  const toggleSelect = (f: SavedFactor) => {
    setSelected((prev) => {
      const next = new Set(prev);
      const k = key(f);
      if (next.has(k)) next.delete(k);
      else next.add(k);
      return next;
    });
  };

  const runComposite = async () => {
    const chosen = saved.filter((f) => selected.has(key(f)));
    if (chosen.length < 2 || compositing) return;
    const markets = new Set(chosen.map((f) => f.market));
    if (markets.size > 1) {
      setBtError(t("fl.cp.sameMarket"));
      return;
    }
    setCompositing(true);
    setBtError(null);
    setBtResult(null);
    try {
      setCompositeResult(
        await api.factorComposite({
          factors: chosen.map((f) => ({
            expression: f.expression,
            invert: f.is_ic < 0,
            horizon: f.horizon,
          })),
          market: chosen[0].market,
          weighting,
          top_n: 5,
          rebalance: chosen[0].horizon,
        }),
      );
    } catch (err) {
      setBtError((err as Error).message);
      setCompositeResult(null);
    } finally {
      setCompositing(false);
    }
  };

  const checkAll = async () => {
    if (checking || saved.length === 0) return;
    setChecking(true);
    for (const f of saved) {
      setHealth((prev) => ({ ...prev, [key(f)]: "pending" }));
      try {
        const result = await api.factorCheck(f.expression, f.market, f.horizon);
        setHealth((prev) => ({ ...prev, [key(f)]: result }));
      } catch {
        setHealth((prev) => ({ ...prev, [key(f)]: "failed" }));
      }
    }
    setChecking(false);
  };

  const runTransfer = async (f: SavedFactor) => {
    const other = f.market === "crypto" ? "us" : "crypto";
    setTransfer((prev) => ({ ...prev, [key(f)]: "pending" }));
    try {
      const result = await api.factorCheck(f.expression, other, f.horizon);
      setTransfer((prev) => ({ ...prev, [key(f)]: result }));
    } catch {
      setTransfer((prev) => ({ ...prev, [key(f)]: "failed" }));
    }
  };

  /** Sign-aligned decay verdict: recent IC in the direction the factor was
   * accepted with, below the loose bar = suspected decay. */
  const decayState = (f: SavedFactor, h: FactorCheck): "ok" | "decayed" => {
    const aligned = h.recent_ic * Math.sign(f.is_ic || 1);
    return aligned < 0.01 ? "decayed" : "ok";
  };

  const transferState = (f: SavedFactor, h: FactorCheck): "ok" | "fail" => {
    const aligned = h.is_ic * Math.sign(f.is_ic || 1);
    const alignedOos = h.oos_ic * Math.sign(f.is_ic || 1);
    return aligned > 0.01 && alignedOos > 0 ? "ok" : "fail";
  };

  return (
    <div className="lab" style={hidden ? { display: "none" } : undefined}>
      <div className="lab__inner">
        <section className="lab-hero">
          <h1 className="lab-hero__title">{t("fl.title")}</h1>
          <p className="lab-hero__sub">
            {t("fl.sub1")}
            <b>{t("fl.sub.b")}</b>
            {t("fl.sub2")}
          </p>
        </section>

        <div className="engine-toggle" role="tablist">
          <button
            role="tab"
            className={`chip${engine === "llm" ? " is-on" : ""}`}
            onClick={() => setEngine("llm")}
          >
            {t("gp.engine.llm")}
          </button>
          <button
            role="tab"
            className={`chip${engine === "gp" ? " is-on" : ""}`}
            onClick={() => setEngine("gp")}
          >
            {t("gp.engine.gp")}
          </button>
          <span className="dim engine-toggle__note">
            {engine === "gp" ? t("gp.engine.gpNote") : t("gp.engine.llmNote")}
          </span>
        </div>

        {engine === "gp" ? (
          <EvolveLab aiEnabled={aiEnabled} />
        ) : !aiEnabled ? (
          <div className="notice" style={{ maxWidth: 560 }}>
            {t("lab.aiOff")}
          </div>
        ) : (
          <>
            <div className="lab-form panel">
              <div className="control-grid" style={{ borderBottom: "none" }}>
                <label className="field">
                  <span className="field__label">{t("fl.market")}</span>
                  <select
                    className="select"
                    value={market}
                    onChange={(e) => setMarket(e.target.value)}
                    disabled={running}
                  >
                    <option value="us">{t("fl.market.us")}</option>
                    <option value="crypto">{t("fl.market.crypto")}</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">{t("fl.horizon")}</span>
                  <select
                    className="select"
                    value={horizon}
                    onChange={(e) => setHorizon(Number(e.target.value))}
                    disabled={running}
                  >
                    {[5, 10, 20].map((h) => (
                      <option key={h} value={h}>
                        {t("fl.horizonOpt", { n: String(h) })}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">{t("fl.rounds")}</span>
                  <select
                    className="select"
                    value={rounds}
                    onChange={(e) => setRounds(Number(e.target.value))}
                    disabled={running}
                  >
                    {[2, 3, 4, 5].map((r) => (
                      <option key={r} value={r}>
                        {r}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">{t("fl.perRound")}</span>
                  <select
                    className="select"
                    value={perRound}
                    onChange={(e) => setPerRound(Number(e.target.value))}
                    disabled={running}
                  >
                    {[3, 4, 5].map((n) => (
                      <option key={n} value={n}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">{t("fl.mode")}</span>
                  <select
                    className="select"
                    value={mode}
                    onChange={(e) => setMode(e.target.value)}
                    disabled={running}
                  >
                    <option value="strict">{t("fl.mode.strict")}</option>
                    <option value="standard">{t("fl.mode.standard")}</option>
                    <option value="loose">{t("fl.mode.loose")}</option>
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">&nbsp;</span>
                  {running ? (
                    <button className="btn" onClick={stop}>
                      {t("lab.stop")}
                    </button>
                  ) : (
                    <button className="btn btn--primary" onClick={run}>
                      {t("fl.run")}
                    </button>
                  )}
                </label>
              </div>
              <div className="lab-form__hint">
                {t("fl.hint")}
                {mode === "loose" && <span className="dn"> {t("fl.mode.warn")}</span>}
              </div>
            </div>

            <div className="lab-grid">
              {/* --------------------------------------------- loop log */}
              <div className="panel lab-panel">
                <div className="panel__head">
                  <span className="panel__title">{t("fl.loop")}</span>
                  <span className="panel__meta">
                    {running
                      ? `${t("fl.round", { k: String(currentRound), n: String(totalRounds) })} · ${meta ? t("fl.universe", { n: String(meta.universe) }) : "…"}`
                      : finished
                        ? t("fl.done", { n: String(evaluated) })
                        : t("lab.state.idle")}
                  </span>
                </div>
                <div className="lab-timeline" ref={logRef}>
                  {items.length === 0 && !running && (
                    <div className="empty">{t("fl.empty")}</div>
                  )}
                  {items.map((item, i) => {
                    if (item.kind === "round") {
                      return (
                        <div key={i} className="fl-round">
                          {t("fl.roundHead", { k: String(item.round) })}
                        </div>
                      );
                    }
                    if (item.kind === "feedback") {
                      return (
                        <div key={i} className="fl-feedback">
                          <div className="fl-feedback__tag">{t("fl.feedback")}</div>
                          <pre>{item.text}</pre>
                        </div>
                      );
                    }
                    const row = item.row!;
                    return (
                      <div
                        key={i}
                        className={`fl-cand ${row.error ? "fl-cand--err" : row.accepted ? "fl-cand--ok" : ""}`}
                      >
                        <code className="fl-cand__expr">{row.expression}</code>
                        {row.hypothesis && <div className="fl-cand__hypo dim">{row.hypothesis}</div>}
                        {row.error ? (
                          <div className="fl-cand__err">{t("fl.evalFail")}: {row.error}</div>
                        ) : (
                          <>
                            <div className="fl-cand__metrics">
                              <Chip label={t("fl.m.isic")} v={row.is_ic} signed />
                              <Chip label="ICIR" v={row.is_icir} signed />
                              <Chip label={t("fl.m.oosic")} v={row.oos_ic} signed />
                              <Chip label={t("fl.m.corr")} v={row.max_zoo_corr} />
                              {row.turnover !== undefined && <Chip label={t("fl.m.turnover")} v={row.turnover} />}
                              {row.spread_after_cost_pct !== undefined && (
                                <Chip label={t("fl.m.cost")} v={row.spread_after_cost_pct} signed />
                              )}
                              <span className={`fl-verdict ${row.accepted ? "up" : "dn"}`}>
                                {row.accepted ? t("fl.accepted") : t("fl.rejected")}
                              </span>
                            </div>
                            {!row.accepted && row.reasons && row.reasons.length > 0 && (
                              <div className="fl-cand__reasons dim">{row.reasons.join("；")}</div>
                            )}
                          </>
                        )}
                      </div>
                    );
                  })}
                  {running && <div className="lab-step__result dim">{t("fl.mining")}</div>}
                  {error && <div className="err">{error}</div>}
                </div>
              </div>

              {/* ---------------------------------------------- factor zoo */}
              <div className="lab-side">
                <div className="panel">
                  <div className="panel__head">
                    <span className="panel__title">{t("fl.zoo")}</span>
                    <span className="panel__meta">
                      {meta ? `${meta.from} → ${meta.to}` : ""}
                    </span>
                  </div>
                  {zoo.length === 0 ? (
                    <div className="empty" style={{ padding: 24 }}>
                      {finished ? t("fl.zooEmptyDone") : t("fl.zooEmpty")}
                    </div>
                  ) : (
                    <div className="table-scroll">
                      <table className="lab-stats">
                        <thead>
                          <tr>
                            <th>{t("fl.z.expr")}</th>
                            <th style={{ textAlign: "right" }}>{t("fl.m.isic")}</th>
                            <th style={{ textAlign: "right" }}>{t("fl.m.oosic")}</th>
                            <th style={{ textAlign: "right" }}>ICIR</th>
                          </tr>
                        </thead>
                        <tbody>
                          {zoo.map((f) => (
                            <tr key={f.expression}>
                              <td>
                                <code style={{ fontSize: 11 }}>{f.expression}</code>
                                {f.hypothesis && (
                                  <div className="dim" style={{ fontSize: 11 }}>{f.hypothesis}</div>
                                )}
                              </td>
                              <td style={{ textAlign: "right" }} className={(f.is_ic ?? 0) >= 0 ? "up" : "dn"}>
                                {fmt(f.is_ic)}
                              </td>
                              <td style={{ textAlign: "right" }} className={(f.oos_ic ?? 0) >= 0 ? "up" : "dn"}>
                                {fmt(f.oos_ic)}
                              </td>
                              <td style={{ textAlign: "right" }}>{fmt(f.is_icir)}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                </div>

                <div className="panel">
                  <div className="panel__head">
                    <span className="panel__title">{t("fl.mine.title")}</span>
                    <span className="panel__meta">
                      {saved.length > 0 && (
                        <button className="btn btn--mini" onClick={checkAll} disabled={checking}>
                          {checking ? t("fl.hc.running") : t("fl.hc.run")}
                        </button>
                      )}
                    </span>
                  </div>
                  {saved.length === 0 ? (
                    <div className="empty" style={{ padding: 18 }}>{t("fl.mine.empty")}</div>
                  ) : (
                    <ul className="lab-saved">
                      {saved.map((f) => {
                        const k = key(f);
                        const h = health[k];
                        const tr = transfer[k];
                        return (
                          <li key={k} className="lab-saved__row fl-zoo-row">
                            <input
                              type="checkbox"
                              className="fl-zoo-row__check"
                              checked={selected.has(k)}
                              onChange={() => toggleSelect(f)}
                              aria-label={t("fl.cp.select")}
                            />
                            <div style={{ minWidth: 0, flex: 1 }}>
                              <code style={{ fontSize: 11, wordBreak: "break-all" }}>
                                {f.expression}
                              </code>
                              <div className="dim" style={{ fontSize: 11 }}>
                                {f.market === "crypto" ? t("fl.market.crypto") : t("fl.market.us")} ·{" "}
                                IC {fmt(f.is_ic)} · OOS {fmt(f.oos_ic)} · {f.savedAt.slice(0, 10)}
                              </div>
                              {h && h !== "pending" && h !== "failed" && (
                                <div
                                  className={`fl-badge ${decayState(f, h) === "ok" ? "fl-badge--ok" : "fl-badge--warn"}`}
                                >
                                  {decayState(f, h) === "ok"
                                    ? t("fl.hc.ok", { v: fmt(h.recent_ic) })
                                    : t("fl.hc.decayed", { v: fmt(h.recent_ic) })}
                                </div>
                              )}
                              {h === "pending" && <div className="fl-badge dim">…</div>}
                              {tr && tr !== "pending" && tr !== "failed" && (
                                <div
                                  className={`fl-badge ${transferState(f, tr) === "ok" ? "fl-badge--ok" : "fl-badge--warn"}`}
                                >
                                  {t(
                                    transferState(f, tr) === "ok" ? "fl.tr.ok" : "fl.tr.fail",
                                    {
                                      m: tr.market === "crypto" ? t("fl.tr.crypto") : t("fl.tr.us"),
                                      a: fmt(tr.is_ic),
                                      b: fmt(tr.oos_ic),
                                    },
                                  )}
                                </div>
                              )}
                              {tr === "pending" && <div className="fl-badge dim">⇄ …</div>}
                              <ExplainButton expression={f.expression} market={f.market} enabled={aiEnabled} />
                              <FactorReportButton expression={f.expression} market={f.market} horizon={f.horizon} />
                            </div>
                            <div className="lab-saved__actions">
                              <button
                                className="btn btn--mini"
                                disabled={btFor === f.expression}
                                onClick={() => runFactorBacktest(f)}
                              >
                                {btFor === f.expression ? "…" : "▶"}
                              </button>
                              <DeployButton
                                onDeploy={() =>
                                  deployPaper("factor", f.expression.slice(0, 40), {
                                    expression: f.expression,
                                    market: f.market,
                                    top_n: 5,
                                    rebalance: f.horizon,
                                    invert: f.is_ic < 0,
                                  })
                                }
                              />
                              <button
                                className="btn btn--mini"
                                title={t("fl.tr.title")}
                                onClick={() => runTransfer(f)}
                              >
                                ⇄
                              </button>
                              <button
                                className="watch-row__x"
                                title={t("lab.mine.del")}
                                onClick={() => setSaved(deleteFactor(f.market, f.expression))}
                              >
                                ×
                              </button>
                            </div>
                          </li>
                        );
                      })}
                    </ul>
                  )}
                  {saved.length >= 2 && (
                    <div className="fl-composite-bar">
                      <select
                        className="select"
                        value={weighting}
                        onChange={(e) => setWeighting(e.target.value)}
                      >
                        <option value="ic">{t("fl.cp.ic")}</option>
                        <option value="equal">{t("fl.cp.equal")}</option>
                        <option value="rolling">{t("fl.cp.rolling")}</option>
                      </select>
                      <button
                        className="btn btn--primary"
                        disabled={selected.size < 2 || compositing}
                        onClick={runComposite}
                      >
                        {compositing
                          ? t("fl.cp.running")
                          : t("fl.cp.run", { n: String(selected.size) })}
                      </button>
                    </div>
                  )}
                  {compositeResult && (
                    <div className="fl-bt">
                      <div className="fl-bt__head dim">
                        {t("fl.cp.head", {
                          n: String(compositeResult.components.length),
                          w: compositeResult.weighting === "ic" ? t("fl.cp.ic") : compositeResult.weighting === "rolling" ? t("fl.cp.rolling") : t("fl.cp.equal"),
                          c: compositeResult.max_pair_corr.toFixed(2),
                        })}
                      </div>
                      <div className="fl-cp-weights dim">
                        {compositeResult.components.map((c) => (
                          <span key={c.expression} className="fl-chip">
                            <code>{c.expression.slice(0, 28)}…</code> w={c.weight}
                          </span>
                        ))}
                      </div>
                      <EquityChart
                        equity={compositeResult.equity_curve}
                        benchmark={compositeResult.benchmark_curve}
                        drawdown={compositeResult.drawdown_curve}
                      />
                      <div className="stat-grid">
                        <Stat2
                          label={t("bt.totalReturn")}
                          value={pct(compositeResult.stats.total_return_pct)}
                          tone={compositeResult.stats.total_return_pct}
                        />
                        <Stat2
                          label={t("fl.bt.bench")}
                          value={pct(compositeResult.stats.benchmark.total_return_pct)}
                          tone={compositeResult.stats.benchmark.total_return_pct}
                        />
                        <Stat2
                          label={t("bt.sharpe")}
                          value={compositeResult.stats.sharpe.toFixed(2)}
                        />
                        <Stat2
                          label={t("bt.maxdd")}
                          value={pct(compositeResult.stats.max_drawdown_pct)}
                          tone={-1}
                        />
                      </div>
                      <div className="kr-disclaimer dim">{t("fl.cp.note")}</div>
                    </div>
                  )}
                  {btError && <div className="err">{btError}</div>}
                  {btResult && (
                    <div className="fl-bt">
                      <div className="fl-bt__head dim">
                        <ShareButton
                          url={() =>
                            buildFactorShare({
                              expression: btResult.expression,
                              market: btResult.market,
                              top_n: btResult.top_n,
                              rebalance: btResult.rebalance,
                              invert: btResult.inverted,
                            })
                          }
                        />{" "}
                        {t("fl.bt.head", {
                          n: String(btResult.top_n),
                          r: String(btResult.rebalance),
                        })}
                        {btResult.inverted && ` · ${t("fl.bt.inverted")}`}
                        {" · "}
                        {btResult.span.from} → {btResult.span.to}
                      </div>
                      <EquityChart
                        equity={btResult.equity_curve}
                        benchmark={btResult.benchmark_curve}
                        drawdown={btResult.drawdown_curve}
                      />
                      <div className="stat-grid">
                        <Stat2
                          label={t("bt.totalReturn")}
                          value={pct(btResult.stats.total_return_pct)}
                          tone={btResult.stats.total_return_pct}
                        />
                        <Stat2
                          label={t("fl.bt.bench")}
                          value={pct(btResult.stats.benchmark.total_return_pct)}
                          tone={btResult.stats.benchmark.total_return_pct}
                        />
                        <Stat2 label={t("bt.sharpe")} value={btResult.stats.sharpe.toFixed(2)} />
                        <Stat2
                          label={t("bt.maxdd")}
                          value={pct(btResult.stats.max_drawdown_pct)}
                          tone={-1}
                        />
                      </div>
                      <div className="kr-disclaimer dim">{t("fl.bt.note")}</div>
                    </div>
                  )}
                </div>

                <div className="panel">
                  <div className="panel__head">
                    <span className="panel__title">{t("fl.how")}</span>
                  </div>
                  <div className="panel__body fl-how">
                    <p>{t("fl.how1")}</p>
                    <p>{t("fl.how2")}</p>
                    <p className="dim">{t("fl.refs")}</p>
                  </div>
                </div>
              </div>
            </div>

            <p className="lab-disclaimer">{t("fl.disclaimer")}</p>
          </>
        )}
      </div>
    </div>
  );
}

function Chip({ label, v, signed }: { label: string; v?: number; signed?: boolean }) {
  const cls = signed && v !== undefined ? (v > 0 ? "up" : v < 0 ? "dn" : "") : "";
  return (
    <span className="fl-chip">
      <span className="dim">{label}</span> <b className={cls}>{fmt(v)}</b>
    </span>
  );
}

const fmt = (v?: number) =>
  v === undefined || v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(3)}`;

function Stat2({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const cls = tone === undefined ? "" : tone > 0 ? "up" : tone < 0 ? "dn" : "";
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value ${cls}`}>{value}</div>
    </div>
  );
}

const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
