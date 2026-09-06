import type { PipelineConfig, PipelineHistory, PipelineSignalWeighting } from "../../api";
import type { MsgKey } from "../../i18n";

export const FORM_KEY = "aiquant.pipeline.form";
/** V3: how many runs this browser has made, sent as `prior_trials` so the
 * Deflated Sharpe penalises repeated tinkering honestly. */
export const TRIALS_KEY = "aiquant.pipeline.trials";
/** V4: the last successful run, restored on mount so a reload does not lose
 * the numbers (and the Markdown report) the user was looking at. */
export const LAST_KEY = "aiquant.pipeline.last";
export const STAGE_COUNT = 6;

/** V2 select options; used when the server predates `config.signal_weightings`. */
export const SIGNAL_WEIGHTINGS: PipelineSignalWeighting[] = ["ic_expanding", "ic", "equal"];
export const IC_HORIZONS = [1, 2, 3, 5, 10, 15, 20];
/** V5 fallbacks for a pre-V5 config. */
export const HISTORIES: PipelineHistory[] = ["3y", "5y"];
export const SYMBOL_LIMITS: [number, number] = [8, 40];
/** V5: where the terminal's watchlist tab keeps its ticker arrays, per market. */
export const WATCHLIST_KEYS: Record<string, string> = { us: "aiquant.watchlist", crypto: "aiquant.watchlist.crypto" };
/** V5: `min_trade_pct` bounds per the contract. */
export const MIN_TRADE_RANGE: [number, number] = [0, 5];

/** Pre-config placeholder: the page must be usable before (or without) the
 * config request, so the contract's scheme ids and defaults live here too.
 * Real config overrides all of it the moment it arrives. */
export const FALLBACK_CONFIG: PipelineConfig = {
  markets: ["us", "crypto"],
  universes: { us: [], crypto: [] },
  schemes: [
    { id: "equal", zh: "等权 Top-N", en: "Equal-weight Top-N", desc_zh: "入选标的等权，最简单也最难被过拟合", desc_en: "Equal weight across selected names — the hardest baseline to beat" },
    { id: "score", zh: "信号加权", en: "Score-weighted", desc_zh: "权重随合成信号强弱变化", desc_en: "Weights scale with composite signal strength" },
    { id: "inverse_vol", zh: "波动率倒数", en: "Inverse volatility", desc_zh: "波动越低权重越高，拉平各标的风险贡献", desc_en: "Lower-volatility names get more weight, levelling risk contributions" },
    { id: "min_variance", zh: "最小方差", en: "Minimum variance", desc_zh: "用协方差矩阵求组合波动最低的权重", desc_en: "Solves the covariance matrix for the lowest portfolio variance" },
    { id: "risk_parity", zh: "风险平价", en: "Risk parity", desc_zh: "每个标的贡献相同份额的组合风险", desc_en: "Every name contributes the same share of portfolio risk" },
    { id: "hrp", zh: "层次风险平价 HRP", en: "Hierarchical Risk Parity", desc_zh: "按相关性聚类后自上而下分配风险，无需求逆协方差矩阵", desc_en: "Clusters names by correlation and splits risk top-down — no covariance inversion" },
    { id: "mean_variance", zh: "均值-方差（Grinold α）", en: "Mean-variance (Grinold alpha)", desc_zh: "把信号换算成 α，与协方差一起求最优权重；最激进，也最依赖信号质量", desc_en: "Turns the signal into alpha and optimises it against covariance — the most aggressive, and the most signal-dependent" },
  ],
  signal_weightings: SIGNAL_WEIGHTINGS,
  histories: HISTORIES,
  starter_factors: { us: [], crypto: [] },
  defaults: {
    scheme: "inverse_vol",
    signal_weighting: "ic_expanding",
    top_n: 8,
    rebalance: 10,
    max_weight: 0.25,
    cost_bps: 7,
    target_vol_pct: null,
    vol_lookback: 60,
    horizon: 10,
    hold_buffer: 4,
    trade_rate: 1,
    shrink_to_equal: 0,
    history: "3y",
  },
  limits: {
    factors: [1, 8],
    top_n: [2, 20],
    rebalance: [1, 30],
    max_weight: [0.05, 1],
    cost_bps: [0, 50],
    target_vol_pct: [5, 40],
    vol_lookback: [20, 120],
    hold_buffer: [0, 20],
    trade_rate: [0.1, 1],
    shrink_to_equal: [0, 1],
    prior_trials: [0, 10000],
    symbols: SYMBOL_LIMITS,
  },
};

/** V3 group ids with a translation; anything else prints as its raw id. */
export const SECTOR_IDS = new Set([
  "tech", "communication", "consumer", "staples", "financials", "health", "industrials", "energy",
  "utilities_realestate", "layer1", "layer2", "payments", "defi_infra", "meme", "other",
]);
export const REGIME_IDS = new Set(["low_vol", "mid_vol", "high_vol", "uptrend", "downtrend"]);
/** Segment colours for the sector stack, cycled when a book spans more groups. */
export const STACK_COLORS = [
  "rgba(59, 224, 255, 0.7)",
  "rgba(167, 139, 250, 0.7)",
  "rgba(255, 176, 0, 0.7)",
  "rgba(61, 220, 132, 0.7)",
  "rgba(255, 92, 108, 0.7)",
  "rgba(59, 224, 255, 0.4)",
  "rgba(167, 139, 250, 0.4)",
  "rgba(255, 176, 0, 0.4)",
  "rgba(61, 220, 132, 0.4)",
];

export const WARNING_KEYS: Record<string, MsgKey> = {
  holdout_sharpe_collapsed: "pl.warn.holdout_sharpe_collapsed",
  high_turnover: "pl.warn.high_turnover",
  few_rebalances: "pl.warn.few_rebalances",
  concentrated: "pl.warn.concentrated",
  low_coverage: "pl.warn.low_coverage",
  low_psr: "pl.warn.low_psr",
  not_significant: "pl.warn.not_significant",
  parameter_spike: "pl.warn.parameter_spike",
  low_capacity: "pl.warn.low_capacity",
};
