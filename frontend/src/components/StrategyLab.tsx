import { useEffect, useRef, useState } from "react";
import {
  streamStrategy,
  type AIEvent,
  type StrategyForm,
  type StrategyProposal,
} from "../api";
import {
  deleteStrategy,
  savedStrategies,
  saveStrategy,
  type SavedStrategy,
} from "../store";
import { deployPaper } from "../store";
import { DeployButton } from "./DeployButton";
import { SymbolSearch } from "./SymbolSearch";
import { useT, type MsgKey } from "../i18n";

const OBJECTIVE_VALUES = ["auto", "trend", "momentum", "reversion", "low_drawdown"] as const;

interface TimelineStep {
  kind: "analyze" | "backtest" | "walkforward" | "propose" | "note";
  title: string;
  detail?: string;
  result?: string;
}

interface Props {
  hidden: boolean;
  aiEnabled: boolean;
  /** Run a generated strategy: App adds the symbol to the right workspace,
   * queues the preset and switches view. */
  onRun: (symbol: string, name: string, payload: Record<string, unknown>) => void;
}

export function StrategyLab({ hidden, aiEnabled, onRun }: Props) {
  const { t } = useT();
  const [symbol, setSymbol] = useState("AAPL");
  const [objective, setObjective] = useState("auto");
  const [validationPeriod, setValidationPeriod] = useState("5y");
  const [notes, setNotes] = useState("");

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [steps, setSteps] = useState<TimelineStep[]>([]);
  const [thinking, setThinking] = useState("");
  const [commentary, setCommentary] = useState("");
  const [proposal, setProposal] = useState<StrategyProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedStrategy[]>(savedStrategies);
  const [justSaved, setJustSaved] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight });
  }, [steps, thinking]);

  const pushStep = (step: TimelineStep) => setSteps((prev) => [...prev, step]);

  const attachResult = (text: string) =>
    setSteps((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].result === undefined && next[i].kind !== "note") {
          next[i] = { ...next[i], result: text };
          break;
        }
      }
      return next;
    });

  const handleEvent = (event: AIEvent) => {
    switch (event.type) {
      case "thinking":
        setThinking((t) => (t + event.text).slice(-1200));
        break;
      case "text":
        setCommentary((c) => c + event.text);
        break;
      case "tool_use": {
        const input = event.input as Record<string, unknown>;
        if (event.name === "run_backtest") {
          const bits = [
            String(input.strategy ?? ""),
            input.fast != null ? `${input.fast}/${input.slow}` : "",
            input.rsi_period != null ? `RSI${input.rsi_period}` : "",
            String(input.period ?? ""),
          ].filter(Boolean);
          pushStep({ kind: "backtest", title: `${t("lab.step.backtest")} ${input.symbol}`, detail: bits.join(" · ") });
        } else if (event.name === "walk_forward") {
          const bits = [
            String(input.strategy ?? ""),
            input.fast != null ? `${input.fast}/${input.slow}` : "",
            input.rsi_period != null ? `RSI${input.rsi_period}` : "",
            `${input.folds ?? 3} ${t("lab.step.folds")} · ${t("lab.step.train")} ${input.train_years ?? 2}y / ${t("lab.step.test")} ${input.test_years ?? 1}y`,
          ].filter(Boolean);
          pushStep({
            kind: "walkforward",
            title: `${t("lab.step.wf")} ${input.symbol}`,
            detail: bits.join(" · "),
          });
        } else if (event.name === "propose_strategy") {
          pushStep({ kind: "propose", title: t("lab.step.propose") });
          setProposal(input as unknown as StrategyProposal);
        } else if (event.name === "compute_indicator") {
          pushStep({
            kind: "analyze",
            title: `${t("lab.step.indicator")} ${String(input.indicator ?? "").toUpperCase()}`,
            detail: String(input.symbol ?? ""),
          });
        } else if (event.name === "get_price_history") {
          pushStep({
            kind: "analyze",
            title: t("lab.step.history"),
            detail: `${input.symbol} · ${input.period ?? "6mo"}`,
          });
        } else {
          pushStep({ kind: "analyze", title: event.name });
        }
        break;
      }
      case "tool_result": {
        const r = event.result as Record<string, unknown>;
        if (event.name === "run_backtest" && r?.stats) {
          const s = r.stats as Record<string, number>;
          attachResult(
            `${t("lab.r.return")} ${fmtPct(s.total_return_pct)} · ${t("lab.r.bench")} ${fmtPct(s.buy_hold_return_pct)} · ` +
              `${t("lab.r.sharpe")} ${s.sharpe} · ${t("lab.r.dd")} ${fmtPct(s.max_drawdown_pct)} · ${s.trade_count} ${t("lab.r.trades")}`,
          );
        } else if (event.name === "walk_forward" && r?.aggregate) {
          const a = r.aggregate as Record<string, number>;
          attachResult(
            `${t("lab.r.oos")} ${fmtPct(a.oos_return_pct)} vs ${t("lab.r.bench")} ${fmtPct(a.oos_buy_hold_return_pct)} · ` +
              `${a.folds_beating_benchmark}/${a.folds} ${t("lab.r.beat")} · ${t("lab.r.worst")} ${fmtPct(a.worst_fold_return_pct)}`,
          );
        } else if (event.name === "propose_strategy") {
          if (r?.error) {
            attachResult(`${t("lab.r.fail")}: ${r.error}`);
            setProposal(null); // rejected — Claude will fix and re-submit
          } else {
            attachResult(t("lab.r.pass"));
          }
        } else if (r?.error) {
          attachResult(`${t("lab.r.err")}: ${r.error}`);
        } else {
          attachResult("✓");
        }
        break;
      }
      case "refusal":
        setError(`${t("ai.refusal")}: ${event.message}`);
        break;
      case "error":
        setError(event.message);
        break;
      case "done":
        break;
    }
  };

  const generate = async () => {
    const cleaned = symbol.trim().toUpperCase();
    if (!cleaned || running) return;

    setRunning(true);
    setElapsed(0);
    setSteps([]);
    setThinking("");
    setCommentary("");
    setProposal(null);
    setError(null);
    setJustSaved(false);

    const controller = new AbortController();
    abortRef.current = controller;

    const form: StrategyForm = {
      symbol: cleaned,
      objective,
      validation_period: validationPeriod,
      notes,
    };

    try {
      await streamStrategy(form, handleEvent, controller.signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const handleSave = () => {
    if (!proposal) return;
    saveStrategy({
      name: proposal.name,
      symbol: proposal.symbol,
      strategy: proposal.strategy,
      params: proposal.params,
      rationale: proposal.rationale,
      risks: proposal.risks,
      beats_buy_hold: proposal.beats_buy_hold,
      in_sample: proposal.in_sample,
      validation: proposal.validation,
      walk_forward: proposal.walk_forward as Record<string, unknown> | undefined,
    });
    setSaved(savedStrategies());
    setJustSaved(true);
  };

  const runProposal = (p: {
    symbol: string;
    name: string;
    strategy: string;
    params: Record<string, unknown>;
  }) => onRun(p.symbol, p.name, { strategy: p.strategy, ...p.params });

  return (
    <div className="lab" style={hidden ? { display: "none" } : undefined}>
      <div className="lab__inner">
        <section className="lab-hero">
          <h1 className="lab-hero__title">{t("lab.title")}</h1>
          <p className="lab-hero__sub">
            {t("lab.sub1")}<b>{t("lab.sub.b")}</b>{t("lab.sub2")}
          </p>
        </section>

        {!aiEnabled ? (
          <div className="notice" style={{ maxWidth: 560 }}>
            {t("lab.aiOff")}
          </div>
        ) : (
          <>
            <div className="lab-form panel">
              <div className="control-grid" style={{ borderBottom: "none" }}>
                <label className="field">
                  <span className="field__label">{t("lab.symbol")}</span>
                  <SymbolSearch
                    value={symbol}
                    onChange={setSymbol}
                    onPick={(hit) => setSymbol(hit.symbol.toUpperCase())}
                    placeholder={t("lab.symbolPh")}
                    disabled={running}
                  />
                </label>
                <label className="field">
                  <span className="field__label">{t("lab.objective")}</span>
                  <select
                    className="select"
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    disabled={running}
                  >
                    {OBJECTIVE_VALUES.map((v) => (
                      <option key={v} value={v}>
                        {t(`lab.obj.${v}` as MsgKey)} — {t(`lab.obj.${v}.h` as MsgKey)}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">{t("lab.validation")}</span>
                  <select
                    className="select"
                    value={validationPeriod}
                    onChange={(e) => setValidationPeriod(e.target.value)}
                    disabled={running}
                  >
                    <option value="5y">{t("lab.v5y")}</option>
                    <option value="max">{t("lab.vmax")}</option>
                    <option value="2y">{t("lab.v2y")}</option>
                  </select>
                </label>
                <label className="field" style={{ gridColumn: "span 2" }}>
                  <span className="field__label">{t("lab.notes")}</span>
                  <input
                    className="input"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder={t("lab.notesPh")}
                    maxLength={200}
                    disabled={running}
                  />
                </label>
                <label className="field">
                  <span className="field__label">&nbsp;</span>
                  {running ? (
                    <button className="btn" onClick={stop}>
                      {t("lab.stop")}（{elapsed}s）
                    </button>
                  ) : (
                    <button className="btn btn--primary" onClick={generate}>
                      {t("lab.generate")}
                    </button>
                  )}
                </label>
              </div>
              <div className="lab-form__hint">{t("lab.hint")}</div>
            </div>

            <div className="lab-grid">
              {/* ------------------------------------------------ process */}
              <div className="panel lab-panel">
                <div className="panel__head">
                  <span className="panel__title">{t("lab.process")}</span>
                  <span className="panel__meta">
                    {running ? `${t("lab.state.running")} · ${elapsed}s` : steps.length ? t("lab.state.done") : t("lab.state.idle")}
                  </span>
                </div>
                <div className="lab-timeline" ref={timelineRef}>
                  {steps.length === 0 && !running && (
                    <div className="empty">{t("lab.timeline.empty")}</div>
                  )}
                  {steps.map((step, i) => (
                    <div key={i} className={`lab-step lab-step--${step.kind}`}>
                      <span className="lab-step__marker" />
                      <div className="lab-step__body">
                        <div className="lab-step__title">
                          {step.title}
                          {step.detail && <span className="dim"> · {step.detail}</span>}
                        </div>
                        {step.result && <div className="lab-step__result">{step.result}</div>}
                        {step.result === undefined && running && i === steps.length - 1 && (
                          <div className="lab-step__result dim">{t("lab.step.running")}</div>
                        )}
                      </div>
                    </div>
                  ))}
                  {thinking && running && <div className="msg__thinking">{thinking}</div>}
                  {commentary && (
                    <div className="lab-commentary">
                      {commentary}
                      {running && <span className="dim"> ▊</span>}
                    </div>
                  )}
                  {error && <div className="err">{error}</div>}
                </div>
              </div>

              {/* ----------------------------------------------- proposal */}
              <div className="lab-side">
                {proposal ? (
                  <div className="panel lab-proposal">
                    <div className="panel__head">
                      <span className="panel__title">{t("lab.proposal")}</span>
                      <span
                        className={`mk-badge ${proposal.beats_buy_hold ? "mk-badge--installed" : "mk-badge--warn"}`}
                      >
                        {proposal.beats_buy_hold ? t("lab.beats") : t("lab.trails")}
                      </span>
                    </div>
                    <div className="lab-proposal__body">
                      <div className="lab-proposal__name">{proposal.name}</div>
                      <div className="dim" style={{ fontSize: 12 }}>
                        {proposal.symbol} · {proposal.strategy}
                      </div>

                      <div className="mk-params" style={{ marginTop: 10 }}>
                        {Object.entries(proposal.params ?? {}).map(([k, v]) => (
                          <span key={k} className="mk-param">
                            <span className="dim">{k}</span> {String(v)}
                          </span>
                        ))}
                      </div>

                      {proposal.walk_forward?.folds?.length ? (
                        <WalkForwardTable report={proposal.walk_forward} />
                      ) : (
                        (proposal.in_sample || proposal.validation) && (
                          <table className="lab-stats" style={{ marginTop: 12 }}>
                            <thead>
                              <tr>
                                <th>{t("lab.tbl.window")}</th>
                                <th>{t("lab.r.return")}</th>
                                <th>{t("lab.r.bench")}</th>
                                <th>{t("lab.r.sharpe")}</th>
                                <th>{t("lab.r.dd")}</th>
                              </tr>
                            </thead>
                            <tbody>
                              {proposal.in_sample && (
                                <StatRow label={t("lab.tbl.insample")} s={proposal.in_sample} />
                              )}
                              {proposal.validation && (
                                <StatRow label={t("lab.tbl.valid")} s={proposal.validation} />
                              )}
                            </tbody>
                          </table>
                        )
                      )}

                      <p className="lab-proposal__rationale">{proposal.rationale}</p>

                      {proposal.risks?.length > 0 && (
                        <ul className="lab-risks">
                          {proposal.risks.map((risk, i) => (
                            <li key={i}>{risk}</li>
                          ))}
                        </ul>
                      )}

                      <div className="lab-proposal__actions">
                        <button
                          className="btn btn--primary"
                          onClick={() =>
                            runProposal({
                              symbol: proposal.symbol,
                              name: proposal.name,
                              strategy: proposal.strategy,
                              params: proposal.params,
                            })
                          }
                        >
                          {t("lab.run")}
                        </button>
                        <button className="btn" onClick={handleSave} disabled={justSaved}>
                          {justSaved ? t("lab.saved") : t("lab.save")}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="panel lab-proposal lab-proposal--empty">
                    <div className="panel__head">
                      <span className="panel__title">{t("lab.proposal")}</span>
                    </div>
                    <div className="empty" style={{ padding: 24 }}>
                      {running ? t("lab.proposal.wait") : t("lab.proposal.empty")}
                    </div>
                  </div>
                )}

                {saved.length > 0 && (
                  <div className="panel">
                    <div className="panel__head">
                      <span className="panel__title">{t("lab.mine")}</span>
                      <span className="panel__meta">{saved.length} · {t("lab.mine.meta")}</span>
                    </div>
                    <ul className="lab-saved">
                      {saved.map((s) => (
                        <li key={s.id} className="lab-saved__row">
                          <div style={{ minWidth: 0 }}>
                            <div className="lab-saved__name">{s.name}</div>
                            <div className="dim" style={{ fontSize: 11 }}>
                              {s.symbol} · {s.strategy}
                              {!s.beats_buy_hold && ` · ${t("lab.mine.trails")}`}
                            </div>
                          </div>
                          <div className="lab-saved__actions">
                            <button className="btn" onClick={() => runProposal(s)}>
                              {t("lab.mine.run")}
                            </button>
                            <DeployButton
                              onDeploy={() =>
                                deployPaper("strategy", `${s.symbol} · ${s.name}`, {
                                  symbol: s.symbol,
                                  strategy: s.strategy,
                                  ...s.params,
                                })
                              }
                            />
                            <button
                              className="watch-row__x"
                              title={t("lab.mine.del")}
                              onClick={() => {
                                deleteStrategy(s.id);
                                setSaved(savedStrategies());
                              }}
                            >
                              ×
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            <p className="lab-disclaimer">{t("lab.disclaimer")}</p>
          </>
        )}
      </div>
    </div>
  );
}

function WalkForwardTable({ report }: { report: NonNullable<StrategyProposal["walk_forward"]> }) {
  const { t } = useT();
  const a = report.aggregate;
  return (
    <div className="lab-wf" style={{ marginTop: 12 }}>
      <div className="lab-wf__head">
        <span className="mk-section__title" style={{ margin: 0 }}>
          {t("lab.wf.head", { n: String(a.folds), tr: String(a.train_years), te: String(a.test_years) })}
        </span>
        <span className={a.folds_beating_benchmark >= Math.ceil(a.folds / 2) ? "up" : "dn"}>
          {t("lab.wf.beat", { a: String(a.folds_beating_benchmark), b: String(a.folds) })}
        </span>
      </div>
      <table className="lab-stats">
        <thead>
          <tr>
            <th>{t("lab.wf.fold")}</th>
            <th>{t("lab.wf.window")}</th>
            <th>{t("lab.r.return")}</th>
            <th>{t("lab.r.bench")}</th>
            <th>{t("lab.r.sharpe")}</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {report.folds.map((f) => (
            <tr key={f.fold}>
              <td className="dim">{f.fold}</td>
              <td className="dim" style={{ whiteSpace: "nowrap" }}>
                {f.test_start} → {f.test_end}
              </td>
              <td className={f.beats_benchmark ? "up" : "dn"}>
                {fmtPct(f.test?.total_return_pct)}
              </td>
              <td className="dim">{fmtPct(f.test?.buy_hold_return_pct)}</td>
              <td>{Number.isFinite(f.test?.sharpe) ? f.test.sharpe.toFixed(2) : "—"}</td>
              <td>{f.beats_benchmark ? "✓" : "✗"}</td>
            </tr>
          ))}
          <tr className="lab-wf__agg">
            <td colSpan={2}>{t("lab.wf.total")}</td>
            <td className={a.oos_return_pct >= a.oos_buy_hold_return_pct ? "up" : "dn"}>
              {fmtPct(a.oos_return_pct)}
            </td>
            <td className="dim">{fmtPct(a.oos_buy_hold_return_pct)}</td>
            <td>{Number.isFinite(a.mean_test_sharpe) ? a.mean_test_sharpe.toFixed(2) : "—"}</td>
            <td></td>
          </tr>
        </tbody>
      </table>
    </div>
  );
}

function StatRow({ label, s }: { label: string; s: Record<string, unknown> }) {
  const n = (key: string) => {
    const v = s[key];
    return typeof v === "number" ? v : Number(v ?? NaN);
  };
  return (
    <tr>
      <td>{label}</td>
      <td className={n("total_return_pct") >= n("buy_hold_return_pct") ? "up" : "dn"}>
        {fmtPct(n("total_return_pct"))}
      </td>
      <td className="dim">{fmtPct(n("buy_hold_return_pct"))}</td>
      <td>{Number.isFinite(n("sharpe")) ? n("sharpe").toFixed(2) : "—"}</td>
      <td className="dn">{fmtPct(n("max_drawdown_pct"))}</td>
    </tr>
  );
}

function fmtPct(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v ?? NaN);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}
