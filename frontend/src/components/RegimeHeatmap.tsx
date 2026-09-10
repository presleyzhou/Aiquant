import type { RegimesResult } from "../api";
import { useT } from "../i18n";

/** Factors × time windows, colored by sign-aligned IC. Green = the factor
 * worked in that window (≥ loose bar), red = it hurt, grey = too few bars.
 * Read across a row for decay, down a column for regime shifts. */
export function RegimeHeatmap({ r }: { r: RegimesResult }) {
  const { t } = useT();
  const cap = 0.06;
  const color = (ic: number) => {
    const a = Math.min(1, Math.abs(ic) / cap) * 0.85 + 0.15;
    return ic >= 0 ? `rgba(59, 224, 160, ${a.toFixed(2)})` : `rgba(255, 99, 132, ${a.toFixed(2)})`;
  };
  return (
    <div className="rh" data-testid="regime-heatmap">
      <div className="rh__note dim">{t("rh.note", { w: r.window === "week" ? t("rh.week") : t("rh.quarter"), b: r.bar.toFixed(3) })}</div>
      <div style={{ overflowX: "auto" }}>
        <table className="rh__table">
          <thead>
            <tr>
              <th className="rh__expr">{t("rh.factor")}</th>
              {r.windows.map((w) => <th key={w} className="rh__win">{w}</th>)}
              <th>{t("rh.passRate")}</th>
            </tr>
          </thead>
          <tbody>
            {r.factors.map((f) => (
              <tr key={f.expression}>
                <td className="rh__expr"><code>{f.expression}</code></td>
                {r.windows.map((w) => {
                  const c = f.cells[w];
                  return (
                    <td key={w} className="rh__cell" title={c ? `${w} · IC ${c.ic.toFixed(4)} · ${c.n} bars` : `${w} · ${t("rh.na")}`}
                      style={c ? { background: color(c.ic) } : undefined}>
                      {c ? (c.pass ? "✓" : "") : "·"}
                    </td>
                  );
                })}
                <td className={f.pass_rate !== null && f.pass_rate >= 0.6 ? "up" : "dn"}>{f.pass_rate === null ? "—" : `${Math.round(f.pass_rate * 100)}%`}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </div>
  );
}
