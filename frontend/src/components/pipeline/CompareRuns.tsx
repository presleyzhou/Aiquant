import type { PipelineResult } from "../../api";
import { useT } from "../../i18n";
import type { PinnedRun } from "./form";
import { fmtAum, tone } from "./format";

type Metric = {
  key: string;
  label: string;
  /** null = not available on this run */
  get: (r: PipelineResult) => number | null | undefined;
  fmt: (v: number) => string;
  /** Δ formatting; defaults to a signed two-decimal number. */
  fmtDelta?: (d: number) => string;
  /** lower is better (turnover) → the tone flips */
  invert?: boolean;
};

const signed = (d: number, digits = 2) => `${d > 0 ? "+" : ""}${d.toFixed(digits)}`;
const signedPct = (d: number) => `${signed(d)}%`;
const signedAum = (d: number) => `${d > 0 ? "+" : d < 0 ? "−" : ""}${fmtAum(Math.abs(d))}`;

/** V4-pipeline: A (pinned) vs B (on screen) — ten headline metrics with a
 * toned Δ = B − A. Metrics one of the runs lacks print as dashes; nothing is
 * interpolated. */
export function CompareRuns({
  pinned, current, currentLabel, onSwap, onClear,
}: { pinned: PinnedRun; current: PipelineResult; currentLabel: string; onSwap: () => void; onClear: () => void }) {
  const { t } = useT();
  const pct1 = (v: number) => `${v.toFixed(1)}%`;
  const metrics: Metric[] = [
    { key: "sharpe", label: t("bt.sharpe"), get: (r) => r.backtest.stats.sharpe, fmt: (v) => v.toFixed(2) },
    { key: "holdout", label: t("pl.cmp.holdoutSharpe"), get: (r) => r.backtest.holdout.sharpe, fmt: (v) => v.toFixed(2) },
    { key: "cagr", label: t("bt.cagr"), get: (r) => r.backtest.stats.cagr_pct, fmt: pct1, fmtDelta: signedPct },
    { key: "maxdd", label: t("bt.maxdd"), get: (r) => r.backtest.stats.max_drawdown_pct, fmt: pct1, fmtDelta: signedPct },
    { key: "turnover", label: t("pl.cmp.turnover"), get: (r) => r.portfolio.annual_turnover_x, fmt: (v) => `${v.toFixed(1)}×`, fmtDelta: (d) => `${signed(d, 1)}×`, invert: true },
    { key: "psr", label: "PSR", get: (r) => r.backtest.overfitting?.psr, fmt: (v) => v.toFixed(2) },
    { key: "dsr", label: "DSR", get: (r) => r.backtest.overfitting?.dsr, fmt: (v) => v.toFixed(2) },
    { key: "cpcv", label: t("pl.cmp.cpcvMedian"), get: (r) => r.cpcv?.median_sharpe, fmt: (v) => v.toFixed(2) },
    { key: "capacity", label: t("pl.cmp.capacity"), get: (r) => r.capacity?.breakeven_aum, fmt: fmtAum, fmtDelta: signedAum },
    { key: "effn", label: t("pl.cmp.effN"), get: (r) => r.portfolio.avg_effective_n, fmt: (v) => v.toFixed(1), fmtDelta: (d) => signed(d, 1) },
  ];
  return (
    <div className="pl-compare" data-testid="pl-compare">
      <div className="pl-subhead">
        {t("pl.cmp.title")}
        <span className="dim pl-subhead__note">{t("pl.cmp.note")}</span>
        <span className="pl-compare__actions">
          <button className="btn btn--mini" onClick={onSwap} title={t("pl.cmp.swapTitle")} data-testid="pl-compare-swap">
            ⇄ {t("pl.cmp.swap")}
          </button>
          <button className="btn btn--mini" onClick={onClear} data-testid="pl-compare-clear">
            ✕ {t("pl.cmp.clear")}
          </button>
        </span>
      </div>
      <div className="table-scroll">
        <table className="lab-stats pl-compare__table" data-testid="pl-compare-table">
          <thead>
            <tr>
              <th>{t("pp.cmp.metric")}</th>
              <th className="pl-num">
                A<small className="pl-th-sub">{pinned.label}</small>
              </th>
              <th className="pl-num">
                B<small className="pl-th-sub">{currentLabel}</small>
              </th>
              <th className="pl-num">Δ (B − A)</th>
            </tr>
          </thead>
          <tbody>
            {metrics.map((m) => {
              const a = m.get(pinned.result);
              const b = m.get(current);
              const both = a !== null && a !== undefined && b !== null && b !== undefined;
              const d = both ? b - a : null;
              const cls = d === null ? "dim" : tone(m.invert ? -d : d);
              return (
                <tr key={m.key} data-metric={m.key}>
                  <td>{m.label}</td>
                  <td className="pl-num dim">{a === null || a === undefined ? "—" : m.fmt(a)}</td>
                  <td className="pl-num">{b === null || b === undefined ? "—" : m.fmt(b)}</td>
                  <td className={`pl-num ${cls}`} data-testid={`pl-compare-delta-${m.key}`}>
                    {d === null ? "—" : (m.fmtDelta ?? signed)(d)}
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}
