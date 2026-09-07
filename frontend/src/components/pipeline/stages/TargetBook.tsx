import { Fragment, useMemo } from "react";
import type { PipelineResult, PipelineTargetWeight } from "../../../api";
import { useT } from "../../../i18n";
import { maxWeight } from "../format";

/** Side of a book row; pre-V4 servers send no `side`, and a long-only book has none. */
export const sideOf = (w: Pick<PipelineTargetWeight, "side" | "weight_pct">) => w.side ?? (w.weight_pct < 0 ? "short" : "long");

/** Stage ⑥ target book. In long-short mode the rows group longs first, then
 * shorts under their own header, each with a coloured side badge; every bar
 * scales on |weight| because shorts carry negative weights. */
export function TargetBook({
  result, longShort, hasSectors, groupOf, sectorLabel,
}: {
  result: PipelineResult;
  longShort: boolean;
  hasSectors: boolean;
  groupOf: (symbol: string, group?: string) => string | undefined;
  sectorLabel: (id: string) => string;
}) {
  const { t } = useT();
  const rows = useMemo(() => {
    const ws = result.target_weights.weights;
    if (!longShort) return ws;
    return [...ws.filter((w) => sideOf(w) === "long"), ...ws.filter((w) => sideOf(w) === "short")];
  }, [result, longShort]);
  const cols = 3 + (longShort ? 1 : 0) + (hasSectors ? 1 : 0);
  const max = maxWeight(result);
  return (
    <div className="table-scroll pl-weights-scroll">
      <table className="lab-stats pl-weights" data-testid="pl-weights">
        <thead>
          <tr>
            <th>#</th>
            {longShort && <th>{t("pl.deploy.side")}</th>}
            <th>{t("pl.deploy.symbol")}</th>
            {hasSectors && <th>{t("pl.deploy.sector")}</th>}
            <th>{t("pl.deploy.weight")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((w, i) => {
            const side = sideOf(w);
            const firstShort = longShort && side === "short" && (i === 0 || sideOf(rows[i - 1]) === "long");
            return (
              <Fragment key={`${side}-${w.symbol}`}>
                {longShort && i === 0 && side === "long" && (
                  <tr className="pl-book__group" data-testid="pl-book-long">
                    <td colSpan={cols}>{t("pl.deploy.longs")}</td>
                  </tr>
                )}
                {firstShort && (
                  <tr className="pl-book__group" data-testid="pl-book-short">
                    <td colSpan={cols}>{t("pl.deploy.shorts")}</td>
                  </tr>
                )}
                <tr data-side={longShort ? side : undefined}>
                  <td className="dim">{w.score_rank}</td>
                  {longShort && (
                    <td>
                      <span className={`pl-side pl-side--${side}`}>{side === "short" ? t("pl.deploy.short") : t("pl.deploy.long")}</span>
                    </td>
                  )}
                  <td><b>{w.symbol}</b></td>
                  {hasSectors && <td className="dim">{sectorLabel(groupOf(w.symbol, w.group) ?? "—")}</td>}
                  <td>
                    <div className="pl-bar">
                      <div
                        className={`pl-bar__fill${longShort ? (side === "short" ? " pl-bar__fill--dn" : " pl-bar__fill--up") : ""}`}
                        style={{ width: `${Math.min(100, (Math.abs(w.weight_pct) / max) * 100)}%` }}
                      />
                      <span className="pl-bar__val">{w.weight_pct.toFixed(1)}%</span>
                    </div>
                  </td>
                </tr>
              </Fragment>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
