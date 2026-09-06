import { Fragment } from "react";
import type { PipelineQuantiles, PipelineResult, PipelineSensitivity, Point } from "../../api";
import { useT } from "../../i18n";
import { IC_HORIZONS, STACK_COLORS } from "./constants";
import { circled, pct, signed1, signed3 } from "./format";

/** Year rows × 12 month cells; colour intensity scales with |return| across
 * the whole table so one blowout month reads as the outlier it is. */
export function Heatmap({
  rows, benchLabel,
}: { rows: PipelineResult["backtest"]["monthly_returns"]; benchLabel: string }) {
  const years = [...new Set(rows.map((r) => r.year))].sort((a, b) => a - b);
  const byKey = new Map(rows.map((r) => [`${r.year}-${r.month}`, r]));
  const maxAbs = Math.max(0.01, ...rows.map((r) => Math.abs(r.ret_pct)));
  if (years.length === 0) return <div className="empty">—</div>;
  return (
    <div className="pl-heat" role="table">
      <div className="pl-heat__row pl-heat__head" role="row">
        <span className="pl-heat__year" />
        {Array.from({ length: 12 }, (_, i) => (
          <span key={i} className="pl-heat__cell pl-heat__month" role="columnheader">{i + 1}</span>
        ))}
      </div>
      {years.map((y) => (
        <div key={y} className="pl-heat__row" role="row">
          <span className="pl-heat__year" role="rowheader">{y}</span>
          {Array.from({ length: 12 }, (_, i) => {
            const r = byKey.get(`${y}-${i + 1}`);
            if (!r) return <span key={i} className="pl-heat__cell pl-heat__cell--none" role="cell" />;
            const a = 0.12 + 0.75 * Math.min(1, Math.abs(r.ret_pct) / maxAbs);
            const bg = r.ret_pct >= 0 ? `rgba(61, 220, 132, ${a.toFixed(2)})` : `rgba(255, 92, 108, ${a.toFixed(2)})`;
            return (
              <span
                key={i}
                className="pl-heat__cell"
                role="cell"
                style={{ background: bg }}
                title={`${y}-${String(i + 1).padStart(2, "0")} · ${pct(r.ret_pct)} · ${benchLabel} ${pct(r.bench_pct)}`}
              >
                {Math.abs(r.ret_pct) >= 10 ? r.ret_pct.toFixed(0) : r.ret_pct.toFixed(1)}
              </span>
            );
          })}
        </div>
      ))}
    </div>
  );
}

/** A series as a tiny polyline with one dashed reference line (100% for
 * gross exposure, 1.0 for rolling beta). The y-range always contains the
 * reference and, when given, `floor`, so the line never hides the context. */
export function Sparkline({
  data, refValue, floor, className, testId,
}: { data: Point[]; refValue: number; floor?: number; className?: string; testId?: string }) {
  if (data.length < 2) return <div className="empty">—</div>;
  const w = 100;
  const h = 26;
  const vals = data.map((p) => p.value);
  const lo = Math.min(refValue, floor ?? Infinity, ...vals);
  const hi = Math.max(refValue, ...vals);
  const pad = Math.max((hi - lo) * 0.08, 1e-6);
  const y = (v: number) => h - 1 - ((v - lo + pad) / (hi - lo + 2 * pad)) * (h - 2);
  const pts = data.map((p, i) => `${((i / (data.length - 1)) * w).toFixed(2)},${y(p.value).toFixed(2)}`).join(" ");
  return (
    <svg
      className={`pl-spark${className ? ` ${className}` : ""}`}
      viewBox={`0 0 ${w} ${h}`}
      preserveAspectRatio="none"
      aria-hidden="true"
      data-testid={testId}
    >
      <line x1="0" y1={y(refValue)} x2={w} y2={y(refValue)} className="pl-spark__ref" />
      <polyline points={pts} className="pl-spark__line" />
    </svg>
  );
}

/** Information-horizon curve: one bar per forward horizon, positive IC up
 * from the axis and negative down, value printed at the bar tip. A null IC
 * (too few samples) is a dashed empty slot so the gap stays visible. */
export function IcDecayBars({ rows }: { rows: Array<{ horizon: number; ic: number | null }> }) {
  const { t } = useT();
  const byH = new Map(rows.map((r) => [r.horizon, r.ic]));
  const horizons = IC_HORIZONS.every((h) => byH.has(h)) ? IC_HORIZONS : rows.map((r) => r.horizon);
  const w = 280;
  const h = 96;
  const top = 14;
  const bottom = 16;
  const plotH = h - top - bottom;
  const maxAbs = Math.max(0.005, ...rows.map((r) => Math.abs(r.ic ?? 0)));
  const axisY = top + plotH / 2;
  const scale = (plotH / 2 - 2) / maxAbs;
  const slot = w / horizons.length;
  const barW = Math.min(26, slot * 0.6);
  return (
    <svg className="pl-decay" viewBox={`0 0 ${w} ${h}`} role="img" aria-label={t("pl.sig.decay")} data-testid="pl-ic-decay">
      <line x1="0" y1={axisY} x2={w} y2={axisY} className="pl-decay__axis" />
      {horizons.map((hz, i) => {
        const ic = byH.get(hz) ?? null;
        const cx = slot * i + slot / 2;
        const x = cx - barW / 2;
        if (ic === null) {
          return (
            <g key={hz}>
              <title>{t("pl.sig.decayNone", { h: String(hz) })}</title>
              <rect x={x} y={axisY - 6} width={barW} height={12} className="pl-decay__none" />
              <text x={cx} y={axisY - 9} className="pl-decay__val">—</text>
              <text x={cx} y={h - 4} className="pl-decay__h">{hz}</text>
            </g>
          );
        }
        const len = Math.abs(ic) * scale;
        const up = ic >= 0;
        const y = up ? axisY - len : axisY;
        const labelY = up ? Math.max(9, axisY - len - 3) : Math.min(h - bottom - 1, axisY + len + 9);
        return (
          <g key={hz}>
            <title>{t("pl.sig.decayBar", { h: String(hz), v: signed3(ic) })}</title>
            <rect x={x} y={y} width={barW} height={Math.max(0.5, len)} className={up ? "pl-decay__bar--up" : "pl-decay__bar--dn"} />
            <text x={cx} y={labelY} className="pl-decay__val">{signed3(ic)}</text>
            <text x={cx} y={h - 4} className="pl-decay__h">{hz}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** V3 quintile check: five bars, bucket 1 (lowest score) → 5 (highest) left to
 * right, annualised return up from the axis when positive and down when
 * negative. A null bucket is a dashed empty slot, as in the decay chart. */
export function QuantileBars({ q }: { q: PipelineQuantiles }) {
  const { t } = useT();
  const buckets = [...q.buckets].sort((a, b) => a.bucket - b.bucket);
  const w = 280;
  const h = 96;
  const top = 14;
  const bottom = 16;
  const plotH = h - top - bottom;
  const maxAbs = Math.max(0.5, ...buckets.map((b) => Math.abs(b.ann_return_pct ?? 0)));
  const axisY = top + plotH / 2;
  const scale = (plotH / 2 - 2) / maxAbs;
  const slot = w / buckets.length;
  const barW = Math.min(34, slot * 0.6);
  return (
    <svg
      className="pl-decay pl-quant"
      viewBox={`0 0 ${w} ${h}`}
      role="img"
      aria-label={t("pl.sig.quantiles")}
      data-testid="pl-quantiles"
    >
      <line x1="0" y1={axisY} x2={w} y2={axisY} className="pl-decay__axis" />
      {buckets.map((b, i) => {
        const cx = slot * i + slot / 2;
        const x = cx - barW / 2;
        if (b.ann_return_pct === null) {
          return (
            <g key={b.bucket}>
              <title>{t("pl.sig.bucketNone", { n: String(b.bucket) })}</title>
              <rect x={x} y={axisY - 6} width={barW} height={12} className="pl-decay__none" data-bucket={b.bucket} />
              <text x={cx} y={axisY - 9} className="pl-decay__val">—</text>
              <text x={cx} y={h - 4} className="pl-decay__h">{b.bucket}</text>
            </g>
          );
        }
        const v = b.ann_return_pct;
        const len = Math.abs(v) * scale;
        const up = v >= 0;
        const y = up ? axisY - len : axisY;
        const labelY = up ? Math.max(9, axisY - len - 3) : Math.min(h - bottom - 1, axisY + len + 9);
        return (
          <g key={b.bucket}>
            <title>{t("pl.sig.bucket", { n: String(b.bucket), v: signed1(v) })}</title>
            <rect
              x={x}
              y={y}
              width={barW}
              height={Math.max(0.5, len)}
              className={up ? "pl-decay__bar--up" : "pl-decay__bar--dn"}
              data-bucket={b.bucket}
            />
            <text x={cx} y={labelY} className="pl-decay__val">{signed1(v)}%</text>
            <text x={cx} y={h - 4} className="pl-decay__h">{b.bucket}</text>
          </g>
        );
      })}
    </svg>
  );
}

/** V3 sector mix of the target book: one horizontal stacked bar and a legend. */
export function SectorStack({
  groups, sectorLabel,
}: { groups: Array<{ group: string; weight_pct: number }>; sectorLabel: (id: string) => string }) {
  const total = Math.max(0.01, groups.reduce((acc, g) => acc + Math.max(0, g.weight_pct), 0));
  return (
    <div data-testid="pl-sector-stack">
      <div className="pl-stack" role="img" aria-label={groups.map((g) => `${sectorLabel(g.group)} ${g.weight_pct.toFixed(1)}%`).join(", ")}>
        {groups.map((g, i) => (
          <span
            key={g.group}
            className="pl-stack__seg"
            style={{ width: `${(Math.max(0, g.weight_pct) / total) * 100}%`, background: STACK_COLORS[i % STACK_COLORS.length] }}
            title={`${sectorLabel(g.group)} · ${g.weight_pct.toFixed(1)}%`}
          />
        ))}
      </div>
      <ul className="pl-legend">
        {groups.map((g, i) => (
          <li key={g.group} className="pl-legend__item">
            <span className="pl-legend__dot" style={{ background: STACK_COLORS[i % STACK_COLORS.length] }} />
            {sectorLabel(g.group)}
            <span className="pl-legend__val">{g.weight_pct.toFixed(1)}%</span>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** V6 factor correlation heatmap (stage ②): n×n cells on a diverging scale —
 * −1 red, 0 dark, +1 green — value printed in each, circled-digit index
 * labels whose hover shows the expression; a null pair is a dashed slot. */
export function CorrHeatmap({ m, labels }: { m: Array<Array<number | null>>; labels: string[] }) {
  const { t } = useT();
  const n = m.length;
  const name = (i: number) => labels[i] ?? `#${i + 1}`;
  const bg = (v: number) => {
    const a = 0.08 + 0.72 * Math.min(1, Math.abs(v));
    return v >= 0 ? `rgba(61, 220, 132, ${a.toFixed(2)})` : `rgba(255, 92, 108, ${a.toFixed(2)})`;
  };
  return (
    <div className="pl-corr" data-testid="pl-corr">
      <div
        className="pl-corr__grid"
        role="table"
        aria-label={t("pl.sig.corr")}
        style={{ gridTemplateColumns: `28px repeat(${n}, minmax(44px, 56px))` }}
      >
        <span className="pl-corr__hdr" role="columnheader" />
        {m.map((_, j) => (
          <span key={`c${j}`} className="pl-corr__hdr" role="columnheader" title={t("pl.sig.corrFactor", { i: circled(j), e: name(j) })}>
            {circled(j)}
          </span>
        ))}
        {m.map((row, i) => (
          <Fragment key={`r${i}`}>
            <span className="pl-corr__hdr" role="rowheader" title={t("pl.sig.corrFactor", { i: circled(i), e: name(i) })}>
              {circled(i)}
            </span>
            {Array.from({ length: n }, (_, j) => {
              const v = row[j] ?? null;
              const pair = { a: circled(i), b: circled(j) };
              if (v === null) {
                return (
                  <span key={j} className="pl-corr__cell pl-corr__cell--none" role="cell" title={t("pl.sig.corrNone", pair)}>
                    —
                  </span>
                );
              }
              return (
                <span
                  key={j}
                  className={`pl-corr__cell${i === j ? " is-diag" : ""}`}
                  role="cell"
                  style={{ background: bg(v) }}
                  title={`${t("pl.sig.corrCell", { ...pair, v: v.toFixed(2) })}\n${name(i)}\n${name(j)}`}
                  data-corr={v.toFixed(2)}
                >
                  {v.toFixed(2)}
                </span>
              );
            })}
          </Fragment>
        ))}
      </div>
      <ul className="pl-corr__legend">
        {labels.slice(0, n).map((e, i) => (
          <li key={e}>
            <span className="pl-corr__idx">{circled(i)}</span>
            <code className="pl-factor__expr">{e}</code>
          </li>
        ))}
      </ul>
    </div>
  );
}

/** V4 parameter-sensitivity heatmap: rows follow `top_n`, columns follow
 * `rebalance`, each cell prints its Sharpe and is shaded by it (red below zero,
 * green above, intensity relative to the grid's extremes). The chosen
 * configuration is outlined; a null cell is a dashed empty slot. */
export function SensitivityGrid({
  s, chosenTopN, chosenRebalance,
}: { s: PipelineSensitivity; chosenTopN: number; chosenRebalance: number }) {
  const { t } = useT();
  const sharpes = s.cells.flat().flatMap((c) => (c ? [c.sharpe] : []));
  const maxPos = Math.max(0.5, ...sharpes);
  const maxNeg = Math.max(0.5, ...sharpes.map((v) => -v));
  const bg = (v: number) =>
    v >= 0
      ? `rgba(61, 220, 132, ${(0.1 + 0.7 * Math.min(1, v / maxPos)).toFixed(2)})`
      : `rgba(255, 92, 108, ${(0.1 + 0.7 * Math.min(1, -v / maxNeg)).toFixed(2)})`;
  return (
    <div className="pl-sens" data-testid="pl-sens">
      <div className="pl-sens__axes dim">
        {t("pl.bt.sens.rows")} · {t("pl.bt.sens.cols")}
      </div>
      <div className="pl-sens__grid" role="table" aria-label={t("pl.bt.sens")} style={{ gridTemplateColumns: `72px repeat(${s.rebalance.length}, minmax(56px, 1fr))` }}>
        <span className="pl-sens__corner" role="columnheader">{t("pl.bt.sens.corner")}</span>
        {s.rebalance.map((r) => (
          <span key={`c${r}`} className="pl-sens__hdr" role="columnheader">{r}</span>
        ))}
        {s.top_n.map((n, i) => (
          <SensitivityRow
            key={n}
            topN={n}
            rebalance={s.rebalance}
            cells={s.cells[i] ?? []}
            chosenRebalance={n === chosenTopN ? chosenRebalance : null}
            bg={bg}
          />
        ))}
      </div>
    </div>
  );
}

export function SensitivityRow({
  topN, rebalance, cells, chosenRebalance, bg,
}: {
  topN: number;
  rebalance: number[];
  cells: Array<PipelineSensitivity["cells"][number][number]>;
  chosenRebalance: number | null;
  bg: (v: number) => string;
}) {
  const { t } = useT();
  return (
    <>
      <span className="pl-sens__hdr" role="rowheader">{topN}</span>
      {rebalance.map((r, j) => {
        const c = cells[j] ?? null;
        const chosen = r === chosenRebalance;
        const cls = `pl-sens__cell${chosen ? " is-chosen" : ""}`;
        if (!c) {
          return (
            <span key={r} className={`${cls} pl-sens__cell--none`} role="cell" title={t("pl.bt.sens.cellNone", { n: topN, r })}>
              —
            </span>
          );
        }
        const title =
          t("pl.bt.sens.cell", { n: topN, r, s: c.sharpe.toFixed(2), e: signed1(c.excess_pct), d: c.max_drawdown_pct.toFixed(1) }) +
          (chosen ? t("pl.bt.sens.cellChosen") : "");
        return (
          <span
            key={r}
            className={cls}
            role="cell"
            style={{ background: bg(c.sharpe) }}
            title={title}
            aria-label={chosen ? t("pl.bt.sens.chosen") : undefined}
            data-chosen={chosen ? "true" : undefined}
          >
            {c.sharpe.toFixed(2)}
          </span>
        );
      })}
    </>
  );
}
