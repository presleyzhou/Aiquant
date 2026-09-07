import type { PipelineResult } from "../../api";
import { useT } from "../../i18n";
import { fmtAum, prob, probTone } from "./format";

/** V4-pipeline summary-first card: the four numbers that decide a run —
 * full-sample Sharpe, holdout Sharpe, DSR and breakeven capacity. Sticky
 * on narrow screens (where stages ④–⑥ hide behind it), a plain compact row
 * on desktop. */
export function VerdictCard({
  result, mobile, expanded, onToggle,
}: { result: PipelineResult; mobile: boolean; expanded: boolean; onToggle: () => void }) {
  const { t } = useT();
  const bt = result.backtest;
  const dsr = bt.overfitting?.dsr;
  const cap = result.capacity?.breakeven_aum;
  const capTone = cap === undefined ? "" : cap === null || cap < 1e7 ? "pl-tone--bad" : cap < 1e8 ? "pl-tone--warn" : "pl-tone--ok";
  return (
    <section className={`pl-verdict-card${mobile ? " pl-verdict-card--sticky" : ""}`} data-testid="pl-verdict-card" aria-label={t("pl.vc.title")}>
      <span className="pl-verdict-card__title">{t("pl.vc.title")}</span>
      <div className="pl-verdict-card__nums">
        <div className="pl-verdict-card__num" data-testid="pl-vc-sharpe">
          <span className="pl-verdict-card__label">{t("bt.sharpe")}</span>
          <b className={bt.stats.sharpe > bt.stats.benchmark.sharpe ? "up" : "dn"}>{bt.stats.sharpe.toFixed(2)}</b>
        </div>
        <div className="pl-verdict-card__num" data-testid="pl-vc-holdout">
          <span className="pl-verdict-card__label">{t("pl.vc.holdout")}</span>
          <b className={bt.holdout.sharpe < bt.in_sample.sharpe - 0.5 ? "dn" : ""}>{bt.holdout.sharpe.toFixed(2)}</b>
        </div>
        <div className="pl-verdict-card__num" data-testid="pl-vc-dsr">
          <span className="pl-verdict-card__label">{t("pl.vc.dsr")}</span>
          <b className={probTone(dsr)}>{prob(dsr)}</b>
        </div>
        <div className="pl-verdict-card__num" data-testid="pl-vc-capacity">
          <span className="pl-verdict-card__label">{t("pl.vc.capacity")}</span>
          <b className={capTone}>{cap === undefined ? "—" : cap === null ? t("pl.cap.none") : fmtAum(cap)}</b>
        </div>
      </div>
      {mobile && (
        <button className="btn btn--mini pl-verdict-card__toggle" onClick={onToggle} aria-expanded={expanded} data-testid="pl-vc-expand">
          {expanded ? t("pl.vc.collapse") : t("pl.vc.expand")}
        </button>
      )}
    </section>
  );
}
