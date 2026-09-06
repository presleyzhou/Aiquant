import type { PipelineResult } from "../../../api";
import { useT } from "../../../i18n";
import { AttributionBlock, CapacityBlock, ContribList, RegimeTable } from "../blocks";
import { Sparkline } from "../charts";
import { captureTone, numOpt, pct, ratio } from "../format";

/** Stage ⑤ after a run: risk chips, exposure / rolling-beta sparklines,
 * drawdown table, contributors, regimes, attribution and capacity. */
export function RiskResults({
  result, bt, sectorLabel,
}: { result: PipelineResult; bt: PipelineResult["backtest"]; sectorLabel: (id: string) => string }) {
  const { t } = useT();
  return (
    <>
      <div className="chip-row pl-chip-row">
        <span className="chip" title={t("pl.risk.effNTitle")}>
          {t("pl.pf.effN", { n: result.risk.concentration.avg_effective_n.toFixed(1) })}
        </span>
        <span className="chip" title={t("pl.risk.capTitle")}>
          {t("pl.risk.cap", { v: result.risk.concentration.cap_binding_pct.toFixed(0) })}
        </span>
        <span className="chip">β {bt.stats.beta.toFixed(2)}</span>
        <span className="chip">{t("pl.risk.te")} {bt.stats.tracking_error_pct.toFixed(1)}%</span>
        <span className="chip">IR {bt.stats.information_ratio.toFixed(2)}</span>
        <span className="chip">{t("pl.risk.corr")} {result.risk.correlation_to_benchmark.toFixed(2)}</span>
      </div>

      {(result.risk.capture || result.risk.cvar_95_pct !== undefined) && (
        <div className="chip-row pl-chip-row" data-testid="pl-capture">
          {result.risk.capture && (
            <>
              <span className={`chip ${captureTone(result.risk.capture.up, true)}`} title={t("pl.risk.captureTitle")}>
                ↗ {t("pl.risk.captureUp", { v: ratio(result.risk.capture.up), n: String(result.risk.capture.up_periods) })}
              </span>
              <span className={`chip ${captureTone(result.risk.capture.down, false)}`} title={t("pl.risk.captureTitle")}>
                ↘ {t("pl.risk.captureDown", { v: ratio(result.risk.capture.down), n: String(result.risk.capture.down_periods) })}
              </span>
            </>
          )}
          {result.risk.cvar_95_pct !== undefined && (
            <span className="chip" title={t("pl.risk.cvarTitle")}>
              {t("pl.risk.cvar", { v: numOpt(result.risk.cvar_95_pct) })}
              {result.risk.bench_cvar_95_pct !== undefined && (
                <span className="dim"> · {t("pl.risk.cvarBench", { v: numOpt(result.risk.bench_cvar_95_pct) })}</span>
              )}
            </span>
          )}
        </div>
      )}

      <div className="pl-subhead">
        {t("pl.risk.exposure")}
        <span className="dim pl-subhead__note">
          {t("pl.pf.exposure", { v: result.portfolio.avg_exposure_pct.toFixed(0) })}
        </span>
      </div>
      <Sparkline data={bt.exposure_curve} refValue={100} floor={0} />

      {result.risk.rolling_beta && result.risk.rolling_beta.length >= 2 && (
        <>
          <div className="pl-subhead pl-subhead--case">
            {t("pl.risk.rollingBeta")}
            <span className="dim pl-subhead__note">
              {t("pl.risk.rollingBetaNote", {
                v: result.risk.rolling_beta[result.risk.rolling_beta.length - 1].value.toFixed(2),
                lo: Math.min(...result.risk.rolling_beta.map((p) => p.value)).toFixed(2),
                hi: Math.max(...result.risk.rolling_beta.map((p) => p.value)).toFixed(2),
              })}
            </span>
          </div>
          <Sparkline data={result.risk.rolling_beta} refValue={1} className="pl-spark--beta" testId="pl-rolling-beta" />
        </>
      )}

      <div className="pl-subhead">{t("pl.risk.drawdowns")}</div>
      <div className="table-scroll">
        <table className="lab-stats">
          <thead>
            <tr>
              <th>{t("pl.risk.peak")}</th>
              <th>{t("pl.risk.trough")}</th>
              <th>{t("pl.risk.recovery")}</th>
              <th className="pl-num">{t("pl.risk.depth")}</th>
              <th className="pl-num">{t("pl.risk.days")}</th>
            </tr>
          </thead>
          <tbody>
            {result.risk.drawdowns.map((d) => (
              <tr key={`${d.peak}-${d.trough}`}>
                <td>{d.peak}</td>
                <td>{d.trough}</td>
                <td className={d.recovery ? "" : "dn"}>{d.recovery ?? t("pl.risk.underwater")}</td>
                <td className="pl-num dn">{pct(d.depth_pct)}</td>
                <td className="pl-num">{d.days}</td>
              </tr>
            ))}
            {result.risk.drawdowns.length === 0 && (
              <tr>
                <td colSpan={5} className="dim">—</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="pl-two">
        <ContribList title={t("pl.risk.contributors")} rows={result.risk.contributors} positive />
        <ContribList title={t("pl.risk.detractors")} rows={result.risk.detractors} />
      </div>
      <p className="dim pl-hint">{t("pl.risk.note")}</p>

      {result.risk.regimes && (
        <>
          <div className="pl-subhead">{t("pl.risk.regimes")}</div>
          {result.risk.regimes.length === 0 ? (
            <p className="dim pl-hint">{t("pl.risk.tooShort")}</p>
          ) : (
            <RegimeTable rows={result.risk.regimes} />
          )}
          <p className="dim pl-hint">{t("pl.risk.regimesNote")}</p>
        </>
      )}

      {result.risk.attribution && (
        <>
          <div className="pl-subhead">{t("pl.risk.attr")}</div>
          <AttributionBlock a={result.risk.attribution} sectorLabel={sectorLabel} />
          <p className="dim pl-hint">{t("pl.risk.attrNote")}</p>
        </>
      )}

      {result.capacity && (
        <>
          <div className="pl-subhead">{t("pl.cap.title")}</div>
          <CapacityBlock c={result.capacity} />
        </>
      )}
    </>
  );
}
