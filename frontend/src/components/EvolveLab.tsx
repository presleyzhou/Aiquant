import { useRef, useState } from "react";
import { streamNDJSON } from "../api";
import { useT } from "../i18n";
import { saveFactors, savedFactors } from "../store";
import { EquityChart } from "./EquityChart";

interface Champion {
  expression: string;
  fitness: number;
  is_ic?: number;
  is_icir?: number;
  complexity?: number;
  total_return_pct?: number;
  cagr_pct?: number | null;
  sharpe?: number;
  max_drawdown_pct?: number;
  bench_return_pct?: number;
}

interface GenEvent {
  gen: number;
  generations: number;
  best_fitness: number;
  mean_fitness: number;
  unique: number;
  evaluated_total: number;
  hof_size: number;
  champion: Champion;
  elapsed: number;
}

interface Discovered {
  expression: string;
  gen: number;
  is_ic: number;
  is_icir: number;
  oos_ic: number;
  complexity: number;
  accepted: boolean;
  reasons: string[];
  invert: boolean;
  total_return_pct: number;
  cagr_pct: number | null;
  sharpe: number;
  max_drawdown_pct: number;
  bench_return_pct: number;
}

interface DoneEvent {
  market: string;
  horizon: number;
  generations: number;
  evaluated_total: number;
  elapsed: number;
  discovered: Discovered[];
  history: Array<{ gen: number; is_ic?: number; sharpe?: number; total_return_pct?: number }>;
  equity_curve?: { time: number; value: number }[];
  benchmark_curve?: { time: number; value: number }[];
  drawdown_curve?: { time: number; value: number }[];
}

/** Genetic-programming factor evolution: no LLM, no API key — expression
 * trees evolve under |IC| fitness with parsimony and novelty pressure. The
 * holdout is consulted exactly once at the end, per hall-of-fame factor. */
export function EvolveLab() {
  const { t } = useT();
  const [market, setMarket] = useState("us");
  const [horizon, setHorizon] = useState(10);
  const [population, setPopulation] = useState(40);
  const [generations, setGenerations] = useState(15);
  const [mode, setMode] = useState("standard");
  const [warmStart, setWarmStart] = useState(true);

  const [running, setRunning] = useState(false);
  const [gens, setGens] = useState<GenEvent[]>([]);
  const [done, setDone] = useState<DoneEvent | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [added, setAdded] = useState<Set<string>>(new Set());
  const abortRef = useRef<AbortController | null>(null);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setGens([]);
    setDone(null);
    setError(null);
    setAdded(new Set());
    const controller = new AbortController();
    abortRef.current = controller;
    const seeds = warmStart
      ? savedFactors().filter((f) => f.market === market).map((f) => f.expression).slice(0, 10)
      : [];
    try {
      await streamNDJSON(
        "/api/factors/evolve",
        { market, horizon, population, generations, mode, seeds },
        (event) => {
          const e = event as unknown as { type: string } & Record<string, unknown>;
          if (e.type === "gen") setGens((prev) => [...prev, e as unknown as GenEvent]);
          else if (e.type === "done") setDone(e as unknown as DoneEvent);
          else if (e.type === "error") setError(e.message as string);
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

  const addToZoo = (d: Discovered) => {
    saveFactors([
      {
        expression: d.expression,
        hypothesis: t("gp.hypothesis", { g: String(d.gen) }),
        market,
        horizon,
        is_ic: d.is_ic,
        is_icir: d.is_icir,
        oos_ic: d.oos_ic,
        savedAt: new Date().toISOString(),
      },
    ]);
    setAdded((prev) => new Set(prev).add(d.expression));
  };

  const last = gens[gens.length - 1];
  const champion = last?.champion;
  const progress = last ? (last.gen / last.generations) * 100 : 0;

  return (
    <>
      <div className="lab-form panel">
        <div className="control-grid" style={{ borderBottom: "none" }}>
          <label className="field">
            <span className="field__label">{t("fl.market")}</span>
            <select className="select" value={market} onChange={(e) => setMarket(e.target.value)} disabled={running}>
              <option value="us">{t("fl.market.us")}</option>
              <option value="crypto">{t("fl.market.crypto")}</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t("fl.horizon")}</span>
            <select className="select" value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} disabled={running}>
              {[5, 10, 20].map((h) => (
                <option key={h} value={h}>{t("fl.horizonOpt", { n: String(h) })}</option>
              ))}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t("gp.population")}</span>
            <select className="select" value={population} onChange={(e) => setPopulation(Number(e.target.value))} disabled={running}>
              {[20, 40, 60, 80].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t("gp.generations")}</span>
            <select className="select" value={generations} onChange={(e) => setGenerations(Number(e.target.value))} disabled={running}>
              {[5, 10, 15, 20, 30].map((n) => <option key={n} value={n}>{n}</option>)}
            </select>
          </label>
          <label className="field">
            <span className="field__label">{t("fl.mode")}</span>
            <select className="select" value={mode} onChange={(e) => setMode(e.target.value)} disabled={running}>
              <option value="strict">{t("fl.mode.strict")}</option>
              <option value="standard">{t("fl.mode.standard")}</option>
              <option value="loose">{t("fl.mode.loose")}</option>
            </select>
          </label>
          <label className="field">
            <span className="field__label">&nbsp;</span>
            {running ? (
              <button className="btn" onClick={() => abortRef.current?.abort()}>{t("lab.stop")}</button>
            ) : (
              <button className="btn btn--primary" onClick={run}>{t("gp.run")}</button>
            )}
          </label>
        </div>
        <div className="lab-form__hint">
          <label className="gp-warm">
            <input type="checkbox" checked={warmStart} onChange={(e) => setWarmStart(e.target.checked)} disabled={running} />{" "}
            {t("gp.warmStart")}
          </label>
          {" · "}
          {t("gp.hint")}
        </div>
      </div>

      <div className="lab-grid">
        {/* ------------------------------------------- evolution progress */}
        <div className="panel lab-panel">
          <div className="panel__head">
            <span className="panel__title">{t("gp.progress")}</span>
            <span className="panel__meta">
              {last
                ? t("gp.genMeta", { g: String(last.gen), n: String(last.generations), e: String(last.evaluated_total), s: String(last.elapsed) })
                : t("lab.state.idle")}
            </span>
          </div>
          <div className="gp-body">
            {gens.length === 0 && !running && <div className="empty">{t("gp.empty")}</div>}
            {gens.length > 0 && (
              <>
                <div className="gp-bar"><div className="gp-bar__fill" style={{ width: `${progress}%` }} /></div>
                <Sparklines gens={gens} t={t} />
                {champion && (
                  <div className="gp-champion">
                    <div className="gp-champion__label dim">{t("gp.champion", { g: String(last.gen) })}</div>
                    <code className="fl-cand__expr">{champion.expression}</code>
                    <div className="stat-grid" style={{ marginTop: 8 }}>
                      <Stat label={t("gp.cumReturn")} value={pct(champion.total_return_pct)} tone={champion.total_return_pct} />
                      <Stat label={t("gp.cagr")} value={pct(champion.cagr_pct ?? undefined)} tone={champion.cagr_pct ?? 0} />
                      <Stat label={t("bt.sharpe")} value={fix(champion.sharpe, 2)} tone={champion.sharpe} />
                      <Stat label={t("bt.maxdd")} value={pct(champion.max_drawdown_pct)} tone={-1} />
                      <Stat label={t("fl.m.isic")} value={fix(champion.is_ic, 3, true)} tone={champion.is_ic} />
                      <Stat label={t("gp.generation")} value={`${last.gen} / ${last.generations}`} />
                    </div>
                    <div className="dim" style={{ fontSize: 11, padding: "6px 0 0" }}>
                      {t("gp.champNote", { b: pct(champion.bench_return_pct), u: String(last.unique), h: String(last.hof_size) })}
                    </div>
                  </div>
                )}
              </>
            )}
            {running && <div className="lab-step__result dim">{t("gp.evolving")}</div>}
            {error && <div className="err">{error}</div>}
          </div>
        </div>

        {/* -------------------------------------------- discovered factors */}
        <div className="lab-side">
          <div className="panel">
            <div className="panel__head">
              <span className="panel__title">{t("gp.discovered")}</span>
              <span className="panel__meta">{done ? t("gp.doneMeta", { n: String(done.discovered.length), g: String(done.generations) }) : ""}</span>
            </div>
            {!done ? (
              <div className="empty" style={{ padding: 24 }}>{running ? t("gp.waitDone") : t("gp.discoveredEmpty")}</div>
            ) : done.discovered.length === 0 ? (
              <div className="empty" style={{ padding: 24 }}>{t("gp.none")}</div>
            ) : (
              <>
                {done.equity_curve && done.benchmark_curve && (
                  <EquityChart equity={done.equity_curve} benchmark={done.benchmark_curve} drawdown={done.drawdown_curve ?? []} />
                )}
                <ul className="lab-saved">
                  {done.discovered.map((d) => (
                    <li key={d.expression} className="lab-saved__row fl-zoo-row">
                      <div style={{ minWidth: 0, flex: 1 }}>
                        <code style={{ fontSize: 11, wordBreak: "break-all" }}>{d.expression}</code>
                        <div className="fl-cand__metrics" style={{ marginTop: 4 }}>
                          <span className="fl-chip"><span className="dim">G</span> <b>{d.gen}</b></span>
                          <span className="fl-chip"><span className="dim">{t("fl.m.isic")}</span> <b className={d.is_ic >= 0 ? "up" : "dn"}>{fix(d.is_ic, 3, true)}</b></span>
                          <span className="fl-chip"><span className="dim">{t("fl.m.oosic")}</span> <b className={d.oos_ic >= 0 ? "up" : "dn"}>{fix(d.oos_ic, 3, true)}</b></span>
                          <span className="fl-chip"><span className="dim">{t("bt.sharpe")}</span> <b>{fix(d.sharpe, 2)}</b></span>
                          <span className="fl-chip"><span className="dim">{t("gp.cumReturn")}</span> <b className={d.total_return_pct >= 0 ? "up" : "dn"}>{pct(d.total_return_pct)}</b></span>
                          <span className="fl-chip"><span className="dim">{t("bt.maxdd")}</span> <b className="dn">{pct(d.max_drawdown_pct)}</b></span>
                        </div>
                        <div className={`fl-badge ${d.accepted ? "fl-badge--ok" : "fl-badge--warn"}`}>
                          {d.accepted ? t("fl.accepted") : `${t("fl.rejected")} · ${d.reasons.join("；")}`}
                        </div>
                      </div>
                      <div className="lab-saved__actions">
                        <button className="btn btn--mini" disabled={added.has(d.expression)} onClick={() => addToZoo(d)}>
                          {added.has(d.expression) ? t("gp.added") : t("gp.addZoo")}
                        </button>
                      </div>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </div>

          <div className="panel">
            <div className="panel__head"><span className="panel__title">{t("fl.how")}</span></div>
            <div className="panel__body fl-how">
              <p>{t("gp.how1")}</p>
              <p>{t("gp.how2")}</p>
              <p className="dim">{t("gp.refs")}</p>
            </div>
          </div>
        </div>
      </div>
    </>
  );
}

/** Two tiny SVG sparklines: champion |IC| and champion Sharpe per generation. */
function Sparklines({ gens, t }: { gens: GenEvent[]; t: (k: never, v?: Record<string, string>) => string }) {
  const tt = t as unknown as (k: string) => string;
  const ic = gens.map((g) => Math.abs(g.champion.is_ic ?? 0));
  const sh = gens.map((g) => g.champion.sharpe ?? 0);
  return (
    <div className="gp-sparks">
      <Spark label={tt("gp.sparkIc")} values={ic} color="#3ec8e0" fmt={(v) => v.toFixed(3)} />
      <Spark label={tt("gp.sparkSharpe")} values={sh} color="#ffb000" fmt={(v) => v.toFixed(2)} />
    </div>
  );
}

function Spark({ label, values, color, fmt }: { label: string; values: number[]; color: string; fmt: (v: number) => string }) {
  const w = 260, h = 46, pad = 3;
  const finite = values.filter((v) => Number.isFinite(v));
  const min = Math.min(0, ...finite), max = Math.max(...finite, 0.0001);
  const pts = values.map((v, i) => {
    const x = pad + (i / Math.max(1, values.length - 1)) * (w - pad * 2);
    const y = h - pad - ((Number.isFinite(v) ? v : 0) - min) / (max - min || 1) * (h - pad * 2);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  return (
    <div className="gp-spark">
      <div className="gp-spark__label dim">{label} <b style={{ color }}>{fmt(values[values.length - 1] ?? 0)}</b></div>
      <svg viewBox={`0 0 ${w} ${h}`} className="gp-spark__svg" preserveAspectRatio="none">
        <polyline points={pts.join(" ")} fill="none" stroke={color} strokeWidth="1.5" />
      </svg>
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const cls = tone === undefined ? "" : tone > 0 ? "up" : tone < 0 ? "dn" : "";
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value ${cls}`}>{value}</div>
    </div>
  );
}

const pct = (v?: number) => (v === undefined || v === null || !Number.isFinite(v) ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const fix = (v: number | undefined, d: number, signed = false) =>
  v === undefined || !Number.isFinite(v) ? "—" : `${signed && v > 0 ? "+" : ""}${v.toFixed(d)}`;
