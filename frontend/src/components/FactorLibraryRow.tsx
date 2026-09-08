import type { FactorCheck, FactorHealth, MarginalResult } from "../api";
import { useT } from "../i18n";
import { deployPaper, type SavedFactor } from "../store";
import { DeployButton } from "./DeployButton";
import { ExplainButton } from "./ExplainButton";
import { FactorReportButton } from "./FactorReport";
import { decayState, fmt, transferState } from "./factorLibUtils";

export type CheckState = FactorCheck | "pending" | "failed" | undefined;
export type MarginalState = MarginalResult | "pending" | "failed" | undefined;

interface Props {
  f: SavedFactor;
  k: string;
  health: CheckState;
  transfer: CheckState;
  serverHealth?: FactorHealth;
  marginal: MarginalState;
  selected: boolean;
  aiEnabled: boolean;
  costBps: number | null;
  backtesting: boolean;
  canMarginal: boolean;
  onToggleSelect: () => void;
  onBacktest: () => void;
  onTransfer: () => void;
  onMarginal: () => void;
  onRemove: () => void;
  onBestHorizon: (h: number) => void;
}

/** One saved factor: expression, health / transfer / server / prune / Δ
 * badges, report card, and the action strip (backtest, deploy, transfer,
 * increment, remove). Pure presentation — every mutation is a callback. */
export function FactorLibraryRow({
  f, k, health: h, transfer: tr, serverHealth: sh, marginal: mg, selected, aiEnabled, costBps, backtesting, canMarginal,
  onToggleSelect, onBacktest, onTransfer, onMarginal, onRemove, onBestHorizon,
}: Props) {
  const { t } = useT();
  return (
    <li key={k} className="lab-saved__row fl-zoo-row">
      <input type="checkbox" className="fl-zoo-row__check" checked={selected} onChange={onToggleSelect} aria-label={t("fl.cp.select")} />
      <div style={{ minWidth: 0, flex: 1 }}>
        <code style={{ fontSize: 11, wordBreak: "break-all" }}>{f.expression}</code>
        <div className="dim" style={{ fontSize: 11 }}>
          {f.market === "crypto" ? t("fl.market.crypto") : t("fl.market.us")} · IC {fmt(f.is_ic)} · OOS {fmt(f.oos_ic)} · {f.savedAt.slice(0, 10)}
        </div>
        {h && h !== "pending" && h !== "failed" && (
          <div className={`fl-badge ${decayState(f, h) === "ok" ? "fl-badge--ok" : "fl-badge--warn"}`}>
            {decayState(f, h) === "ok" ? t("fl.hc.ok", { v: fmt(h.recent_ic) }) : t("fl.hc.decayed", { v: fmt(h.recent_ic) })}
          </div>
        )}
        {h === "pending" && <div className="fl-badge dim">…</div>}
        {tr && tr !== "pending" && tr !== "failed" && (
          <div className={`fl-badge ${transferState(f, tr) === "ok" ? "fl-badge--ok" : "fl-badge--warn"}`}>
            {t(transferState(f, tr) === "ok" ? "fl.tr.ok" : "fl.tr.fail", {
              m: tr.market === "crypto" ? t("fl.tr.crypto") : t("fl.tr.us"), a: fmt(tr.is_ic), b: fmt(tr.oos_ic),
            })}
          </div>
        )}
        {tr === "pending" && <div className="fl-badge dim">⇄ …</div>}
        <ExplainButton expression={f.expression} market={f.market} enabled={aiEnabled} />
        <span data-tour="report" style={{ display: "contents" }}>
          <FactorReportButton expression={f.expression} market={f.market} horizon={f.horizon} costBps={costBps} onBestHorizon={onBestHorizon} />
        </span>
        {sh && (
          <div className={`fl-badge ${sh.decayed ? "fl-badge--warn" : ""}`} title={t("fl.sh.title", { d: sh.as_of })}>
            ☁ {t("fl.sh.badge", { d: new Date(sh.checked_at * 1000).toLocaleDateString(), g: `${sh.grades.predictive}${sh.grades.stability}${sh.grades.robustness}${sh.grades.tradability}${sh.grades.significance}` })}
            {sh.decayed ? ` · ${t("fl.sh.decayed")}` : ""}
          </div>
        )}
        {f.prune_verdict && f.prune_verdict !== "keep" && (
          <div className={`fl-badge ${(f.prune_strikes ?? 0) >= 2 ? "fl-badge--warn" : ""}`} title={t("fl.pr.badgeTitle")}>
            {(f.prune_strikes ?? 0) >= 2 ? t("fl.pr.retire") : t(`fl.pr.${f.prune_verdict}` as "fl.pr.watch")}
          </div>
        )}
        {f.best_horizon !== undefined && f.best_horizon !== f.horizon && (
          <div className="fl-badge" title={t("fl.bh.title")}>{t("fl.bh.badge", { h: String(f.best_horizon) })}</div>
        )}
        {mg === "pending" && <div className="fl-badge dim">Δ …</div>}
        {mg === "failed" && <div className="fl-badge fl-badge--warn">Δ {t("fl.mg.failed")}</div>}
        {mg && mg !== "pending" && mg !== "failed" && (
          <div
            className={`fl-badge ${mg.verdict === "adds" ? "fl-badge--ok" : mg.verdict === "hurts" ? "fl-badge--warn" : ""}`}
            title={t("fl.mg.title", { a: mg.without.sharpe.toFixed(2), b: mg.with.sharpe.toFixed(2), n: String(mg.n_others) })}
          >
            {t(`fl.mg.${mg.verdict}` as "fl.mg.adds", { d: `${mg.sharpe_delta >= 0 ? "+" : ""}${mg.sharpe_delta.toFixed(2)}` })}
          </div>
        )}
      </div>
      <div className="lab-saved__actions" data-tour="deploy">
        <button className="btn btn--mini" disabled={backtesting} onClick={onBacktest}>{backtesting ? "…" : "▶"}</button>
        <DeployButton
          onDeploy={() =>
            deployPaper("factor", f.expression.slice(0, 40), {
              expression: f.expression, market: f.market, top_n: 5, rebalance: f.best_horizon ?? f.horizon, invert: f.is_ic < 0,
            })
          }
        />
        <button className="btn btn--mini" title={t("fl.tr.title")} onClick={onTransfer}>⇄</button>
        {canMarginal && (
          <button className="btn btn--mini" title={t("fl.mg.button")} disabled={mg === "pending"} onClick={onMarginal}>Δ</button>
        )}
        <button className="watch-row__x" title={t("lab.mine.del")} onClick={onRemove}>×</button>
      </div>
    </li>
  );
}
