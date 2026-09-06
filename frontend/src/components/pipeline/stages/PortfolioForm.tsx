import type { PipelineConfig, PipelineResult } from "../../../api";
import { useT, type MsgKey } from "../../../i18n";
import { NumField } from "../blocks";
import { PRESET_IDS, type FormState, type PresetId } from "../form";

/** Stage ③ body: presets, scheme radios, the parameter grid and — after a
 * run — the portfolio summary chips. All state lives in the page. */
export function PortfolioForm({
  form, patch, running, limits, schemes, result, activePreset, applyPreset, schemeName,
}: {
  form: FormState;
  patch: (p: Partial<FormState>) => void;
  running: boolean;
  limits: PipelineConfig["limits"];
  schemes: PipelineConfig["schemes"];
  result: PipelineResult | null;
  activePreset: PresetId | null;
  applyPreset: (id: PresetId) => void;
  schemeName: (id: string) => string;
}) {
  const { t, lang } = useT();
  const presetName = (id: PresetId) => t(`pl.preset.${id}` as MsgKey);
  return (
    <>
      <div className="pl-presets" data-testid="pl-presets">
        <span className="pl-presets__label">{t("pl.preset.title")}</span>
        {PRESET_IDS.map((id) => (
          <button
            key={id}
            className={`chip pl-preset${activePreset === id ? " is-on" : ""}`}
            onClick={() => applyPreset(id)}
            disabled={running}
            title={t(`pl.preset.${id}Title` as MsgKey)}
            aria-pressed={activePreset === id}
            data-testid={`pl-preset-${id}`}
          >
            {presetName(id)}
          </button>
        ))}
        {activePreset && (
          <span className="pl-badge pl-badge--ok" data-testid="pl-preset-applied">
            ✓ {t("pl.preset.applied", { p: presetName(activePreset) })}
          </span>
        )}
        <span className="dim pl-hint pl-presets__hint">{t("pl.preset.hint")}</span>
      </div>
      <div className="pl-schemes" role="radiogroup" aria-label={t("pl.pf.scheme")}>
        {schemes.map((s) => (
          <button
            key={s.id}
            role="radio"
            aria-checked={form.scheme === s.id}
            className={`pl-scheme${form.scheme === s.id ? " is-on" : ""}`}
            onClick={() => patch({ scheme: s.id })}
            disabled={running}
          >
            <span className="pl-scheme__name">{lang === "zh" ? s.zh : s.en}</span>
            <span className="pl-scheme__desc">{lang === "zh" ? s.desc_zh : s.desc_en}</span>
          </button>
        ))}
      </div>
      <div className="pl-params">
        <NumField
          label={t("pl.pf.topN")}
          value={form.topN}
          range={limits.top_n}
          onChange={(v) => patch({ topN: v })}
          testId="pl-topn"
        />
        <NumField
          label={t("pl.pf.rebalance")}
          value={form.rebalance}
          range={limits.rebalance}
          onChange={(v) => patch({ rebalance: v })}
        />
        <NumField
          label={t("pl.pf.maxWeight")}
          value={form.maxWeightPct}
          range={[Math.round(limits.max_weight[0] * 100), Math.round(limits.max_weight[1] * 100)]}
          onChange={(v) => patch({ maxWeightPct: v })}
        />
        <NumField
          label={t("pl.pf.cost")}
          value={form.costBps}
          range={limits.cost_bps}
          onChange={(v) => patch({ costBps: v })}
        />
        <label className="field">
          <span className="field__label">{t("pl.pf.targetVol")}</span>
          <div className="pl-inline">
            <input
              type="checkbox"
              className="fl-zoo-row__check"
              checked={form.targetVolPct !== null}
              onChange={(e) => patch({ targetVolPct: e.target.checked ? 15 : null })}
              aria-label={t("pl.pf.targetVolOn")}
            />
            {form.targetVolPct === null ? (
              <span className="dim">{t("pl.pf.off")}</span>
            ) : (
              <input
                type="number"
                className="input pl-num-input"
                value={form.targetVolPct}
                min={limits.target_vol_pct[0]}
                max={limits.target_vol_pct[1]}
                onChange={(e) => patch({ targetVolPct: Number(e.target.value) })}
              />
            )}
          </div>
        </label>
        <NumField
          label={t("pl.pf.volLookback")}
          value={form.volLookback}
          range={limits.vol_lookback}
          onChange={(v) => patch({ volLookback: v })}
        />
        <NumField
          label={t("pl.pf.holdBuffer")}
          value={form.holdBuffer}
          range={limits.hold_buffer}
          hint={t("pl.pf.holdBufferHint")}
          onChange={(v) => patch({ holdBuffer: v })}
        />
        <NumField
          label={t("pl.pf.tradeRate")}
          value={form.tradeRate}
          range={limits.trade_rate}
          step={0.1}
          hint={t("pl.pf.tradeRateHint")}
          onChange={(v) => patch({ tradeRate: v })}
        />
        <NumField
          label={t("pl.pf.shrink")}
          value={form.shrinkToEqual}
          range={limits.shrink_to_equal}
          step={0.1}
          hint={t("pl.pf.shrinkHint")}
          onChange={(v) => patch({ shrinkToEqual: v })}
          testId="pl-shrink"
        />
        <label className="field">
          <span className="field__label">{t("pl.pf.compare")}</span>
          <div className="pl-inline">
            <input
              type="checkbox"
              className="fl-zoo-row__check"
              checked={form.compare}
              onChange={(e) => patch({ compare: e.target.checked })}
              aria-label={t("pl.pf.compare")}
            />
            <span className="dim">{form.compare ? t("pl.pf.compareOn") : t("pl.pf.compareOff")}</span>
          </div>
        </label>
      </div>
      <p className="dim pl-hint">{t("pl.pf.hint")}</p>
      {result && (
        <div className="chip-row pl-chip-row">
          <span className="chip is-on">{schemeName(result.portfolio.scheme)}</span>
          <span className="chip">{t("pl.pf.effN", { n: result.portfolio.avg_effective_n.toFixed(1) })}</span>
          <span className="chip">{t("pl.pf.exposure", { v: result.portfolio.avg_exposure_pct.toFixed(0) })}</span>
          <span className="chip">{t("pl.pf.turnover", { v: result.portfolio.avg_turnover_pct.toFixed(1) })}</span>
          {result.portfolio.annual_turnover_x !== undefined && (
            <span className="chip" title={t("pl.pf.annualTurnoverTitle")}>
              {t("pl.pf.annualTurnover", { v: result.portfolio.annual_turnover_x.toFixed(1) })}
            </span>
          )}
          {result.portfolio.breakeven_cost_bps !== undefined && (
            <span className="chip" title={t("pl.pf.breakevenTitle")}>
              {t("pl.pf.breakeven", {
                v: result.portfolio.breakeven_cost_bps === null ? "—" : result.portfolio.breakeven_cost_bps.toFixed(1),
              })}
            </span>
          )}
          <span className="chip">{t("pl.pf.rebalances", { n: String(result.portfolio.rebalances) })}</span>
        </div>
      )}
    </>
  );
}
