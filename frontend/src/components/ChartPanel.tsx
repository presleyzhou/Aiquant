import {
  ColorType,
  createChart,
  type IChartApi,
  type ISeriesApi,
  type LineData,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useMemo, useRef, useState } from "react";
import { useT } from "../i18n";
import { api, type Candle, type Point } from "../api";

/** Timeframes: each carries its own bar size and sensible history windows.
 * Hourly is capped at 3mo (Yahoo limit ~730d for 1h; short windows keep the
 * chart readable) and weekly starts at 1y. */
const TIMEFRAMES = {
  "1h": { interval: "1h", periods: ["5d", "1mo", "3mo"], default: "1mo" },
  "1d": { interval: "1d", periods: ["1mo", "3mo", "6mo", "1y", "2y", "5y"], default: "6mo" },
  "1wk": { interval: "1wk", periods: ["1y", "2y", "5y", "max"], default: "2y" },
} as const;

type Timeframe = keyof typeof TIMEFRAMES;

/** Overlays draw on the price scale; the rest would flatten it, so they're excluded. */
const OVERLAYS = [
  { key: "sma", label: "SMA 20", period: 20, color: "#3ec8e0" },
  { key: "ema", label: "EMA 50", period: 50, color: "#a78bfa" },
  { key: "bollinger", label: "BOLL", period: 20, color: "#ffb000" },
] as const;

type OverlayKey = (typeof OVERLAYS)[number]["key"];

export interface CandlePalette {
  up: string;
  down: string;
  upVol: string;
  downVol: string;
}

const DEFAULT_PALETTE: CandlePalette = {
  up: "#33d17a",
  down: "#ff4d4d",
  upVol: "rgba(51,209,122,0.28)",
  downVol: "rgba(255,77,77,0.28)",
};

interface Props {
  symbol: string;
  /** Candle colours — the A-share workspace passes the red-up convention.
   *  Constant per workspace instance, so effects may treat it as stable. */
  palette?: CandlePalette;
}

export function ChartPanel({ symbol, palette = DEFAULT_PALETTE }: Props) {
  const { t } = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);
  const priceRef = useRef<ISeriesApi<"Candlestick"> | null>(null);
  const volumeRef = useRef<ISeriesApi<"Histogram"> | null>(null);
  const overlayRefs = useRef<Record<string, ISeriesApi<"Line">[]>>({});

  const [period, setPeriod] = useState<string>("6mo");
  const [timeframe, setTimeframe] = useState<Timeframe>("1d");
  const [enabled, setEnabled] = useState<OverlayKey[]>(["sma"]);
  const [meta, setMeta] = useState<{ bars: number; interval: string } | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const enabledKey = useMemo(() => [...enabled].sort().join(","), [enabled]);

  // --- create the chart once, and keep it sized to its container ------------
  useEffect(() => {
    if (!hostRef.current) return;

    const chart = createChart(hostRef.current, {
      layout: {
        // Vertical falloff instead of a flat fill — the chart is the largest
        // single surface on screen, so it carries the most perceived texture.
        background: {
          type: ColorType.VerticalGradient,
          topColor: "#151a23",
          bottomColor: "#0c0f14",
        },
        textColor: "#7e8799",
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
        fontSize: 11,
      },
      grid: {
        vertLines: { color: "#1b202a" },
        horzLines: { color: "#1b202a" },
      },
      rightPriceScale: { borderColor: "#232936", scaleMargins: { top: 0.08, bottom: 0.26 } },
      timeScale: { borderColor: "#232936", timeVisible: true, secondsVisible: false },
      crosshair: {
        vertLine: { color: "#333d4f", labelBackgroundColor: "#ffb000" },
        horzLine: { color: "#333d4f", labelBackgroundColor: "#ffb000" },
      },
      watermark: {
        visible: true,
        text: "AIQUANT",
        color: "rgba(126, 135, 153, 0.055)",
        fontSize: 48,
        fontFamily: "ui-monospace, SFMono-Regular, Menlo, monospace",
      },
    });

    priceRef.current = chart.addCandlestickSeries({
      upColor: palette.up,
      downColor: palette.down,
      borderUpColor: palette.up,
      borderDownColor: palette.down,
      wickUpColor: palette.up,
      wickDownColor: palette.down,
    });

    volumeRef.current = chart.addHistogramSeries({
      priceFormat: { type: "volume" },
      priceScaleId: "vol",
      color: "#2a3140",
    });
    chart.priceScale("vol").applyOptions({ scaleMargins: { top: 0.82, bottom: 0 } });

    chartRef.current = chart;

    // The A-share workspace mounts hidden (display:none → 0×0). When it first
    // becomes visible, resize alone leaves the series crushed against the
    // right edge — refit the time scale on the 0→visible transition.
    let wasZero = true;
    const observer = new ResizeObserver(([entry]) => {
      const { width, height } = entry.contentRect;
      if (width > 0 && height > 0) {
        chart.resize(width, height);
        if (wasZero) {
          chart.timeScale().fitContent();
          wasZero = false;
        }
      } else {
        wasZero = true;
      }
    });
    observer.observe(hostRef.current);

    return () => {
      observer.disconnect();
      chart.remove();
      chartRef.current = null;
      priceRef.current = null;
      volumeRef.current = null;
      overlayRefs.current = {};
    };
  }, []);

  // --- price + volume ------------------------------------------------------
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    api
      .candles(symbol, period, TIMEFRAMES[timeframe].interval)
      .then((res) => {
        if (cancelled || !priceRef.current || !volumeRef.current) return;
        priceRef.current.setData(
          res.candles.map((c: Candle) => ({
            time: c.time as UTCTimestamp,
            open: c.open,
            high: c.high,
            low: c.low,
            close: c.close,
          })),
        );
        volumeRef.current.setData(
          res.candles.map((c: Candle) => ({
            time: c.time as UTCTimestamp,
            value: c.volume,
            color: c.close >= c.open ? palette.upVol : palette.downVol,
          })),
        );
        chartRef.current?.timeScale().fitContent();
        setMeta({ bars: res.candles.length, interval: res.interval });
      })
      .catch((err: Error) => {
        if (!cancelled) {
          setError(err.message);
          setMeta(null);
        }
      })
      .finally(() => !cancelled && setLoading(false));

    return () => {
      cancelled = true;
    };
  }, [symbol, period, timeframe]);

  // --- indicator overlays --------------------------------------------------
  useEffect(() => {
    const chart = chartRef.current;
    if (!chart) return;
    let cancelled = false;

    // Drop every existing overlay before drawing the new selection, so toggling
    // off actually removes the line instead of orphaning it on the chart.
    for (const list of Object.values(overlayRefs.current)) {
      for (const series of list) chart.removeSeries(series);
    }
    overlayRefs.current = {};

    const active = OVERLAYS.filter((o) => enabled.includes(o.key));

    Promise.all(
      active.map((o) =>
        api
          .indicator(symbol, o.key, period, o.period)
          .then((res) => ({ overlay: o, data: res.data }))
          .catch(() => null),
      ),
    ).then((results) => {
      if (cancelled || !chartRef.current) return;
      for (const result of results) {
        if (!result) continue;
        const { overlay, data } = result;
        const lines: Array<{ points: Point[]; dashed: boolean }> = Array.isArray(data)
          ? [{ points: data, dashed: false }]
          : Object.entries(data).map(([name, points]) => ({
              points,
              dashed: name !== "middle",
            }));

        overlayRefs.current[overlay.key] = lines.map(({ points, dashed }) => {
          const series = chartRef.current!.addLineSeries({
            color: overlay.color,
            lineWidth: 1,
            lineStyle: dashed ? 2 : 0,
            priceLineVisible: false,
            lastValueVisible: !dashed,
            crosshairMarkerVisible: false,
          });
          series.setData(
            points.map((p) => ({ time: p.time as UTCTimestamp, value: p.value }) as LineData),
          );
          return series;
        });
      }
    });

    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [symbol, period, timeframe, enabledKey]);

  const toggle = (key: OverlayKey) =>
    setEnabled((prev) => (prev.includes(key) ? prev.filter((k) => k !== key) : [...prev, key]));

  return (
    <div className="panel panel--grow panel--chart">
      <div className="panel__head">
        <span className="panel__title">{symbol} · {t("chart.trend")}</span>
        <span className="panel__meta">{meta ? `${meta.bars} ${t("chart.bars")} · ${meta.interval}` : ""}</span>
      </div>

      <div className="chip-row">
        {(Object.keys(TIMEFRAMES) as Timeframe[]).map((tf) => (
          <button
            key={tf}
            className={`chip chip--tf${tf === timeframe ? " is-on" : ""}`}
            onClick={() => {
              setTimeframe(tf);
              setPeriod(TIMEFRAMES[tf].default);
            }}
          >
            {t(`chart.tf.${tf}` as Parameters<typeof t>[0])}
          </button>
        ))}
        <span style={{ width: 10 }} />
        {TIMEFRAMES[timeframe].periods.map((p) => (
          <button
            key={p}
            className={`chip${p === period ? " is-on" : ""}`}
            onClick={() => setPeriod(p)}
          >
            {p}
          </button>
        ))}
        <span style={{ width: 10 }} />
        {OVERLAYS.map((o) => (
          <button
            key={o.key}
            className={`chip${enabled.includes(o.key) ? " is-on" : ""}`}
            onClick={() => toggle(o.key)}
          >
            {o.label}
          </button>
        ))}
      </div>

      <div className="chart-host" ref={hostRef}>
        {(loading || error) && (
          <div className="chart-overlay">
            {error ? (
              `${t("chart.failed")}: ${error}`
            ) : (
              <span className="chart-overlay__inner">
                <span className="spinner" aria-hidden />
                {t("chart.loading")}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
