import { useEffect, useRef, useState } from "react";
import { streamNDJSON } from "../api";
import { useT } from "../i18n";

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
      await streamNDJSON(
        "/api/factors/mine",
        { market, horizon, rounds, per_round: perRound },
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
            case "done":
              setFinished(true);
              break;
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

        {!aiEnabled ? (
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
              <div className="lab-form__hint">{t("fl.hint")}</div>
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
