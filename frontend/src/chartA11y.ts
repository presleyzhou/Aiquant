import type { IChartApi } from "lightweight-charts";
import type { KeyboardEvent } from "react";

/** Keyboard navigation for a focusable lightweight-charts host:
 *  ← / → pan by a tenth of the visible range, + / − zoom, Home fits all data.
 *  Screen readers get the summary from the host's aria-label; sighted keyboard
 *  users get the same affordances the mouse wheel offers. */
export function chartKeyHandler(get: () => IChartApi | null) {
  return (e: KeyboardEvent<HTMLElement>) => {
    const chart = get();
    if (!chart) return;
    const ts = chart.timeScale();
    const range = ts.getVisibleLogicalRange();
    const span = range ? range.to - range.from : 0;
    const step = Math.max(1, Math.round(span / 10));
    switch (e.key) {
      case "ArrowLeft":
        if (range) ts.setVisibleLogicalRange({ from: range.from - step, to: range.to - step });
        break;
      case "ArrowRight":
        if (range) ts.setVisibleLogicalRange({ from: range.from + step, to: range.to + step });
        break;
      case "+":
      case "=":
        if (range && span > 10) ts.setVisibleLogicalRange({ from: range.from + step, to: range.to - step });
        break;
      case "-":
      case "_":
        if (range) ts.setVisibleLogicalRange({ from: range.from - step, to: range.to + step });
        break;
      case "Home":
        ts.fitContent();
        break;
      default:
        return;
    }
    e.preventDefault();
  };
}

export const isoDay = (unixSeconds: number) => new Date(unixSeconds * 1000).toISOString().slice(0, 10);
export const pctChange = (from: number, to: number) => (from ? ((to / from - 1) * 100) : 0);
export const signed = (v: number, digits = 1) => `${v > 0 ? "+" : ""}${v.toFixed(digits)}%`;
