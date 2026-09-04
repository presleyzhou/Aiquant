import {
  ColorType,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { api, type KronosEvaluation, type KronosForecast, type KronosStatus } from "../api";
import { useT } from "../i18n";
import { buildKronosShare, takeKronosShare } from "../share";
import { ShareButton } from "./ShareButton";

const HORIZONS = [7, 14, 30, 60];
const HOURLY_HORIZONS = [24, 48, 60];

/** Module-level cache: every workspace shares one status probe. */
let statusPromise: Promise<KronosStatus> | null = null;
const getStatus = () => (statusPromise ??= api.kronosStatus());

interface Props {
  symbol: string;
  /** "us" | "crypto" — shown in the preset chip; the backend re-infers it. */
  marketId: string;
}

/** Kronos K-line forecast: history + forecast path + per-bar envelope.
 * The forecast is a sampled model output, not a promise — the disclaimer
 * stays visible next to the result, in both languages. */
export function KronosPanel({ symbol, marketId }: Props) {
  const { t } = useT();
  const [status, setStatus] = useState<KronosStatus | null>(null);
  const [horizon, setHorizon] = useState(30);
  const [interval, setIntervalTf] = useState<"1d" | "1h">("1d");
  const [result, setResult] = useState<KronosForecast | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [evaluation, setEvaluation] = useState<KronosEvaluation | null>(null);
  const [evaluating, setEvaluating] = useState(false);
  const [evalError, setEvalError] = useState<string | null>(null);

  useEffect(() => {
    getStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  // Shared-link replay: when the URL carried ?s=kr for this symbol, adopt its
  // horizon and run immediately (once the status probe confirms availability).
  useEffect(() => {
    const share = takeKronosShare(symbol);
    if (!share) return;
    setHorizon(share.horizon);
    const timer = window.setTimeout(() => void runWith(share.horizon), 400);
    return () => window.clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol]);

  const [waking, setWaking] = useState(false);

  const run = () => runWith(horizon);

  const runWith = async (h: number) => {
    if (running) return;
    setRunning(true);
    setError(null);
    // A response this slow almost always means the free inference Space is
    // waking from sleep — tell the user instead of looking frozen.
    const wakeTimer = window.setTimeout(() => setWaking(true), 8000);
    try {
      setResult(await api.kronosForecast(symbol, h, interval));
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      window.clearTimeout(wakeTimer);
      setWaking(false);
      setRunning(false);
    }
  };

  const evaluate = async () => {
    if (evaluating) return;
    setEvaluating(true);
    setEvalError(null);
    try {
      setEvaluation(await api.kronosEvaluate(symbol, horizon <= 30 ? 14 : 30));
    } catch (err) {
      setEvalError((err as Error).message);
      setEvaluation(null);
    } finally {
      setEvaluating(false);
    }
  };

  const s = result?.summary;
  const stale = result !== null && result.symbol !== symbol;
  const evalStale = evaluation !== null && evaluation.symbol !== symbol;

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">{t("kr.title")}</span>
        <span className="panel__meta">
          {result && !stale && (
            <ShareButton url={() => buildKronosShare(marketId, result.symbol, result.horizon)} />
          )}
          {status?.enabled ? (result ? `${result.model} · ${result.device}` : "Kronos-small") : t("kr.off")}
        </span>
      </div>

      {!status?.enabled ? (
        <div className="panel__body">
          <div className="notice">{t("kr.notice")}</div>
        </div>
      ) : (
        <>
          <div className="control-grid">
            {marketId === "crypto" && (
              <label className="field">
                <span className="field__label">{t("kr.tf")}</span>
                <select
                  className="select"
                  value={interval}
                  onChange={(e) => {
                    const next = e.target.value as "1d" | "1h";
                    setIntervalTf(next);
                    setHorizon(next === "1h" ? 24 : 30);
                  }}
                >
                  <option value="1d">{t("kr.tf.daily")}</option>
                  <option value="1h">{t("kr.tf.hourly")}</option>
                </select>
              </label>
            )}
            <label className="field">
              <span className="field__label">{t("kr.horizon")}</span>
              <select
                className="select"
                value={horizon}
                onChange={(e) => setHorizon(Number(e.target.value))}
              >
                {(interval === "1h" ? HOURLY_HORIZONS : HORIZONS).map((h) => (
                  <option key={h} value={h}>
                    {interval === "1h"
                      ? t("kr.hours", { n: String(h) })
                      : marketId === "crypto"
                        ? t("kr.days", { n: String(h) })
                        : t("kr.bdays", { n: String(h) })}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">&nbsp;</span>
              <button className="btn btn--primary" onClick={run} disabled={running}>
                {running ? (waking ? t("kr.waking") : t("kr.running")) : t("kr.run")}
              </button>
            </label>
          </div>

          {error && <div className="err">{error}</div>}

          {!result && !error && <div className="empty">{t("kr.hint")}</div>}

          {result && s && (
            <>
              {stale && <div className="notice">{t("kr.stale", { sym: result.symbol })}</div>}
              <ForecastChart data={result} />

              <div className="stat-grid">
                <Stat
                  label={t("kr.predClose", { n: String(result.horizon) })}
                  value={fmtPrice(s.pred_close)}
                  tone={s.change_pct ?? 0}
                />
                <Stat
                  label={t("kr.change")}
                  value={s.change_pct === null ? "—" : `${s.change_pct > 0 ? "+" : ""}${s.change_pct.toFixed(2)}%`}
                  tone={s.change_pct ?? 0}
                />
                <Stat label={t("kr.range")} value={`${fmtPrice(s.pred_min)} – ${fmtPrice(s.pred_max)}`} />
                <Stat label={t("kr.upDays")} value={`${s.up_days}/${result.horizon}`} />
              </div>

              <div className="kr-preset dim">
                {t(result.market === "crypto" ? "kr.preset.crypto" : "kr.preset.us")} · T=
                {result.preset.temperature} · top_p={result.preset.top_p} ·{" "}
                {t("kr.samples", { n: String(result.preset.sample_count) })} ·{" "}
                {t("kr.context", { n: String(result.preset.context_bars) })}
              </div>
              <div className="kr-disclaimer dim">{t("kr.disclaimer")}</div>
            </>
          )}

          {/* ------------------------------------------ honest evaluation */}
          <div className="kr-eval">
            <div className="kr-eval__head">
              <span className="mk-section__title" style={{ margin: 0 }}>{t("kr.eval.title")}</span>
              <button className="btn" onClick={evaluate} disabled={evaluating}>
                {evaluating ? t("kr.eval.running") : t("kr.eval.run")}
              </button>
            </div>

            {evalError && <div className="err">{evalError}</div>}
            {!evaluation && !evalError && !evaluating && (
              <div className="kr-eval__hint dim">{t("kr.eval.hint")}</div>
            )}

            {evaluation && (
              <>
                {evalStale && (
                  <div className="notice">{t("kr.stale", { sym: evaluation.symbol })}</div>
                )}
                <div className="stat-grid">
                  <Stat
                    label={t("kr.eval.hit")}
                    value={`${evaluation.hit_rate_pct.toFixed(1)}%`}
                    tone={evaluation.hit_rate_pct - evaluation.always_up_hit_rate_pct}
                  />
                  <Stat
                    label={t("kr.eval.base")}
                    value={`${evaluation.always_up_hit_rate_pct.toFixed(1)}%`}
                  />
                  <Stat label={t("kr.eval.mae")} value={`${evaluation.mae_pct_points.toFixed(1)} pp`} />
                  <Stat
                    label={t("kr.eval.n")}
                    value={`${evaluation.n} × ${evaluation.horizon}d`}
                  />
                </div>
                <div className="kr-eval__verdict">
                  {evaluation.hit_rate_pct > evaluation.always_up_hit_rate_pct ? (
                    <span className="up">
                      {t("kr.eval.beats", {
                        d: (evaluation.hit_rate_pct - evaluation.always_up_hit_rate_pct).toFixed(1),
                      })}
                    </span>
                  ) : (
                    <span className="dn">{t("kr.eval.trails")}</span>
                  )}
                  <span className="dim">
                    {" "}
                    · {evaluation.span.from} → {evaluation.span.to}
                  </span>
                </div>
                <div className="table-scroll kr-eval__table">
                  <table>
                    <thead>
                      <tr>
                        <th>{t("kr.eval.date")}</th>
                        <th style={{ textAlign: "right" }}>{t("kr.eval.pred")}</th>
                        <th style={{ textAlign: "right" }}>{t("kr.eval.actual")}</th>
                        <th style={{ textAlign: "center" }}>{t("kr.eval.ok")}</th>
                      </tr>
                    </thead>
                    <tbody>
                      {[...evaluation.rows].reverse().slice(0, 12).map((row) => (
                        <tr key={row.date}>
                          <td className="dim">{row.date}</td>
                          <td style={{ textAlign: "right" }} className={row.pred_change_pct >= 0 ? "up" : "dn"}>
                            {fmtSigned(row.pred_change_pct)}
                          </td>
                          <td style={{ textAlign: "right" }} className={row.actual_change_pct >= 0 ? "up" : "dn"}>
                            {fmtSigned(row.actual_change_pct)}
                          </td>
                          <td style={{ textAlign: "center" }}>{row.hit ? "✓" : "✗"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                <div className="kr-disclaimer dim">{t("kr.eval.note")}</div>
              </>
            )}
          </div>
        </>
      )}
    </div>
  );
}

const fmtSigned = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}%`;

/** History close (solid) + forecast close (amber) + envelope edges (dashed). */
function ForecastChart({ data }: { data: KronosForecast }) {
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;
    const chart = createChart(hostRef.current, {
      height: 200,
      layout: {
        background: { type: ColorType.Solid, color: "transparent" },
        textColor: "#8a97b2",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(59,224,255,0.06)" },
        horzLines: { color: "rgba(59,224,255,0.06)" },
      },
      rightPriceScale: { borderColor: "#1e2a44" },
      timeScale: { borderColor: "#1e2a44", timeVisible: false },
      crosshair: {
        vertLine: { color: "#2a3a5c", labelBackgroundColor: "#a78bfa" },
        horzLine: { color: "#2a3a5c", labelBackgroundColor: "#a78bfa" },
      },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;

    const observer = new ResizeObserver(([entry]) => {
      const { width } = entry.contentRect;
      if (width > 0) {
        chart.resize(width, 200);
        chart.timeScale().fitContent();
      }
    });
    observer.observe(hostRef.current);
    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
    };
  }, []);

  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    const doomed: unknown[] = [];
    const t = (n: number) => n as UTCTimestamp;

    const history = chart.addLineSeries({
      color: "#5a6478",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: false,
    });
    history.setData(data.history.map((p) => ({ time: t(p.time), value: p.close })));
    doomed.push(history);

    // Bridge the visual gap: prepend the last real close to each forecast series.
    const lastReal = data.history[data.history.length - 1];
    const bridge = lastReal ? [{ time: t(lastReal.time), value: lastReal.close }] : [];

    const bandUpper = chart.addLineSeries({
      color: "rgba(143,123,216,0.55)",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    bandUpper.setData([...bridge, ...data.forecast.map((p) => ({ time: t(p.time), value: p.high }))]);
    doomed.push(bandUpper);

    const bandLower = chart.addLineSeries({
      color: "rgba(143,123,216,0.55)",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    bandLower.setData([...bridge, ...data.forecast.map((p) => ({ time: t(p.time), value: p.low }))]);
    doomed.push(bandLower);

    const forecast = chart.addLineSeries({
      color: "#8f7bd8",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    forecast.setData([...bridge, ...data.forecast.map((p) => ({ time: t(p.time), value: p.close }))]);
    doomed.push(forecast);

    chart.timeScale().fitContent();
    return () => {
      for (const series of doomed) {
        try {
          chart.removeSeries(series as Parameters<IChartApi["removeSeries"]>[0]);
        } catch {
          /* chart disposed */
        }
      }
    };
  }, [data]);

  return <div className="kr-chart" ref={hostRef} />;
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

const fmtPrice = (v: number) =>
  v >= 1000 ? v.toLocaleString(undefined, { maximumFractionDigits: 0 }) : v.toFixed(2);
