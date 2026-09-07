import type { PipelineCpcv } from "../../api";
import { useT } from "../../i18n";
import { cpcvTone, numOpt } from "./format";

/** V4-pipeline stage ④: the CPCV path distribution as a one-row strip chart —
 * one dot per stitched out-of-sample path on a Sharpe axis, zero marked, the
 * full-sample Sharpe as a vertical rule — plus median / min / max / % positive
 * and the geometry footnote. Pure SVG, no library. */
export function CpcvBlock({ cpcv, fullSharpe }: { cpcv: PipelineCpcv; fullSharpe: number }) {
  const { t } = useT();
  const W = 320;
  const H = 44;
  const PAD = 14;
  const values = cpcv.path_sharpes.filter((v) => Number.isFinite(v));
  const lo = Math.min(0, fullSharpe, ...values);
  const hi = Math.max(0, fullSharpe, ...values);
  const span = Math.max(0.5, hi - lo);
  const x = (v: number) => PAD + ((v - (lo - span * 0.08)) / (span * 1.16)) * (W - 2 * PAD);
  const tone = cpcvTone(cpcv.pct_paths_positive);
  return (
    <div className="pl-cpcv" data-testid="pl-cpcv">
      <div className="pl-subhead">
        {t("pl.cpcv.title")}
        <span className={`chip ${tone}`} title={t("pl.cpcv.positiveTitle")} data-testid="pl-cpcv-positive">
          {t("pl.cpcv.positive", { v: cpcv.pct_paths_positive.toFixed(0) })}
        </span>
        <span className="chip" data-testid="pl-cpcv-median">{t("pl.cpcv.median", { v: numOpt(cpcv.median_sharpe) })}</span>
        <span className="chip">{t("pl.cpcv.min", { v: numOpt(cpcv.min_sharpe) })}</span>
        <span className="chip">{t("pl.cpcv.max", { v: numOpt(cpcv.max_sharpe) })}</span>
        {!cpcv.complete && <span className="pl-badge pl-badge--warn">{t("pl.cpcv.incomplete")}</span>}
      </div>
      <svg
        className="pl-cpcv__strip"
        viewBox={`0 0 ${W} ${H}`}
        role="img"
        aria-label={t("pl.cpcv.aria", { n: values.length, full: fullSharpe.toFixed(2) })}
        preserveAspectRatio="none"
      >
        <line className="pl-cpcv__axis" x1={PAD} x2={W - PAD} y1={H / 2} y2={H / 2} />
        <line className="pl-cpcv__zero" x1={x(0)} x2={x(0)} y1={6} y2={H - 6} />
        <text className="pl-cpcv__lbl" x={x(0)} y={H - 1} textAnchor="middle">0</text>
        <line className="pl-cpcv__full" x1={x(fullSharpe)} x2={x(fullSharpe)} y1={4} y2={H - 8} data-testid="pl-cpcv-full" />
        <text className="pl-cpcv__lbl pl-cpcv__lbl--full" x={x(fullSharpe)} y={9} textAnchor="middle">
          {fullSharpe.toFixed(2)}
        </text>
        {values.map((v, i) => (
          <circle
            key={i}
            className={`pl-cpcv__dot ${v >= 0 ? "pl-cpcv__dot--up" : "pl-cpcv__dot--dn"}`}
            cx={x(v)}
            cy={H / 2 + ((i % 3) - 1) * 4}
            r={4}
            data-path={i}
          >
            <title>{t("pl.cpcv.dot", { i: i + 1, v: v.toFixed(2), d: cpcv.path_days[i] ?? "—" })}</title>
          </circle>
        ))}
      </svg>
      <p className="dim pl-hint" data-testid="pl-cpcv-foot">
        {t("pl.cpcv.foot", {
          groups: cpcv.groups, k: cpcv.k, splits: cpcv.splits, paths: cpcv.paths, purge: cpcv.purge_days, embargo: cpcv.embargo_days,
        })}
      </p>
      <p className="dim pl-hint">{t("pl.cpcv.note")}</p>
    </div>
  );
}
