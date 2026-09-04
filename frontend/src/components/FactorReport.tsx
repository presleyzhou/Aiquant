import { useState } from "react";
import { api, type FactorReport as Report } from "../api";
import { useT, type MsgKey } from "../i18n";

const AXES = ["predictive", "stability", "robustness", "tradability", "significance"] as const;

/** "🩺 体检" — practitioner report card for one factor: quantile spread,
 * IC decay by horizon, turnover / cost-adjusted spread, walk-forward folds,
 * bull/bear split and a horizon-adjusted t-stat, each graded A/B/C. */
export function FactorReportButton({ expression, market, horizon }: { expression: string; market: string; horizon: number }) {
  const { t } = useT();
  const [report, setReport] = useState<Report | null>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (busy) return;
    if (report) {
      setOpen((v) => !v);
      return;
    }
    setBusy(true);
    setError(null);
    try {
      setReport(await api.factorAnalyze(expression, market, horizon));
      setOpen(true);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="fr">
      <button className="btn btn--mini" onClick={run} disabled={busy} title={t("fr.title")}>
        {busy ? "…" : report ? (open ? t("fr.hide") : t("fr.show")) : t("fr.button")}
      </button>
      {error && <div className="err" style={{ marginTop: 4 }}>{error}</div>}
      {report && open && <ReportBody r={report} />}
    </div>
  );
}

function ReportBody({ r }: { r: Report }) {
  const { t } = useT();
  const pct = (v: number) => `${v >= 0 ? "+" : ""}${v.toFixed(2)}%`;
  const ic = (v: number | null) => (v === null ? "—" : v.toFixed(3));
  return (
    <div className="fr__body">
      <div className="fr__grades">
        {AXES.map((a) => (
          <span key={a} className={`fr-grade fr-grade--${r.grades[a]}`} title={t(`fr.axis.${a}.tip` as MsgKey)}>
            <b>{r.grades[a]}</b> {t(`fr.axis.${a}` as MsgKey)}
          </span>
        ))}
      </div>

      <div className="fr__row">
        <div className="fr__block">
          <div className="fr__head">{t("fr.quantiles")}</div>
          <QuantileBars data={r.quantiles} />
          <div className="fr__kv">
            <span>{t("fr.spread")}</span><b>{pct(r.spread_pct)}</b>
            <span>{t("fr.mono")}</span><b>{r.monotonicity.toFixed(2)}</b>
          </div>
        </div>
        <div className="fr__block">
          <div className="fr__head">{t("fr.decay")}</div>
          <DecayLine data={r.ic_decay} current={r.horizon} best={r.best_horizon} />
          <div className="fr__kv">
            <span>{t("fr.bestH")}</span><b>{r.best_horizon}</b>
            <span>{t("fr.meanIc")}</span><b>{ic(r.mean_ic)} · ICIR {r.icir.toFixed(2)}</b>
          </div>
        </div>
      </div>

      <div className="fr__row">
        <div className="fr__block">
          <div className="fr__head">{t("fr.trade")}</div>
          <div className="fr__kv">
            <span>{t("fr.turnover", { n: String(r.top_n), h: String(r.horizon) })}</span><b>{(r.turnover * 100).toFixed(0)}%</b>
            <span>{t("fr.cost", { b: String(r.cost_bps) })}</span><b>{pct(-r.cost_pct)}</b>
            <span>{t("fr.afterCost")}</span><b className={r.spread_after_cost_pct > 0 ? "up" : "dn"}>{pct(r.spread_after_cost_pct)}</b>
            <span>{t("fr.afterCostAnn")}</span><b className={r.spread_after_cost_ann_pct > 0 ? "up" : "dn"}>{pct(r.spread_after_cost_ann_pct)}</b>
          </div>
        </div>
        <div className="fr__block">
          <div className="fr__head">{t("fr.robust")}</div>
          <table className="fr__folds">
            <tbody>
              {r.folds.map((f) => (
                <tr key={f.fold}>
                  <td className="dim">{f.from} → {f.to}</td>
                  <td className={f.ic * r.sign > 0 ? "up" : "dn"}>{ic(f.ic)}</td>
                </tr>
              ))}
            </tbody>
          </table>
          <div className="fr__kv">
            <span>{t("fr.regimes")}</span>
            <b>
              ▲ {ic(r.regimes.up_ic)} <span className="dim">({r.regimes.up_days})</span> · ▼ {ic(r.regimes.down_ic)} <span className="dim">({r.regimes.down_days})</span>
            </b>
            <span>{t("fr.tstat")}</span><b>{r.t_stat_adj.toFixed(2)} <span className="dim">({t("fr.tstatRaw", { v: r.t_stat.toFixed(2) })})</span></b>
          </div>
        </div>
      </div>

      <ul className="fr__sugg">
        {r.suggestions.map((s) => (
          <li key={s.code}>{t(`fr.s.${s.code}` as MsgKey, { v: String(s.value ?? "") })}</li>
        ))}
      </ul>
      <div className="dim" style={{ fontSize: 10.5 }}>{t("fr.foot", { d: r.as_of, n: String(r.days) })}</div>
    </div>
  );
}

function QuantileBars({ data }: { data: Array<{ q: number; ret_pct: number }> }) {
  const w = 160, h = 60, pad = 4;
  const max = Math.max(0.01, ...data.map((d) => Math.abs(d.ret_pct)));
  const bw = (w - pad * 2) / data.length;
  const mid = h / 2;
  return (
    <svg viewBox={`0 0 ${w} ${h + 12}`} className="fr__svg" aria-hidden="true">
      <line x1={pad} y1={mid} x2={w - pad} y2={mid} className="fr__axis" />
      {data.map((d, i) => {
        const bh = (Math.abs(d.ret_pct) / max) * (mid - 2);
        const y = d.ret_pct >= 0 ? mid - bh : mid;
        return (
          <g key={d.q}>
            <rect x={pad + i * bw + bw * 0.15} y={y} width={bw * 0.7} height={Math.max(0.5, bh)} className={d.ret_pct >= 0 ? "fr__up" : "fr__dn"} />
            <text x={pad + i * bw + bw / 2} y={h + 9} textAnchor="middle" className="fr__lbl">Q{d.q}</text>
          </g>
        );
      })}
    </svg>
  );
}

function DecayLine({ data, current, best }: { data: Array<{ horizon: number; ic: number }>; current: number; best: number }) {
  const w = 160, h = 60, pad = 8;
  if (data.length === 0) return null;
  const max = Math.max(0.005, ...data.map((d) => Math.abs(d.ic)));
  const xs = data.map((_, i) => pad + (i * (w - pad * 2)) / Math.max(1, data.length - 1));
  const ys = data.map((d) => h / 2 - (d.ic / max) * (h / 2 - 4));
  const path = xs.map((x, i) => `${i === 0 ? "M" : "L"}${x.toFixed(1)},${ys[i].toFixed(1)}`).join(" ");
  return (
    <svg viewBox={`0 0 ${w} ${h + 12}`} className="fr__svg" aria-hidden="true">
      <line x1={pad} y1={h / 2} x2={w - pad} y2={h / 2} className="fr__axis" />
      <path d={path} className="fr__line" />
      {data.map((d, i) => (
        <g key={d.horizon}>
          <circle cx={xs[i]} cy={ys[i]} r={d.horizon === best ? 3.5 : 2.2} className={d.horizon === best ? "fr__dotBest" : d.horizon === current ? "fr__dotCur" : "fr__dot"} />
          <text x={xs[i]} y={h + 9} textAnchor="middle" className="fr__lbl">{d.horizon}</text>
        </g>
      ))}
    </svg>
  );
}
