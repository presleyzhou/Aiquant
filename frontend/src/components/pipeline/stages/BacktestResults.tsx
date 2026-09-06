import type { PipelineAlternative, PipelineResult } from "../../../api";
import { useT } from "../../../i18n";
import { EquityChart } from "../../EquityChart";
import { SplitRow, Stat } from "../blocks";
import { Heatmap, SensitivityGrid } from "../charts";
import { WARNING_KEYS } from "../constants";
import type { AltKey, FormState } from "../form";
import {
  hitTone, mintrlTone, num, numOpt, pOpt, pTone, pct, pctOpt, prob, probTone, signed2Opt, spikeTone, tone, tstatTone,
} from "../format";

/** Stage ④ after a run: warnings, headline stats, overfitting block, equity
 * chart, in-sample / holdout split, yearly + monthly tables, the scheme
 * comparison and the parameter-sensitivity grid. Sort state lives in the page. */
export function BacktestResults({
  result, bt, holdoutWarn, altSort, toggleAltSort, sortedAlts, schemeName, patch,
}: {
  result: PipelineResult | null;
  bt: PipelineResult["backtest"];
  holdoutWarn: boolean;
  altSort: { key: AltKey; dir: 1 | -1 };
  toggleAltSort: (key: AltKey) => void;
  sortedAlts: PipelineAlternative[];
  schemeName: (id: string) => string;
  patch: (p: Partial<FormState>) => void;
}) {
  const { t } = useT();
  return (
    <>
      {result && result.warnings.length > 0 && (
        <ul className="pl-warnings">
          {result.warnings.map((w) => (
            <li key={w} className="pl-warning">
              ⚠ {WARNING_KEYS[w] ? t(WARNING_KEYS[w]) : t("pl.warn.generic", { code: w })}
            </li>
          ))}
        </ul>
      )}

      <div className="stat-grid pl-stats">
        <Stat
          label={t("bt.totalReturn")}
          value={pct(bt.stats.total_return_pct)}
          tone={bt.stats.total_return_pct}
          sub={t("pl.bt.benchSub", { v: pct(bt.stats.benchmark.total_return_pct) })}
        />
        <Stat
          label={t("pl.bt.excess")}
          value={pct(bt.stats.excess_pct)}
          tone={bt.stats.excess_pct}
        />
        <Stat
          label={t("bt.cagr")}
          value={pctOpt(bt.stats.cagr_pct)}
          tone={bt.stats.cagr_pct ?? 0}
          sub={t("pl.bt.benchSub", { v: pctOpt(bt.stats.benchmark.cagr_pct) })}
        />
        <Stat
          label={t("bt.sharpe")}
          value={bt.stats.sharpe.toFixed(2)}
          tone={bt.stats.sharpe - bt.stats.benchmark.sharpe}
          sub={t("pl.bt.benchSub", { v: bt.stats.benchmark.sharpe.toFixed(2) })}
          testId="pl-sharpe"
        />
        <Stat label={t("bt.sortino")} value={bt.stats.sortino.toFixed(2)} />
        <Stat label={t("pl.bt.calmar")} value={bt.stats.calmar.toFixed(2)} />
        <Stat
          label={t("bt.maxdd")}
          value={pct(bt.stats.max_drawdown_pct)}
          tone={-1}
          sub={t("pl.bt.benchSub", { v: pct(bt.stats.benchmark.max_drawdown_pct) })}
        />
        <Stat
          label={t("pl.bt.vol")}
          value={`${bt.stats.ann_vol_pct.toFixed(1)}%`}
          sub={t("pl.bt.benchSub", { v: `${bt.stats.benchmark.ann_vol_pct.toFixed(1)}%` })}
        />
        <Stat label={t("bt.winrate")} value={`${bt.stats.win_rate_pct.toFixed(1)}%`} />
        {bt.stats.rolling_6m_beat_pct !== undefined && (
          <Stat
            label={t("pl.bt.rolling")}
            value={bt.stats.rolling_6m_beat_pct === null ? "—" : `${bt.stats.rolling_6m_beat_pct.toFixed(1)}%`}
            toneClass={hitTone(bt.stats.rolling_6m_beat_pct)}
            sub={t("pl.bt.rollingSub")}
            title={t("pl.bt.rollingTitle")}
            testId="pl-rolling-hit"
          />
        )}
      </div>

      {bt.overfitting && (
        <div className="pl-ofit" data-testid="pl-ofit">
          <div className="pl-subhead">{t("pl.bt.ofit")}</div>
          <div className="stat-grid pl-stats">
            <Stat
              label={t("pl.bt.ofit.psr")}
              value={prob(bt.overfitting.psr)}
              toneClass={probTone(bt.overfitting.psr)}
              testId="pl-psr"
            />
            <Stat
              label={t("pl.bt.ofit.dsr")}
              value={prob(bt.overfitting.dsr)}
              toneClass={probTone(bt.overfitting.dsr)}
            />
            <Stat label={t("pl.bt.ofit.trials")} value={String(bt.overfitting.trials)} />
            <Stat
              label={t("pl.bt.ofit.expMax")}
              value={bt.overfitting.expected_max_sharpe_ann === null ? "—" : bt.overfitting.expected_max_sharpe_ann.toFixed(2)}
              sub={t("pl.bt.ofit.expMaxTitle")}
            />
            <Stat
              label={t("pl.bt.ofit.holdoutPsr")}
              value={prob(bt.holdout.psr)}
              toneClass={probTone(bt.holdout.psr)}
            />
            {bt.overfitting.t_stat !== undefined && (
              <Stat
                label={t("pl.bt.ofit.tstat")}
                value={numOpt(bt.overfitting.t_stat)}
                toneClass={tstatTone(bt.overfitting.t_stat)}
                sub={t("pl.bt.ofit.tstatSub", { h: (bt.overfitting.hlz_hurdle ?? 3).toFixed(1) })}
                title={t("pl.bt.ofit.tstatTitle")}
                testId="pl-tstat"
              />
            )}
            {bt.overfitting.min_track_record_days !== undefined && (
              <Stat
                label={t("pl.bt.ofit.mintrl")}
                value={
                  bt.overfitting.min_track_record_days === null
                    ? t("pl.bt.ofit.mintrlNone")
                    : t("pl.bt.ofit.mintrlVal", {
                        need: String(bt.overfitting.min_track_record_days),
                        have: String(bt.overfitting.track_days ?? "—"),
                      })
                }
                toneClass={mintrlTone(bt.overfitting.min_track_record_days, bt.overfitting.track_days)}
                title={t("pl.bt.ofit.mintrlTitle")}
                small
                testId="pl-mintrl"
              />
            )}
          </div>
          <p className="dim pl-hint">{t("pl.bt.ofit.note")}</p>
        </div>
      )}

      <EquityChart equity={bt.equity_curve} benchmark={bt.benchmark_curve} drawdown={bt.drawdown_curve} />

      <div className="pl-two">
        <div>
          <div className="pl-subhead">
            {t("pl.bt.split")}
            {holdoutWarn && <span className="pl-badge pl-badge--warn">⚠ {t("pl.bt.holdoutWarn")}</span>}
          </div>
          <table className={`lab-stats pl-split${holdoutWarn ? " pl-split--warn" : ""}`}>
            <thead>
              <tr>
                <th>{t("pp.cmp.metric")}</th>
                <th className="pl-num">
                  {t("lab.tbl.insample")}
                  <small className="pl-th-sub">{bt.in_sample.from} → {bt.in_sample.to}</small>
                </th>
                <th className="pl-num">
                  {t("pl.bt.holdout")}
                  <small className="pl-th-sub">{bt.holdout.from} → {bt.holdout.to}</small>
                </th>
              </tr>
            </thead>
            <tbody>
              <SplitRow label={t("bt.totalReturn")} a={bt.in_sample.total_return_pct} b={bt.holdout.total_return_pct} fmt={pct} />
              <SplitRow label={t("bt.sharpe")} a={bt.in_sample.sharpe} b={bt.holdout.sharpe} fmt={num} warn={bt.holdout.sharpe < bt.in_sample.sharpe - 0.5} />
              <SplitRow label={t("bt.maxdd")} a={bt.in_sample.max_drawdown_pct} b={bt.holdout.max_drawdown_pct} fmt={pct} invert />
              <SplitRow label={t("pl.bt.excess")} a={bt.in_sample.excess_pct} b={bt.holdout.excess_pct} fmt={pct} warn={bt.holdout.excess_pct < 0} />
            </tbody>
          </table>
          <p className="dim pl-hint">{t("pl.bt.splitNote")}</p>
        </div>
        <div>
          <div className="pl-subhead">{t("pl.bt.yearly")}</div>
          <table className="lab-stats">
            <thead>
              <tr>
                <th>{t("pl.bt.year")}</th>
                <th className="pl-num">{t("pl.bt.strategy")}</th>
                <th className="pl-num">{t("fl.bt.bench")}</th>
                <th className="pl-num">{t("pl.bt.excess")}</th>
              </tr>
            </thead>
            <tbody>
              {bt.yearly_returns.map((y) => (
                <tr key={y.year}>
                  <td>{y.year}</td>
                  <td className={`pl-num ${tone(y.ret_pct)}`}>{pct(y.ret_pct)}</td>
                  <td className="pl-num dim">{pct(y.bench_pct)}</td>
                  <td className={`pl-num ${tone(y.ret_pct - y.bench_pct)}`}>{pct(y.ret_pct - y.bench_pct)}</td>
                </tr>
              ))}
              {bt.yearly_returns.length === 0 && (
                <tr>
                  <td colSpan={4} className="dim">—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      </div>

      <div className="pl-subhead">{t("pl.bt.monthly")}</div>
      <Heatmap rows={bt.monthly_returns} benchLabel={t("fl.bt.bench")} />

      {result && result.alternatives.length > 0 && (
        <>
          <div className="pl-subhead">
            {t("pl.bt.alts")}
            <span className="dim pl-subhead__note">{t("pl.bt.altsNote")}</span>
          </div>
          <div className="table-scroll pl-alts">
            <table className="lab-stats">
              <thead>
                <tr>
                  <th>{t("pl.pf.scheme")}</th>
                  {(
                    [
                      ["total_return_pct", t("bt.totalReturn")],
                      ["sharpe", t("bt.sharpe")],
                      ["delta_sharpe_vs_equal_ann", t("pl.bt.deltaEq")],
                      ["p_value_vs_equal", t("pl.bt.pEq")],
                      ["psr", t("pl.bt.psr")],
                      ["max_drawdown_pct", t("bt.maxdd")],
                      ["ann_vol_pct", t("pl.bt.vol")],
                      ["avg_turnover_pct", t("pl.bt.turnover")],
                    ] as Array<[AltKey, string]>
                  ).map(([key, label]) => (
                    <th key={key} className="pl-num">
                      <button
                        className={`pl-sort${altSort.key === key ? " is-on" : ""}`}
                        onClick={() => toggleAltSort(key)}
                        title={t("pl.bt.sortBy", { c: label })}
                      >
                        {label} {altSort.key === key ? (altSort.dir === -1 ? "↓" : "↑") : ""}
                      </button>
                    </th>
                  ))}
                  <th />
                </tr>
              </thead>
              <tbody>
                {sortedAlts.map((a) => {
                  const current = a.scheme === result.portfolio.scheme;
                  return (
                    <tr key={a.scheme} className={current ? "pl-alt--current" : ""}>
                      <td>
                        {schemeName(a.scheme)}
                        {current && <span className="dim"> · {t("pl.bt.current")}</span>}
                      </td>
                      <td className={`pl-num ${tone(a.total_return_pct)}`}>{pct(a.total_return_pct)}</td>
                      <td className="pl-num">{a.sharpe.toFixed(2)}</td>
                      <td className={`pl-num ${tone(a.delta_sharpe_vs_equal_ann ?? 0)}`}>
                        {signed2Opt(a.delta_sharpe_vs_equal_ann)}
                      </td>
                      <td className={`pl-num ${pTone(a.p_value_vs_equal, a.delta_sharpe_vs_equal_ann)}`} title={t("pl.bt.pEqTitle")}>
                        {pOpt(a.p_value_vs_equal)}
                      </td>
                      <td className={`pl-num ${probTone(a.psr)}`}>{prob(a.psr)}</td>
                      <td className="pl-num dn">{pct(a.max_drawdown_pct)}</td>
                      <td className="pl-num">{a.ann_vol_pct.toFixed(1)}%</td>
                      <td className="pl-num">{a.avg_turnover_pct.toFixed(1)}%</td>
                      <td className="pl-num">
                        {!current && (
                          <button className="btn btn--mini" onClick={() => patch({ scheme: a.scheme })}>
                            {t("pl.bt.useScheme")}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          <p className="dim pl-hint" data-testid="pl-alts-note">{t("pl.bt.altsEqNote")}</p>
        </>
      )}

      {result?.sensitivity && (
        <>
          <div className="pl-subhead">
            {t("pl.bt.sens")}
            <span className="chip">{t("pl.bt.sens.median", { v: numOpt(result.sensitivity.median_sharpe) })}</span>
            <span className="chip">{t("pl.bt.sens.min", { v: numOpt(result.sensitivity.min_sharpe) })}</span>
            <span
              className={`chip ${spikeTone(result.sensitivity.spike)}`}
              title={t("pl.bt.sens.spikeTitle")}
              data-testid="pl-spike"
            >
              {t("pl.bt.sens.spike", { v: signed2Opt(result.sensitivity.spike) })}
            </span>
          </div>
          <SensitivityGrid
            s={result.sensitivity}
            chosenTopN={result.portfolio.top_n}
            chosenRebalance={result.portfolio.rebalance}
          />
          <p className="dim pl-hint">{t("pl.bt.sens.note")}</p>
        </>
      )}
    </>
  );
}
