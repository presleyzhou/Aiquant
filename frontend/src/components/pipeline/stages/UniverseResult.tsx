import type { PipelineHistory, PipelineResult } from "../../../api";
import { useT } from "../../../i18n";
import { HealthTable, Stat } from "../blocks";

/** Stage ① after a run: coverage stats, universe summary chips and the
 * per-symbol data-health table. */
export function UniverseResult({
  result, universe, history, sectorLabel,
}: { result: PipelineResult; universe: string[]; history: PipelineHistory; sectorLabel: (id: string) => string }) {
  const { t } = useT();
  return (
    <>
      <div className="stat-grid pl-stats">
        <Stat
          label={t("pl.uni.covered")}
          value={`${result.universe.symbols} / ${
            result.universe.custom
              ? result.universe.requested ?? result.universe.symbols
              : universe.length || result.universe.symbols
          }`}
        />
        <Stat label={t("pl.uni.bars")} value={String(result.universe.bars)} />
        <Stat label={t("pl.uni.span")} value={`${result.universe.from} → ${result.universe.to}`} small />
      </div>
      {(result.universe.custom || result.universe.history || (result.universe.dropped?.length ?? 0) > 0) && (
        <div className="chip-row pl-chip-row" data-testid="pl-universe-summary">
          {result.universe.custom ? (
            <span className="chip is-on">
              {t("pl.uni.customSummary", { n: result.universe.symbols, h: result.universe.history ?? history })}
            </span>
          ) : (
            result.universe.history && (
              <span className="chip">{t("pl.uni.builtinSummary", { h: result.universe.history })}</span>
            )
          )}
          {result.universe.provider && (
            <span className="chip dim" title={t("pl.uni.providerHint")}>
              {t("pl.uni.provider", { p: result.universe.provider })}
            </span>
          )}
          {result.universe.dropped && result.universe.dropped.length > 0 && (
            <span
              className="pl-badge pl-badge--warn pl-dropped"
              title={result.universe.dropped.join(", ")}
              data-testid="pl-dropped"
            >
              ⚠ {t("pl.uni.dropped", { n: result.universe.dropped.length, list: result.universe.dropped.join(", ") })}
            </span>
          )}
        </div>
      )}
      {result.universe.health && result.universe.health.length > 0 && (
        <HealthTable rows={result.universe.health} sectorLabel={sectorLabel} />
      )}
    </>
  );
}
