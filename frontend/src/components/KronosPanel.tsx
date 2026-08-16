import {
  ColorType,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef, useState } from "react";
import { api, type KronosForecast, type KronosStatus } from "../api";
import { useT } from "../i18n";

const HORIZONS = [7, 14, 30, 60];

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
  const [result, setResult] = useState<KronosForecast | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getStatus().then(setStatus).catch(() => setStatus(null));
  }, []);

  const run = async () => {
    if (running) return;
    setRunning(true);
    setError(null);
    try {
      setResult(await api.kronosForecast(symbol, horizon));
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const s = result?.summary;
  const stale = result !== null && result.symbol !== symbol;

  return (
    <div className="panel">
      <div className="panel__head">
        <span className="panel__title">{t("kr.title")}</span>
        <span className="panel__meta">
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
            <label className="field">
              <span className="field__label">{t("kr.horizon")}</span>
              <select
                className="select"
                value={horizon}
                onChange={(e) => setHorizon(Number(e.target.value))}
              >
                {HORIZONS.map((h) => (
                  <option key={h} value={h}>
                    {marketId === "crypto" ? t("kr.days", { n: String(h) }) : t("kr.bdays", { n: String(h) })}
                  </option>
                ))}
              </select>
            </label>
            <label className="field">
              <span className="field__label">&nbsp;</span>
              <button className="btn btn--primary" onClick={run} disabled={running}>
                {running ? t("kr.running") : t("kr.run")}
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
        </>
      )}
    </div>
  );
}

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
        textColor: "#7e8799",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 10,
      },
      grid: {
        vertLines: { color: "rgba(35,41,54,0.6)" },
        horzLines: { color: "rgba(35,41,54,0.6)" },
      },
      rightPriceScale: { borderColor: "#232936" },
      timeScale: { borderColor: "#232936", timeVisible: false },
      crosshair: {
        vertLine: { color: "#333d4f", labelBackgroundColor: "#8f7bd8" },
        horzLine: { color: "#333d4f", labelBackgroundColor: "#8f7bd8" },
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
