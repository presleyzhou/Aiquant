import type {
  PipelineAttribution,
  PipelineCapacity,
  PipelineContributor,
  PipelineHealthRow,
  PipelineRegime,
} from "../../api";
import { useT, type MsgKey } from "../../i18n";
import { REGIME_IDS } from "./constants";
import { covTone, fmtAum, numOpt, pct, pct2Opt, pctOpt, signed1, tone } from "./format";

export function NumField({
  label, value, range, step, hint, onChange, testId,
}: {
  label: string;
  value: number;
  range: [number, number];
  step?: number;
  hint?: string;
  onChange: (v: number) => void;
  testId?: string;
}) {
  return (
    <label className="field" title={hint}>
      <span className="field__label">
        {label} <span className="pl-range">{range[0]}–{range[1]}</span>
      </span>
      <input
        type="number"
        className="input pl-num-input"
        value={Number.isFinite(value) ? value : ""}
        min={range[0]}
        max={range[1]}
        step={step}
        onChange={(e) => onChange(e.target.value === "" ? range[0] : Number(e.target.value))}
        data-testid={testId}
      />
      {hint && <span className="pl-field-hint">{hint}</span>}
    </label>
  );
}

export function Stat({
  label, value, tone: v, toneClass, sub, small, testId, title,
}: {
  label: string; value: string; tone?: number; toneClass?: string; sub?: string; small?: boolean; testId?: string; title?: string;
}) {
  const cls = toneClass ?? (v === undefined ? "" : v > 0 ? "up" : v < 0 ? "dn" : "");
  return (
    <div className="stat" data-testid={testId} title={title}>
      <div className="stat__label">{label}</div>
      <div className={`stat__value ${cls}${small ? " pl-stat--small" : ""}`}>{value}</div>
      {sub && <div className="dim pl-stat__sub">{sub}</div>}
    </div>
  );
}

export function SplitRow({
  label, a, b, fmt, invert, warn,
}: { label: string; a: number; b: number; fmt: (v: number) => string; invert?: boolean; warn?: boolean }) {
  const delta = (b - a) * (invert ? -1 : 1);
  const cls = delta > 0.01 ? "up" : delta < -0.01 ? "dn" : "";
  return (
    <tr className={warn ? "pl-split__row--warn" : ""}>
      <td>{label}</td>
      <td className="pl-num dim">{fmt(a)}</td>
      <td className={`pl-num ${cls}`}>{fmt(b)}{warn ? " ⚠" : ""}</td>
    </tr>
  );
}

export function ContribList({
  title, rows, positive,
}: { title: string; rows: PipelineContributor[]; positive?: boolean }) {
  const { t } = useT();
  const max = Math.max(0.01, ...rows.map((r) => Math.abs(r.contribution_pct)));
  return (
    <div>
      <div className="pl-subhead">{title}</div>
      {rows.length === 0 ? (
        <div className="empty">—</div>
      ) : (
        <ul className="pl-contrib">
          {rows.map((r) => (
            <li
              key={r.symbol}
              className="pl-contrib__row"
              title={t("pl.risk.contribTitle", { w: r.avg_weight_pct.toFixed(1), d: String(r.days_held) })}
            >
              <span className="pl-contrib__sym">{r.symbol}</span>
              <span className="pl-bar pl-bar--contrib">
                <span
                  className={`pl-bar__fill ${positive ? "pl-bar__fill--up" : "pl-bar__fill--dn"}`}
                  style={{ width: `${(Math.abs(r.contribution_pct) / max) * 100}%` }}
                />
              </span>
              <span className={`pl-contrib__val ${tone(r.contribution_pct)}`}>{pct(r.contribution_pct)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** V3 regime table: portfolio vs benchmark in each vol tercile and trend state. */
export function RegimeTable({ rows }: { rows: PipelineRegime[] }) {
  const { t } = useT();
  const label = (id: string) => (REGIME_IDS.has(id) ? t(`pl.regime.${id}` as MsgKey) : id);
  return (
    <div className="table-scroll">
      <table className="lab-stats" data-testid="pl-regimes">
        <thead>
          <tr>
            <th>{t("pl.risk.regime")}</th>
            <th className="pl-num">{t("pl.risk.days")}</th>
            <th className="pl-num">{t("pl.risk.ann")}</th>
            <th className="pl-num">{t("pl.risk.benchAnn")}</th>
            <th className="pl-num">{t("bt.sharpe")}</th>
            <th className="pl-num">{t("pl.risk.hit")}</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
            <tr key={r.regime}>
              <td>{label(r.regime)}</td>
              <td className="pl-num">{r.days}</td>
              <td className={`pl-num ${tone(r.ann_return_pct ?? 0)}`}>{pctOpt(r.ann_return_pct)}</td>
              <td className="pl-num dim">{pctOpt(r.bench_ann_return_pct)}</td>
              <td className="pl-num">{numOpt(r.sharpe)}</td>
              <td className={`pl-num ${r.hit_rate_pct === null ? "" : tone(r.hit_rate_pct - 50)}`}>
                {r.hit_rate_pct === null ? "—" : `${r.hit_rate_pct.toFixed(1)}%`}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** V3 Brinson-Fachler attribution: three headline effects plus a per-sector
 * table whose active weight is a signed bar around zero. */
export function AttributionBlock({ a, sectorLabel }: { a: PipelineAttribution; sectorLabel: (id: string) => string }) {
  const { t } = useT();
  const maxActive = Math.max(0.5, ...a.groups.map((g) => Math.abs(g.avg_weight_pct - g.bench_weight_pct)));
  return (
    <>
      <div className="chip-row pl-chip-row" data-testid="pl-attr-chips">
        <span className={`chip ${tone(a.allocation_pct)}`}>{t("pl.risk.attr.alloc", { v: signed1(a.allocation_pct) })}</span>
        <span className={`chip ${tone(a.selection_pct)}`}>{t("pl.risk.attr.sel", { v: signed1(a.selection_pct) })}</span>
        <span className={`chip ${tone(a.interaction_pct)}`}>{t("pl.risk.attr.inter", { v: signed1(a.interaction_pct) })}</span>
      </div>
      {a.groups.length === 0 ? (
        <p className="dim pl-hint">{t("pl.risk.tooShort")}</p>
      ) : (
        <div className="table-scroll">
          <table className="lab-stats" data-testid="pl-attribution">
            <thead>
              <tr>
                <th>{t("pl.risk.sector")}</th>
                <th className="pl-num">{t("pl.risk.avgW")}</th>
                <th className="pl-num">{t("pl.risk.benchW")}</th>
                <th className="pl-num">{t("pl.risk.activeW")}</th>
                <th className="pl-num">{t("pl.risk.allocCol")}</th>
                <th className="pl-num">{t("pl.risk.selCol")}</th>
              </tr>
            </thead>
            <tbody>
              {a.groups.map((g) => {
                const active = g.avg_weight_pct - g.bench_weight_pct;
                const half = (Math.abs(active) / maxActive) * 50;
                return (
                  <tr key={g.group}>
                    <td>{sectorLabel(g.group)}</td>
                    <td className="pl-num">{g.avg_weight_pct.toFixed(1)}%</td>
                    <td className="pl-num dim">{g.bench_weight_pct.toFixed(1)}%</td>
                    <td className="pl-num">
                      <div className="pl-active">
                        <span className="pl-abar" aria-hidden="true">
                          <span className="pl-abar__zero" />
                          <span
                            className={`pl-abar__fill ${active >= 0 ? "pl-abar__fill--up" : "pl-abar__fill--dn"}`}
                            style={active >= 0 ? { left: "50%", width: `${half}%` } : { left: `${50 - half}%`, width: `${half}%` }}
                          />
                        </span>
                        <span className={`pl-active__val ${tone(active)}`}>{signed1(active)}%</span>
                      </div>
                    </td>
                    <td className={`pl-num ${tone(g.allocation_pct)}`}>{signed1(g.allocation_pct)}%</td>
                    <td className={`pl-num ${tone(g.selection_pct)}`}>{signed1(g.selection_pct)}%</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </>
  );
}

/** V6 per-symbol data health (stage ①): collapsed by default, worst coverage
 * first as the server sends it; stale names carry a badge with the bars
 * since their last print. */
export function HealthTable({ rows, sectorLabel }: { rows: PipelineHealthRow[]; sectorLabel: (id: string) => string }) {
  const { t } = useT();
  const minCov = Math.min(...rows.map((r) => r.coverage_pct));
  const stale = rows.filter((r) => r.stale).length;
  return (
    <details className="pl-health" data-testid="pl-health">
      <summary className="pl-health__summary" data-testid="pl-health-summary">
        <span className="pl-health__title">{t("pl.health.title")}</span>
        <span className="dim">{t("pl.health.head", { n: rows.length, min: minCov.toFixed(1) })}</span>
        {stale > 0 && (
          <>
            <span className="dim">·</span>
            <span className="pl-badge pl-badge--warn">{t("pl.health.staleCount", { n: stale })}</span>
          </>
        )}
      </summary>
      <div className="table-scroll pl-health__scroll">
        <table className="lab-stats pl-health__table" data-testid="pl-health-table">
          <thead>
            <tr>
              <th>{t("pl.health.symbol")}</th>
              <th>{t("pl.health.sector")}</th>
              <th className="pl-num">{t("pl.health.coverage")}</th>
              <th className="pl-num">{t("pl.health.gaps")}</th>
              <th>{t("pl.health.first")}</th>
              <th>{t("pl.health.last")}</th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.symbol} className={r.stale ? "pl-health__row--stale" : ""} data-stale={r.stale ? "true" : undefined}>
                <td>
                  <b>{r.symbol}</b>
                  {r.stale && (
                    <span className="pl-badge pl-badge--warn pl-chip--mini" data-testid="pl-stale">
                      {t("pl.health.stale")}
                      {r.stale_days !== undefined && ` · ${t("pl.health.staleDays", { n: r.stale_days })}`}
                    </span>
                  )}
                </td>
                <td className="dim">{sectorLabel(r.group)}</td>
                <td className={`pl-num ${covTone(r.coverage_pct)}`}>{r.coverage_pct.toFixed(1)}%</td>
                <td className={`pl-num ${r.gaps > 0 ? "pl-tone--warn" : ""}`}>{r.gaps}</td>
                <td className="dim">{r.first ?? "—"}</td>
                <td className={r.stale ? "pl-tone--warn" : "dim"}>{r.last ?? "—"}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      <p className="dim pl-hint">{t("pl.health.note")}</p>
    </details>
  );
}

/** V6 capacity (stage ⑤): the square-root-impact curve as a four-row table
 * plus a headline chip at the breakeven AUM. A grid that is null throughout
 * means the panel had no volume, and the block says so instead of a number. */
export function CapacityBlock({ c }: { c: PipelineCapacity }) {
  const { t } = useT();
  const allNull = c.aum_grid.every((_, i) => c.net_excess_pct_ann[i] == null && c.impact_drag_pct_ann[i] == null);
  const be = c.breakeven_aum;
  const headTone = be === null || be < 1e7 ? "pl-tone--bad" : be < 1e8 ? "pl-tone--warn" : "pl-tone--ok";
  return (
    <div className="pl-cap" data-testid="pl-capacity">
      <div className="chip-row pl-chip-row">
        {allNull ? (
          <span className="chip pl-tone--warn" data-testid="pl-capacity-chip">{t("pl.cap.noVolume")}</span>
        ) : (
          <span className={`chip ${headTone}`} title={t("pl.cap.headlineTitle")} data-testid="pl-capacity-chip">
            {be === null ? t("pl.cap.none") : t("pl.cap.headline", { v: fmtAum(be) })}
          </span>
        )}
        {c.excess_pct_ann !== null && (
          <span className="chip">{t("pl.cap.excess", { v: signed1(c.excess_pct_ann) })}</span>
        )}
        {c.costed_trade_pct !== undefined && c.costed_trade_pct !== null && (
          <span className="chip dim" title={t("pl.cap.costedTitle")} data-testid="pl-capacity-costed">
            {t("pl.cap.costed", { v: c.costed_trade_pct.toFixed(0) })}
          </span>
        )}
      </div>
      <div className="table-scroll">
        <table className="lab-stats pl-cap__table" data-testid="pl-capacity-table">
          <thead>
            <tr>
              <th>{t("pl.cap.aum")}</th>
              <th className="pl-num">{t("pl.cap.drag")}</th>
              <th className="pl-num">{t("pl.cap.net")}</th>
              <th className="pl-num" title={t("pl.cap.partTitle")}>{t("pl.cap.part")}</th>
            </tr>
          </thead>
          <tbody>
            {c.aum_grid.map((aum, i) => {
              const net = c.net_excess_pct_ann[i] ?? null;
              return (
                <tr key={aum} className={net !== null && net <= 0 ? "pl-cap__row--under" : ""}>
                  <td><b>{fmtAum(aum)}</b></td>
                  <td className="pl-num dn">{pct2Opt(c.impact_drag_pct_ann[i])}</td>
                  <td className={`pl-num ${net === null ? "" : tone(net)}`}>{pctOpt(net)}</td>
                  <td className="pl-num dim">{pct2Opt(c.participation_pct[i])}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {allNull && <p className="dim pl-hint" data-testid="pl-capacity-novolume">{t("pl.cap.noVolume")}</p>}
      <p className="dim pl-hint">{t("pl.cap.note")}</p>
    </div>
  );
}
