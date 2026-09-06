import type { PipelineResult } from "../../../api";
import { useT } from "../../../i18n";
import { CorrHeatmap, IcDecayBars, QuantileBars } from "../charts";
import { numOpt, signed1Opt, signed3, signed3Opt, tone } from "../format";

/** Stage ② after a run: factor correlation, IC decay, quantile check and
 * the per-component weight / IC table. */
export function SignalResult({ result, weightingLabel }: { result: PipelineResult; weightingLabel: (id: string) => string }) {
  const { t } = useT();
  return (
    <div className="pl-result-block">
      <div className="dim pl-hint">
        {t("pl.sig.head", {
          w: weightingLabel(result.signal.weighting),
          c: result.signal.max_pair_corr.toFixed(2),
        })}
      </div>
      {result.signal.corr_matrix && result.signal.corr_matrix.length >= 2 && (
        <>
          <div className="pl-subhead">{t("pl.sig.corr")}</div>
          <CorrHeatmap m={result.signal.corr_matrix} labels={result.signal.components.map((c) => c.expression)} />
          <p className="dim pl-hint">{t("pl.sig.corrNote")}</p>
        </>
      )}
      {result.signal.ic_by_horizon && result.signal.ic_by_horizon.length > 0 && (
        <>
          <div className="pl-subhead">
            {t("pl.sig.decay")}
            <span className="chip" data-testid="pl-comp-is">
              {t("pl.sig.compIs", { v: signed3Opt(result.signal.composite_is_ic) })}
            </span>
            <span className="chip">{t("pl.sig.compOos", { v: signed3Opt(result.signal.composite_oos_ic) })}</span>
          </div>
          <IcDecayBars rows={result.signal.ic_by_horizon} />
          <p className="dim pl-hint">{t("pl.sig.decayNote")}</p>
        </>
      )}
      {result.signal.quantiles && result.signal.quantiles.buckets.length > 0 && (
        <>
          <div className="pl-subhead">
            {t("pl.sig.quantiles")}
            <span className="chip" title={t("pl.sig.spreadTitle")} data-testid="pl-spread">
              {t("pl.sig.spread", {
                v: signed1Opt(result.signal.quantiles.spread_ann_pct),
                s: numOpt(result.signal.quantiles.spread_sharpe),
              })}
            </span>
            {result.signal.quantiles.monotonic !== null && (
              <span
                className={`pl-badge ${result.signal.quantiles.monotonic ? "pl-badge--ok" : "pl-badge--warn"}`}
                title={t("pl.sig.monoTitle")}
                data-testid="pl-monotonic"
              >
                {result.signal.quantiles.monotonic ? t("pl.sig.mono") : t("pl.sig.notMono")}
              </span>
            )}
          </div>
          <QuantileBars q={result.signal.quantiles} />
          <p className="dim pl-hint">{t("pl.sig.quantilesNote")}</p>
        </>
      )}
      <div className="table-scroll">
        <table className="lab-stats">
          <thead>
            <tr>
              <th>{t("fl.z.expr")}</th>
              <th className="pl-num">{t("pl.sig.weight")}</th>
              <th className="pl-num">{t("pl.sig.avgWeight")}</th>
              <th className="pl-num">{t("fl.m.isic")}</th>
              <th className="pl-num">{t("fl.m.oosic")}</th>
              <th className="pl-num">{t("pl.sig.standalone")}</th>
            </tr>
          </thead>
          <tbody>
            {result.signal.components.map((c) => (
              <tr key={c.expression}>
                <td>
                  <code className="pl-factor__expr">{c.expression}</code>
                  {c.invert && <span className="dim"> · {t("fl.bt.inverted")}</span>}
                  {c.active_pct !== undefined && c.active_pct < 100 && (
                    <span className="chip pl-chip--mini" title={t("pl.sig.activeTitle")} data-testid="pl-active-chip">
                      {t("pl.sig.active", { v: c.active_pct.toFixed(0) })}
                    </span>
                  )}
                </td>
                <td className="pl-num">{(c.weight * 100).toFixed(0)}%</td>
                <td className="pl-num dim">{c.avg_weight === undefined ? "—" : `${(c.avg_weight * 100).toFixed(0)}%`}</td>
                <td className={`pl-num ${tone(c.is_ic)}`}>{signed3(c.is_ic)}</td>
                <td className={`pl-num ${tone(c.oos_ic)}`}>{signed3(c.oos_ic)}</td>
                <td className="pl-num">{c.standalone_sharpe.toFixed(2)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
