import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type FactorHealth, type PaperTrack, type Point } from "../api";
import { useT } from "../i18n";
import { deletePaper, savedPaper, updatePaperNote, type PaperDeployment } from "../store";
import { EquityChart } from "./EquityChart";

interface Props {
  hidden: boolean;
}

type TrackState = PaperTrack | "loading" | string | undefined;
type SortKey = "recent" | "return" | "excess" | "drawdown";

/** Forward (out-of-sample by construction) tracking of deployed configs.
 * Backtests are honesty about the past; this page is honesty about what has
 * happened SINCE the user clicked deploy — recomputed fresh on every visit.
 * Each card also shows the same rule's backtest-period figures next to its
 * live figures, so the decay of the edge is visible rather than implied. */
export function PaperPage({ hidden }: Props) {
  const { t } = useT();
  const [deployments, setDeployments] = useState<PaperDeployment[]>(savedPaper);
  const [tracks, setTracks] = useState<Record<string, TrackState>>({});
  const [loadedOnce, setLoadedOnce] = useState(false);
  const [sort, setSort] = useState<SortKey>("recent");
  const [overlay, setOverlay] = useState(true);
  const [confirmId, setConfirmId] = useState<string | null>(null);
  const [health, setHealth] = useState<Record<string, FactorHealth>>({});

  // Server-side recheck verdicts for factor deployments (daily job).
  useEffect(() => {
    const byMarket = new Map<string, string[]>();
    for (const d of deployments) {
      if (d.kind !== "factor") continue;
      const mk = String(d.config.market ?? "us"), ex = String(d.config.expression ?? "");
      if (ex) byMarket.set(mk, [...(byMarket.get(mk) ?? []), ex]);
    }
    for (const [mk, exprs] of byMarket) {
      api.factorHealth(mk, exprs).then((res) => setHealth((prev) => {
        const next = { ...prev };
        for (const [e, h] of Object.entries(res.health)) next[`${mk}|${e}`] = h;
        return next;
      })).catch(() => undefined);
    }
  }, [deployments]);

  const load = useCallback((dep: PaperDeployment) => {
    setTracks((prev) => ({ ...prev, [dep.id]: "loading" }));
    api
      .paperTrack({ kind: dep.kind, started_at: dep.startedAt, config: dep.config })
      .then((track) => setTracks((prev) => ({ ...prev, [dep.id]: track })))
      .catch((err: Error) => setTracks((prev) => ({ ...prev, [dep.id]: err.message })));
  }, []);

  const refreshAll = useCallback(() => {
    const current = savedPaper();
    setDeployments(current);
    current.forEach(load);
  }, [load]);

  // Refresh NAV curves the first time the tab becomes visible with deployments.
  useEffect(() => {
    if (hidden) return;
    const current = savedPaper();
    setDeployments(current);
    if (current.length === 0 || loadedOnce) return;
    setLoadedOnce(true);
    current.forEach(load);
  }, [hidden, loadedOnce, load]);

  const remove = (id: string) => {
    if (confirmId !== id) {
      setConfirmId(id);
      window.setTimeout(() => setConfirmId((c) => (c === id ? null : c)), 3000);
      return;
    }
    setConfirmId(null);
    setDeployments(deletePaper(id));
    setTracks((prev) => {
      const next = { ...prev };
      delete next[id];
      return next;
    });
  };

  const loaded = useMemo(
    () =>
      deployments
        .map((d) => ({ dep: d, track: tracks[d.id] }))
        .filter((x): x is { dep: PaperDeployment; track: PaperTrack } => typeof x.track === "object"),
    [deployments, tracks],
  );

  const sorted = useMemo(() => {
    const val = (d: PaperDeployment): number => {
      const tr = tracks[d.id];
      if (typeof tr !== "object") return -Infinity;
      if (sort === "return") return tr.stats.return_pct;
      if (sort === "excess") return tr.stats.excess_pct;
      if (sort === "drawdown") return tr.stats.current_drawdown_pct;
      return 0;
    };
    if (sort === "recent") return [...deployments].sort((a, b) => b.startedAt.localeCompare(a.startedAt));
    return [...deployments].sort((a, b) => val(b) - val(a));
  }, [deployments, tracks, sort]);

  const summary = useMemo(() => {
    if (loaded.length === 0) return null;
    const s = loaded.map((x) => x.track.stats);
    const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
    return {
      n: loaded.length,
      avgReturn: mean(s.map((x) => x.return_pct)),
      avgExcess: mean(s.map((x) => x.excess_pct)),
      beating: s.filter((x) => x.excess_pct > 0).length,
      inDrawdown: s.filter((x) => x.current_drawdown_pct <= -10).length,
      degraded: loaded.filter((x) => x.track.decay.verdict === "degraded").length,
      combined: combineCurves(loaded.map((x) => x.track.equity_curve)),
      combinedBench: combineCurves(loaded.map((x) => x.track.benchmark_curve)),
    };
  }, [loaded]);

  const exportCsv = () => {
    const head = [
      "name", "kind", "deployed", "days_live", "as_of", "return_pct", "bench_pct", "excess_pct",
      "max_dd_pct", "current_dd_pct", "sharpe", "pre_sharpe", "pre_excess_pct", "decay", "position", "note",
    ];
    const rows = loaded.map(({ dep, track }) => [
      dep.name, dep.kind, dep.startedAt, track.days_live, track.as_of, track.stats.return_pct,
      track.stats.bench_return_pct, track.stats.excess_pct, track.stats.max_drawdown_pct,
      track.stats.current_drawdown_pct, track.stats.sharpe ?? "", track.pre.sharpe ?? "",
      track.pre.excess_pct, track.decay.verdict,
      `${track.position.state}${track.position.symbols ? ":" + track.position.symbols.join("|") : ""}`,
      dep.note ?? "",
    ]);
    const esc = (v: unknown) => `"${String(v).replace(/"/g, '""')}"`;
    const csv = [head, ...rows].map((r) => r.map(esc).join(",")).join("\n");
    const blob = new Blob(["﻿" + csv], { type: "text/csv;charset=utf-8" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `aiquant-paper-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(a.href);
  };

  return (
    <div className="lab" style={hidden ? { display: "none" } : undefined}>
      <div className="lab__inner">
        <section className="lab-hero">
          <h1 className="lab-hero__title">{t("pp.title")}</h1>
          <p className="lab-hero__sub">
            {t("pp.sub1")}
            <b>{t("pp.sub.b")}</b>
            {t("pp.sub2")}
          </p>
        </section>

        {deployments.length === 0 ? (
          <div className="notice" style={{ maxWidth: 620 }}>{t("pp.empty")}</div>
        ) : (
          <>
            {summary && (
              <section className="panel pp-summary">
                <div className="panel__head">
                  <span className="panel__title">{t("pp.summary")}</span>
                  <span className="panel__meta">{t("pp.summaryMeta", { n: String(summary.n) })}</span>
                </div>
                <div className="stat-grid pp-summary__grid">
                  <Stat label={t("pp.avgReturn")} value={pct(summary.avgReturn)} tone={summary.avgReturn} />
                  <Stat label={t("pp.avgExcess")} value={pct(summary.avgExcess)} tone={summary.avgExcess} />
                  <Stat
                    label={t("pp.beating")}
                    value={`${summary.beating} / ${summary.n}`}
                    tone={summary.beating * 2 >= summary.n ? 1 : -1}
                  />
                  <Stat
                    label={t("pp.alerts")}
                    value={String(summary.inDrawdown + summary.degraded)}
                    tone={summary.inDrawdown + summary.degraded > 0 ? -1 : 1}
                  />
                </div>
                {overlay && summary.combined.length > 1 && (
                  <>
                    <EquityChart equity={summary.combined} benchmark={summary.combinedBench} drawdown={[]} />
                    <div className="kr-disclaimer dim">{t("pp.overlayNote")}</div>
                  </>
                )}
              </section>
            )}

            <div className="pp-toolbar">
              <label className="pp-toolbar__sort">
                {t("pp.sort")}
                <select value={sort} onChange={(e) => setSort(e.target.value as SortKey)}>
                  <option value="recent">{t("pp.sort.recent")}</option>
                  <option value="return">{t("pp.sort.return")}</option>
                  <option value="excess">{t("pp.sort.excess")}</option>
                  <option value="drawdown">{t("pp.sort.drawdown")}</option>
                </select>
              </label>
              <button className="ghost" onClick={() => setOverlay((v) => !v)}>
                {overlay ? t("pp.overlayHide") : t("pp.overlayShow")}
              </button>
              <button className="ghost" onClick={refreshAll}>{t("pp.refresh")}</button>
              <button className="ghost" onClick={exportCsv} disabled={loaded.length === 0}>
                {t("pp.export")}
              </button>
            </div>

            <div className="pp-grid">
              {sorted.map((dep) => (
                <Card
                  key={dep.id}
                  dep={dep}
                  track={tracks[dep.id]}
                  confirming={confirmId === dep.id}
                  onRemove={() => remove(dep.id)}
                  onRefresh={() => load(dep)}
                  onNote={(note) => setDeployments(updatePaperNote(dep.id, note))}
                  health={dep.kind === "factor" ? health[`${String(dep.config.market ?? "us")}|${String(dep.config.expression ?? "")}`] : undefined}
                />
              ))}
            </div>
          </>
        )}

        <p className="lab-disclaimer">{t("pp.disclaimer")}</p>
      </div>
    </div>
  );
}

// ------------------------------------------------------------------ card

interface CardProps {
  dep: PaperDeployment;
  track: TrackState;
  confirming: boolean;
  onRemove: () => void;
  onRefresh: () => void;
  onNote: (note: string) => void;
  health?: FactorHealth;
}

function Card({ dep, track, confirming, onRemove, onRefresh, onNote, health }: CardProps) {
  const { t } = useT();
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(dep.note ?? "");
  const ok = typeof track === "object";
  const ddAlert = ok && track.stats.current_drawdown_pct <= -10;

  return (
    <div className={`panel pp-card ${ok && track.decay.verdict === "degraded" ? "pp-card--degraded" : ""}`}>
      <div className="panel__head">
        <span className="panel__title">
          {dep.kind === "factor" ? "⛏" : dep.kind === "pipeline" ? "⚙" : "📈"} {dep.name}
          <span className="pp-chip pp-kind">{t(`pp.kind.${dep.kind}`)}</span>
        </span>
        <span className="panel__meta pp-card__meta">
          {t("pp.since", { d: dep.startedAt })}
          <button className="watch-row__x" title={t("pp.refreshOne")} onClick={onRefresh}>↻</button>
          <button
            className={`watch-row__x ${confirming ? "pp-x--confirm" : ""}`}
            title={t("pp.remove")}
            onClick={onRemove}
          >
            {confirming ? t("pp.confirm") : "×"}
          </button>
        </span>
      </div>

      {editing ? (
        <form
          className="pp-note pp-note--edit"
          onSubmit={(e) => {
            e.preventDefault();
            onNote(draft.trim());
            setEditing(false);
          }}
        >
          <input
            autoFocus
            maxLength={120}
            value={draft}
            placeholder={t("pp.notePh")}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={() => {
              onNote(draft.trim());
              setEditing(false);
            }}
          />
        </form>
      ) : (
        <button className="pp-note" onClick={() => setEditing(true)} title={t("pp.noteEdit")}>
          {dep.note ? dep.note : <span className="dim">{t("pp.notePh")}</span>}
        </button>
      )}

      {track === "loading" || track === undefined ? (
        <div className="empty" style={{ padding: 28 }}>{t("pp.loading")}</div>
      ) : typeof track === "string" ? (
        <div className="err">{track}</div>
      ) : (
        <>
          <div className="pp-badges">
            <PositionChip track={track} />
            <DecayChip track={track} />
            {health && (
              <span className={`pp-chip ${health.decayed ? "pp-chip--warn" : "pp-chip--ok"}`} title={t("pp.healthTitle", { d: health.as_of })}>
                ☁ {t("pp.health", { g: `${health.grades.predictive}${health.grades.stability}${health.grades.robustness}${health.grades.tradability}${health.grades.significance}` })}
                {health.decayed ? ` · ${t("fl.sh.decayed")}` : ""}
              </span>
            )}
            {ddAlert && (
              <span className="pp-chip pp-chip--warn" title={t("pp.ddAlertTitle")}>
                ⚠ {t("pp.ddAlert", { v: track.stats.current_drawdown_pct.toFixed(1) })}
              </span>
            )}
            {track.trades_live !== null && (
              <span className="pp-chip">{t("pp.tradesLive", { n: String(track.trades_live) })}</span>
            )}
          </div>

          <EquityChart equity={track.equity_curve} benchmark={track.benchmark_curve} drawdown={[]} />

          <div className="stat-grid pp-stats">
            <Stat
              label={t("pp.liveReturn", { n: String(track.days_live) })}
              value={pct(track.stats.return_pct)}
              tone={track.stats.return_pct}
            />
            <Stat label={t("pp.bench")} value={pct(track.stats.bench_return_pct)} tone={track.stats.bench_return_pct} />
            <Stat label={t("pp.excess")} value={pct(track.stats.excess_pct)} tone={track.stats.excess_pct} />
            <Stat label={t("bt.maxdd")} value={pct(track.stats.max_drawdown_pct)} tone={-1} />
            <Stat label={t("pp.sharpe")} value={num(track.stats.sharpe)} tone={track.stats.sharpe ?? 0} />
            <Stat label={t("pp.last7")} value={pctOpt(track.stats.last_7d_pct)} tone={track.stats.last_7d_pct ?? 0} />
            <Stat label={t("pp.last30")} value={pctOpt(track.stats.last_30d_pct)} tone={track.stats.last_30d_pct ?? 0} />
            <Stat label={t("pp.winRate")} value={pctPlain(track.stats.win_rate_pct)} />
          </div>

          <Sparkline data={track.daily_returns} label={t("pp.sparkline")} />

          <table className="pp-compare">
            <thead>
              <tr>
                <th>{t("pp.cmp.metric")}</th>
                <th>
                  {t("pp.cmp.pre")}
                  <small>{track.pre.bars} {t("pp.cmp.bars")}</small>
                </th>
                <th>
                  {t("pp.cmp.post")}
                  <small>{track.stats.bars} {t("pp.cmp.bars")}</small>
                </th>
              </tr>
            </thead>
            <tbody>
              <Row label={t("pp.excess")} a={track.pre.excess_pct} b={track.stats.excess_pct} fmt={pct} />
              <Row label={t("pp.sharpe")} a={track.pre.sharpe} b={track.stats.sharpe} fmt={num} />
              <Row label={t("bt.maxdd")} a={track.pre.max_drawdown_pct} b={track.stats.max_drawdown_pct} fmt={pct} invert />
              <Row label={t("pp.winRate")} a={track.pre.win_rate_pct} b={track.stats.win_rate_pct} fmt={pctPlain} />
            </tbody>
          </table>

          <div className="kr-disclaimer dim">{t("pp.note", { d: track.as_of })}</div>
        </>
      )}
    </div>
  );
}

function PositionChip({ track }: { track: PaperTrack }) {
  const { t } = useT();
  const p = track.position;
  if (p.state === "long")
    return <span className="pp-chip pp-chip--long">▲ {t("pp.pos.long", { d: p.since ?? "" })}</span>;
  if (p.state === "flat")
    return <span className="pp-chip pp-chip--flat">▽ {t("pp.pos.flat", { d: p.since ?? "" })}</span>;
  if (p.state === "holdings") {
    const symbols = p.symbols ?? [];
    const weights = p.weights_pct;
    // Pipeline deployments carry target weights aligned with the symbols.
    const label = symbols
      .map((s, i) => (weights && weights[i] !== undefined ? `${s} ${weights[i].toFixed(1)}%` : s))
      .join(" · ");
    return (
      <span className="pp-chip pp-chip--long" title={t("pp.pos.holdingsTitle", { d: p.since ?? "" })}>
        ◧ {t("pp.pos.holdings")} {label}
      </span>
    );
  }
  return <span className="pp-chip">{t("pp.pos.unknown")}</span>;
}

function DecayChip({ track }: { track: PaperTrack }) {
  const { t } = useT();
  const d = track.decay;
  const cls =
    d.verdict === "degraded" ? "pp-chip--warn" : d.verdict === "improved" ? "pp-chip--long" : d.verdict === "holding" ? "pp-chip--ok" : "";
  const delta = d.sharpe_delta === null ? "" : ` (Sharpe ${d.sharpe_delta > 0 ? "+" : ""}${d.sharpe_delta.toFixed(2)})`;
  return (
    <span className={`pp-chip ${cls}`} title={t("pp.decayTitle")}>
      {t(`pp.decay.${d.verdict}` as "pp.decay.holding")}
      {delta}
    </span>
  );
}

function Row({
  label, a, b, fmt, invert,
}: { label: string; a: number | null; b: number | null; fmt: (v: number | null) => string; invert?: boolean }) {
  let tone = 0;
  if (a !== null && b !== null) tone = (b - a) * (invert ? -1 : 1);
  const cls = tone > 0.01 ? "up" : tone < -0.01 ? "dn" : "";
  return (
    <tr>
      <td>{label}</td>
      <td className="dim">{fmt(a)}</td>
      <td className={cls}>{fmt(b)}</td>
    </tr>
  );
}

/** Tiny bar sparkline of the last N daily returns — reads at a glance whether
 * the live period has been choppy or a smooth grind. */
function Sparkline({ data, label }: { data: Array<{ time: number; ret_pct: number }>; label: string }) {
  if (data.length < 2) return null;
  const w = 100;
  const h = 28;
  const max = Math.max(0.01, ...data.map((d) => Math.abs(d.ret_pct)));
  const bw = w / data.length;
  return (
    <div className="pp-spark" title={label}>
      <span className="pp-spark__label">{label}</span>
      <svg viewBox={`0 0 ${w} ${h}`} preserveAspectRatio="none" aria-hidden="true">
        <line x1="0" y1={h / 2} x2={w} y2={h / 2} className="pp-spark__axis" />
        {data.map((d, i) => {
          const bh = (Math.abs(d.ret_pct) / max) * (h / 2 - 1);
          const y = d.ret_pct >= 0 ? h / 2 - bh : h / 2;
          return (
            <rect
              key={d.time}
              x={i * bw + bw * 0.15}
              y={y}
              width={bw * 0.7}
              height={Math.max(0.4, bh)}
              className={d.ret_pct >= 0 ? "pp-spark__up" : "pp-spark__dn"}
            />
          );
        })}
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

// -------------------------------------------------------------- helpers

/** Equal-weight NAV across curves, on the dates ALL curves share, rebased
 * to 100k. Deployments start on different days, so the overlay only covers
 * the span since the most recent one went live — stated in the caption. */
function combineCurves(curves: Point[][]): Point[] {
  if (curves.length === 0) return [];
  if (curves.length === 1) return curves[0];
  // Key by calendar day: equity bars from different venues carry different
  // intraday timestamps (00:00 UTC crypto vs. exchange-open equities).
  const day = (tm: number) => Math.floor(tm / 86400);
  const maps = curves.map((c) => new Map(c.map((p) => [day(p.time), p.value])));
  const days = [...maps[0].keys()].filter((d) => maps.every((m) => m.has(d))).sort((a, b) => a - b);
  if (days.length < 2) return [];
  const bases = maps.map((m) => m.get(days[0]) ?? 1);
  return days.map((d) => ({
    time: d * 86400,
    value: Math.round(
      (maps.reduce((acc, m, i) => acc + (m.get(d) ?? bases[i]) / bases[i], 0) / maps.length) * 100_000 * 100,
    ) / 100,
  }));
}

const pct = (v: number | null) => (v === null ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}%`);
const pctOpt = (v: number | null) => (v === null ? "—" : pct(v));
const pctPlain = (v: number | null) => (v === null ? "—" : `${v.toFixed(1)}%`);
const num = (v: number | null) => (v === null ? "—" : v.toFixed(2));
