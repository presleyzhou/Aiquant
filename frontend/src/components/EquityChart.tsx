import {
  ColorType,
  createChart,
  type IChartApi,
  type UTCTimestamp,
} from "lightweight-charts";
import { useEffect, useRef } from "react";
import type { Point } from "../api";
import { chartKeyHandler, isoDay, pctChange, signed } from "../chartA11y";
import { useT } from "../i18n";

interface Props {
  equity: Point[];
  benchmark: Point[];
  drawdown: Point[];
}

/** Strategy equity vs buy-and-hold, with the drawdown as a red baseline strip
 * along the bottom quarter (same overlay trick the price chart uses for
 * volume — one chart, no second pane needed). */
export function EquityChart({ equity, benchmark, drawdown }: Props) {
  const { t } = useT();
  const hostRef = useRef<HTMLDivElement>(null);
  const chartRef = useRef<IChartApi | null>(null);

  useEffect(() => {
    if (!hostRef.current) return;

    const chart = createChart(hostRef.current, {
      height: 220,
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
      rightPriceScale: {
        borderColor: "#1e2a44",
        scaleMargins: { top: 0.06, bottom: 0.3 },
      },
      timeScale: { borderColor: "#1e2a44", timeVisible: false },
      crosshair: {
        vertLine: { color: "#2a3a5c", labelBackgroundColor: "#3be0ff" },
        horzLine: { color: "#2a3a5c", labelBackgroundColor: "#3be0ff" },
      },
      handleScroll: false,
      handleScale: false,
    });
    chartRef.current = chart;

    const observer = new ResizeObserver(([entry]) => {
      const { width } = entry.contentRect;
      if (width > 0) {
        chart.resize(width, 220);
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

    // Rebuild series on every result — simpler and safer than diffing three
    // series in place, and a backtest re-run is a rare, user-initiated event.
    const doomed: unknown[] = [];

    const benchmarkSeries = chart.addLineSeries({
      color: "#5a6478",
      lineWidth: 1,
      lineStyle: 2,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    benchmarkSeries.setData(
      benchmark.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
    );
    doomed.push(benchmarkSeries);

    const equitySeries = chart.addLineSeries({
      color: "#ffb000",
      lineWidth: 2,
      priceLineVisible: false,
      lastValueVisible: true,
    });
    equitySeries.setData(equity.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })));
    doomed.push(equitySeries);

    const drawdownSeries = chart.addBaselineSeries({
      priceScaleId: "dd",
      baseValue: { type: "price", price: 0 },
      topLineColor: "rgba(0,0,0,0)",
      topFillColor1: "rgba(0,0,0,0)",
      topFillColor2: "rgba(0,0,0,0)",
      bottomLineColor: "rgba(255,77,77,0.7)",
      bottomFillColor1: "rgba(255,77,77,0.05)",
      bottomFillColor2: "rgba(255,77,77,0.28)",
      lineWidth: 1,
      priceLineVisible: false,
      lastValueVisible: false,
      crosshairMarkerVisible: false,
    });
    chart.priceScale("dd").applyOptions({ scaleMargins: { top: 0.76, bottom: 0 } });
    drawdownSeries.setData(
      drawdown.map((p) => ({ time: p.time as UTCTimestamp, value: p.value })),
    );
    doomed.push(drawdownSeries);

    chart.timeScale().fitContent();

    return () => {
      for (const series of doomed) {
        try {
          chart.removeSeries(series as Parameters<IChartApi["removeSeries"]>[0]);
        } catch {
          /* chart already disposed */
        }
      }
    };
  }, [equity, benchmark, drawdown]);

  const first = equity[0];
  const last = equity[equity.length - 1];
  const bFirst = benchmark[0];
  const bLast = benchmark[benchmark.length - 1];
  const maxDd = drawdown.reduce((m, p) => Math.min(m, p.value), 0);
  const summary = first && last
    ? t("a11y.equity", {
        n: String(equity.length), from: isoDay(first.time), to: isoDay(last.time),
        ret: signed(pctChange(first.value, last.value)),
        bench: bFirst && bLast ? signed(pctChange(bFirst.value, bLast.value)) : "—",
        dd: `${maxDd.toFixed(1)}%`,
      })
    : t("a11y.empty");
  return (
    <div className="equity-chart">
      <div className="equity-chart__legend">
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: "#ffb000" }} />
          {t("bt.legend.equity")}
        </span>
        <span className="legend-item">
          <span className="legend-swatch legend-swatch--dashed" />
          {t("bt.legend.bench")}
        </span>
        <span className="legend-item">
          <span className="legend-swatch" style={{ background: "rgba(255,77,77,0.7)" }} />
          {t("bt.legend.dd")}
        </span>
      </div>
      <div
        ref={hostRef}
        className="chart-focusable"
        role="img"
        tabIndex={0}
        aria-label={summary}
        title={t("a11y.keys")}
        onKeyDown={chartKeyHandler(() => chartRef.current)}
        data-testid="equity-chart"
      />
      <p className="sr-only">{summary} {t("a11y.keys")}</p>
    </div>
  );
}
