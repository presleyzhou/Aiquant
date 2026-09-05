export interface Quote {
  symbol: string;
  price?: number;
  change?: number;
  change_pct?: number;
  previous_close?: number;
  day_high?: number;
  day_low?: number;
  volume?: number;
  currency?: string;
  as_of?: string;
  error?: string;
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface FactorBacktestResult {
  expression: string;
  market: string;
  top_n: number;
  rebalance: number;
  inverted: boolean;
  span: { from: string; to: string };
  stats: {
    total_return_pct: number;
    cagr_pct: number | null;
    sharpe: number;
    max_drawdown_pct: number;
    avg_turnover_pct: number;
    benchmark: { total_return_pct: number; cagr_pct: number | null; sharpe: number };
  };
  equity_curve: Point[];
  benchmark_curve: Point[];
  drawdown_curve: Point[];
}

export interface FactorCheck {
  expression: string;
  market: string;
  horizon: number;
  is_ic: number;
  oos_ic: number;
  recent_ic: number;
  recent_days: number;
  days: number;
  as_of: string;
}

export interface FactorReport {
  expression: string;
  market: string;
  horizon: number;
  top_n: number;
  cost_bps: number;
  sign: number;
  days: number;
  as_of: string;
  complexity: number;
  mean_ic: number;
  icir: number;
  t_stat: number;
  t_stat_adj: number;
  quantiles: Array<{ q: number; ret_pct: number }>;
  spread_pct: number;
  monotonicity: number;
  ic_decay: Array<{ horizon: number; ic: number }>;
  best_horizon: number;
  turnover: number;
  rank_autocorr: number;
  cost_pct: number;
  spread_after_cost_pct: number;
  spread_after_cost_ann_pct: number;
  folds: Array<{ fold: number; from: string; to: string; ic: number; icir: number }>;
  positive_folds: number;
  regimes: { up_ic: number | null; down_ic: number | null; up_days: number; down_days: number };
  grades: Record<"predictive" | "stability" | "robustness" | "tradability" | "significance", "A" | "B" | "C">;
  suggestions: Array<{ code: string; value: number | string | null }>;
}

export interface MarginalResult {
  candidate: string;
  n_others: number;
  without: { sharpe: number; cagr_pct: number; max_drawdown_pct: number; excess_pct: number };
  with: { sharpe: number; cagr_pct: number; max_drawdown_pct: number; excess_pct: number };
  sharpe_delta: number;
  corr_with_blend: number | null;
  verdict: "adds" | "neutral" | "hurts";
}

export interface CompositeResult extends Omit<FactorBacktestResult, "expression" | "inverted"> {
  weighting: string;
  components: Array<{ expression: string; is_ic: number; weight: number }>;
  max_pair_corr: number;
}

export interface NewsArticle {
  title: string;
  url: string;
  publisher: string;
  published: string;
}

export interface NewsSummary {
  symbol: string;
  stance: "bullish" | "bearish" | "neutral" | "mixed";
  summary: string;
  article_count: number;
  cached: boolean;
}

export interface PaperStats {
  return_pct: number;
  bench_return_pct: number;
  excess_pct: number;
  max_drawdown_pct: number;
  current_drawdown_pct: number;
  sharpe: number | null;
  ann_vol_pct: number | null;
  win_rate_pct: number | null;
  bars: number;
  last_7d_pct: number | null;
  last_30d_pct: number | null;
  from?: string;
  to?: string;
}

export interface PaperTrack {
  kind: string;
  started_at: string;
  as_of: string;
  days_live: number;
  equity_curve: Point[];
  benchmark_curve: Point[];
  stats: PaperStats;
  pre: PaperStats;
  decay: { verdict: "holding" | "degraded" | "improved" | "insufficient"; sharpe_delta: number | null; excess_delta: number | null };
  position: {
    state: "long" | "flat" | "holdings" | "unknown";
    symbols?: string[];
    /** Pipeline deployments: per-symbol target weights, aligned with `symbols`. */
    weights_pct?: number[];
    since?: string;
  };
  trades_live: number | null;
  daily_returns: Array<{ time: number; ret_pct: number }>;
}

export interface FactorExplanation {
  expression: string;
  meaning: string;
  style: string;
  caveat: string;
  cached: boolean;
}

export interface AiStatus {
  enabled: boolean;
  model: string | null;
  effort: string | null;
  light_model?: string | null;
  usage_today?: {
    day: string;
    calls: number;
    input_tokens: number;
    output_tokens: number;
    by_model: Record<string, { calls: number; input_tokens: number; output_tokens: number }>;
  };
  limits?: Record<string, number>;
}

export interface KronosBar {
  time: number;
  close: number;
  high: number;
  low: number;
}

export interface KronosForecast {
  symbol: string;
  market: "us" | "crypto";
  model: string;
  device: string;
  horizon: number;
  preset: {
    calendar: string;
    temperature: number;
    top_p: number;
    sample_count: number;
    context_bars: number;
  };
  history: Array<{ time: number; close: number }>;
  forecast: KronosBar[];
  summary: {
    last_close: number;
    pred_close: number;
    change_pct: number | null;
    pred_max: number;
    pred_min: number;
    up_days: number;
  };
}

export interface KronosEvalRow {
  date: string;
  pred_change_pct: number;
  actual_change_pct: number;
  hit: boolean;
}

export interface KronosEvaluation {
  symbol: string;
  market: string;
  model: string;
  horizon: number;
  n: number;
  span: { from: string; to: string };
  hit_rate_pct: number;
  always_up_hit_rate_pct: number;
  mae_pct_points: number;
  rows: KronosEvalRow[];
}

export interface KronosStatus {
  enabled: boolean;
  loaded: boolean;
  model: string | null;
  device: string | null;
  error: string | null;
}

export interface Point {
  time: number;
  value: number;
}

export interface BacktestStats {
  initial_capital: number;
  final_equity: number;
  total_return_pct: number;
  cagr_pct: number;
  annual_volatility_pct: number;
  sharpe: number;
  sortino: number;
  max_drawdown_pct: number;
  trade_count: number;
  win_rate_pct: number;
  profit_factor: number | null;
  avg_win: number;
  avg_loss: number;
  buy_hold_return_pct: number;
  excess_vs_buy_hold_pct: number;
  bars: number;
}

export interface BacktestResult {
  symbol: string;
  strategy: string;
  period: string;
  stats: BacktestStats;
  equity_curve: Point[];
  benchmark_curve: Point[];
  drawdown_curve: Point[];
  trades: Array<{
    entry_time: number;
    exit_time: number | null;
    entry_price: number;
    exit_price: number | null;
    shares: number;
    pnl: number | null;
    return_pct: number | null;
  }>;
}

export interface MarketItem {
  id: string;
  type: "strategy" | "skill" | "data" | "factor";
  name: string;
  tagline: string;
  description: string;
  author: string;
  version: string;
  tags: string[];
  tier: "free" | "key_required" | "planned" | "paid";
  risk: "low" | "medium" | "high" | null;
  integration: {
    backtest?: Record<string, unknown>;
    prompt_template?: string;
    connector?: string;
    env_key?: string;
    factor?: FactorPayload;
  };
  status?: { state: string; label: string };
  price: { amount: string; currency: string } | null;
  /** Community (user-listed) item fields. */
  community?: boolean;
  locked?: boolean;
  payout_method?: string;
  sales?: number;
  created_at?: number;
}

export interface FactorPayload {
  expression: string;
  market: string;
  horizon: number;
  is_ic?: number;
  is_icir?: number;
  oos_ic?: number;
  hypothesis?: string;
}

export interface MyListing extends Omit<MarketItem, "status"> {
  status: string;
  demo_sales: number;
  gross_usd: number;
  net_usd: number;
  payout: { method: string; address?: string; asset?: string; stripe_account?: string };
}

export interface ListingCreate {
  seller_secret: string;
  type: "strategy" | "factor";
  name: string;
  tagline: string;
  description: string;
  author: string;
  tags: string[];
  price_usd: number;
  risk?: "low" | "medium" | "high" | null;
  payload: Record<string, unknown>;
  payout: { method: "none" | "crypto" | "stripe"; address?: string; asset?: string; stripe_account?: string };
}

export interface SymbolHit {
  symbol: string;
  name: string;
  exchange: string;
  source: "local" | "yahoo";
}

export interface PaymentConfig {
  methods: { card: boolean; crypto: boolean };
  providers: { card: string | null; crypto: string | null };
  demo: boolean;
  connect: boolean;
  platform_fee_pct: number;
  persistence: "kv" | "file";
  note: string;
  provider: string;
  real: boolean;
}

export type PayMethod = "card" | "crypto";

export interface Checkout {
  order_id: string;
  provider: string;
  method: PayMethod;
  status: "pending" | "confirmed" | "failed";
  demo: boolean;
  item_id: string;
  amount: string;
  currency: string;
  hosted_url: string | null;
  expires_at?: string | number;
}

export interface OrderStatus {
  order_id: string;
  provider: string;
  status: "pending" | "confirmed" | "failed";
  demo: boolean;
  item_id?: string;
  token?: string;
  wallet?: Wallet;
}

export interface WalletEntry {
  id: string;
  kind: "topup" | "purchase" | "sale" | "withdraw";
  amount: number;
  demo: boolean;
  ref: string;
  note: string;
  at: number;
}

export interface Wallet {
  balance_usd: number;
  demo_usd: number;
  entries: WalletEntry[];
}

export interface TopUpCheckout extends Omit<Checkout, "item_id"> {
  kind: "topup";
}

/** @deprecated legacy crypto-only shape; kept for older callers. */
export interface Charge extends OrderStatus {
  charge_id: string;
  hosted_url: string | null;
}

/* ------------------------------------------------ end-to-end pipeline ---
 * Mirrors backend/PIPELINE_CONTRACT.md exactly: data panel → factor DSL →
 * composite signal → portfolio construction → risk/attribution → paper. */

export interface PipelineFactorSpec {
  expression: string;
  invert: boolean;
  horizon: number;
}

export interface PipelineStarterFactor extends PipelineFactorSpec {
  zh: string;
  en: string;
}

export interface PipelineScheme {
  id: string;
  zh: string;
  en: string;
  desc_zh: string;
  desc_en: string;
}

export type PipelineLimitKey =
  | "factors"
  | "top_n"
  | "rebalance"
  | "max_weight"
  | "cost_bps"
  | "target_vol_pct"
  | "vol_lookback"
  | "hold_buffer"
  | "trade_rate"
  | "shrink_to_equal"
  | "prior_trials";

/** V2: `ic_expanding` re-estimates factor weights on an expanding window so
 * every daily weight is out-of-sample; `ic` fixes them on the first 80%. */
export type PipelineSignalWeighting = "ic_expanding" | "ic" | "equal";

/** V5: panel depth. 5y (or any custom list) takes the slower custom-download path. */
export type PipelineHistory = "3y" | "5y";

export interface PipelineConfig {
  markets: string[];
  universes: Record<string, string[]>;
  schemes: PipelineScheme[];
  /** V2; absent on a V1 server, in which case the UI falls back to the three ids. */
  signal_weightings?: PipelineSignalWeighting[];
  starter_factors: Record<string, PipelineStarterFactor[]>;
  /** V3: group (sector) label per universe symbol, e.g. AAPL → "tech", BTC-USD → "layer1". */
  sectors?: Record<string, string>;
  /** V5: history lengths the server accepts; absent on a pre-V5 server. */
  histories?: PipelineHistory[];
  defaults: {
    scheme: string;
    signal_weighting: PipelineSignalWeighting;
    top_n: number;
    rebalance: number;
    max_weight: number;
    cost_bps: number;
    target_vol_pct: number | null;
    vol_lookback: number;
    horizon: number;
    hold_buffer?: number;
    trade_rate?: number;
    /** V3: blend toward 1/N; 0 = off. */
    shrink_to_equal?: number;
    /** V5: default panel depth (3y). */
    history?: PipelineHistory;
  };
  /** V5: `symbols` = [min, max] size of a custom universe; absent on a pre-V5 server. */
  limits: Record<PipelineLimitKey, [number, number]> & { symbols?: [number, number] };
}

export interface PipelineRunRequest {
  market: string;
  factors: PipelineFactorSpec[];
  signal_weighting?: PipelineSignalWeighting;
  scheme?: string;
  top_n?: number;
  rebalance?: number;
  max_weight?: number;
  cost_bps?: number;
  target_vol_pct?: number | null;
  vol_lookback?: number;
  /** A held name stays while ranked within top_n + buffer; 0 = plain Top-N. */
  hold_buffer?: number;
  /** Fraction of the distance to target traded per rebalance (0.1–1.0); 1 = full. */
  trade_rate?: number;
  /** V3: blend the scheme's weights toward 1/N (DeMiguel-Garlappi-Uppal 2009); 0 = off. */
  shrink_to_equal?: number;
  /** V3: pipeline runs already made in this browser; added to the Deflated Sharpe's N. */
  prior_trials?: number;
  compare?: boolean;
  /** V5: custom universe of 8–40 Yahoo tickers; omitted = the built-in universe of `market`.
   * Server uppercases, dedupes and validates (400 with `detail`). Cached 6 h, so the first run is slower. */
  symbols?: string[];
  /** V5: panel depth, default 3y. */
  history?: PipelineHistory;
}

export interface PipelineSplitStats {
  from: string;
  to: string;
  total_return_pct: number;
  sharpe: number;
  max_drawdown_pct: number;
  excess_pct: number;
  /** Probabilistic Sharpe of this split alone (holdout only in practice). */
  psr?: number | null;
}

export interface PipelineAlternative {
  scheme: string;
  total_return_pct: number;
  sharpe: number;
  psr?: number | null;
  max_drawdown_pct: number;
  ann_vol_pct: number;
  avg_turnover_pct: number;
  /** V3.1: annualised Sharpe minus the equal-weight scheme's (0 on the equal row). */
  delta_sharpe_vs_equal_ann?: number;
  /** V3.1: two-sided Ledoit-Wolf (2008) block-bootstrap p-value for ΔSharpe = 0; null on the equal row. */
  p_value_vs_equal?: number | null;
}

export interface PipelineContributor {
  symbol: string;
  contribution_pct: number;
  avg_weight_pct: number;
  days_held: number;
}

/** V3 signal check (Qlib-style): equal-weight, daily, gross-of-cost return of
 * each composite-score quintile; bucket 1 = lowest score, 5 = highest. */
export interface PipelineQuantiles {
  buckets: Array<{ bucket: number; ann_return_pct: number | null }>;
  /** Bucket 5 minus bucket 1, annualised. */
  spread_ann_pct: number | null;
  spread_sharpe: number | null;
  /** Bucket returns rise with the score. */
  monotonic: boolean | null;
}

export type PipelineRegimeId = "low_vol" | "mid_vol" | "high_vol" | "uptrend" | "downtrend";

/** Benchmark 60-day realised-vol terciles and trend (above / below its 100-day average). */
export interface PipelineRegime {
  regime: PipelineRegimeId | string;
  days: number;
  ann_return_pct: number | null;
  bench_ann_return_pct: number | null;
  sharpe: number | null;
  hit_rate_pct: number | null;
}

/** Brinson-Fachler vs the equal-weight benchmark, summed over days. */
export interface PipelineAttribution {
  allocation_pct: number;
  selection_pct: number;
  interaction_pct: number;
  groups: PipelineAttributionGroup[];
}

export interface PipelineAttributionGroup {
  group: string;
  avg_weight_pct: number;
  bench_weight_pct: number;
  allocation_pct: number;
  selection_pct: number;
}

/** V4 one configuration of the parameter-sensitivity grid. */
export interface PipelineSensitivityCell {
  sharpe: number;
  excess_pct: number;
  max_drawdown_pct: number;
}

/** V4 3×3 neighbourhood of the chosen (top_n, rebalance): rows follow
 * `top_n`, columns follow `rebalance`; a null cell could not be simulated.
 * `spike` = chosen Sharpe minus the grid median — above 0.5 the server also
 * emits the `parameter_spike` warning. */
export interface PipelineSensitivity {
  top_n: number[];
  rebalance: number[];
  cells: Array<Array<PipelineSensitivityCell | null>>;
  median_sharpe: number | null;
  min_sharpe: number | null;
  spike: number | null;
}

export interface PipelineTargetWeight {
  symbol: string;
  weight_pct: number;
  score_rank: number;
  /** V3 sector / group id. */
  group?: string;
}

/** V6 per-symbol data health; sorted by coverage ascending (worst first).
 * `gaps` = missing prints between `first` and `last`; `stale` = stopped
 * printing before the panel's last date (delisted / halted / bad ticker). */
export interface PipelineHealthRow {
  symbol: string;
  group: string;
  /** 0 for an all-NaN symbol, whose `first` / `last` are then null. */
  coverage_pct: number;
  gaps: number;
  first: string | null;
  last: string | null;
  /** V6.1: true only when `stale_days` > 3, so a partial newest bar is not flagged. */
  stale: boolean;
  /** V6.1: bars since the last print. */
  stale_days?: number;
}

/** V6 capacity curve. Market impact per trade follows the square-root law
 * (Almgren et al. 2005): cost = σ_daily · √(traded notional / 20-day ADV).
 * For each AUM the annualised drag (% of NAV) is subtracted from the
 * annualised excess over the equal-weight benchmark. `breakeven_aum` is the
 * AUM at which net excess reaches zero — null when excess ≤ 0 or no trades.
 * Every entry of the three per-AUM arrays is nullable. */
export interface PipelineCapacity {
  aum_grid: number[];
  impact_drag_pct_ann: Array<number | null>;
  net_excess_pct_ann: Array<number | null>;
  /** Average traded notional as % of ADV. */
  participation_pct: Array<number | null>;
  excess_pct_ann: number | null;
  breakeven_aum: number | null;
  /** V6.1: share of traded weight that had usable liquidity data; names
   * without volume borrow the day's median ADV. */
  costed_trade_pct?: number | null;
  model: "sqrt_impact" | string;
}

export interface PipelineResult {
  spec: PipelineRunRequest;
  universe: {
    market: string;
    symbols: number;
    from: string;
    to: string;
    bars: number;
    /** V5: true when the run used a custom ticker list. */
    custom?: boolean;
    history?: PipelineHistory | string;
    /** V5: tickers requested; null for built-in universes. */
    requested?: number | null;
    /** V5: requested tickers Yahoo could not deliver or that failed the sanity filter. */
    dropped?: string[];
    /** V6: per-symbol coverage, worst first; absent on a pre-V6 server. */
    health?: PipelineHealthRow[];
  };
  signal: {
    weighting: string;
    components: Array<
      PipelineFactorSpec & {
        is_ic: number;
        oos_ic: number;
        /** Latest weight (what the target book uses). */
        weight: number;
        /** Mean weight over the backtest — differs from `weight` under `ic_expanding`. */
        avg_weight?: number;
        standalone_sharpe: number;
        /** V4: share of post-warm-up days on which the factor carried a non-zero
         * weight; under `ic_expanding` a factor whose expanding IC sits within
         * ±0.005 of zero is switched off. Static weightings report 100. */
        active_pct?: number;
      }
    >;
    max_pair_corr: number;
    /** Information-horizon (alpha decay) curve of the composite signal. */
    ic_by_horizon?: Array<{ horizon: number; ic: number | null }>;
    composite_is_ic?: number;
    composite_oos_ic?: number | null;
    /** V3 quintile check of the composite score. */
    quantiles?: PipelineQuantiles;
    /** V6: n×n pairwise rank correlation of the selected factors in component
     * order; null where a pair has too little overlap; diagonal is 1.0. */
    corr_matrix?: Array<Array<number | null>>;
  };
  portfolio: {
    scheme: string;
    top_n: number;
    max_weight: number;
    rebalance: number;
    cost_bps: number;
    target_vol_pct: number | null;
    vol_lookback: number;
    avg_effective_n: number;
    avg_exposure_pct: number;
    avg_turnover_pct: number;
    rebalances: number;
    annual_turnover_x?: number;
    /** One-way cost per unit turnover at which excess over the benchmark is zero. */
    breakeven_cost_bps?: number | null;
    hold_buffer?: number;
    trade_rate?: number;
  };
  backtest: {
    span: { from: string; to: string };
    stats: {
      total_return_pct: number;
      cagr_pct: number | null;
      ann_vol_pct: number;
      sharpe: number;
      sortino: number;
      calmar: number;
      max_drawdown_pct: number;
      win_rate_pct: number;
      excess_pct: number;
      beta: number;
      tracking_error_pct: number;
      information_ratio: number;
      /** V4: share of rolling 126-day windows that out-compounded the
       * equal-weight benchmark; null when the history is too short. */
      rolling_6m_beat_pct?: number | null;
      benchmark: {
        total_return_pct: number;
        cagr_pct: number | null;
        ann_vol_pct: number;
        sharpe: number;
        max_drawdown_pct: number;
      };
    };
    in_sample: PipelineSplitStats;
    holdout: PipelineSplitStats;
    /** Bailey & López de Prado: PSR = P(true Sharpe > 0); DSR deflates against
     * the best of `trials` unskilled configurations tried in this run. */
    overfitting?: {
      psr: number | null;
      dsr: number | null;
      trials: number;
      expected_max_sharpe_ann: number | null;
      /** V3: Sharpe × √T; Harvey-Liu-Zhu (2016) hurdle is 3.0, below 2 is not a finding. */
      t_stat?: number | null;
      hlz_hurdle?: number;
      /** Days needed for the Sharpe to be significant at 95%; null when Sharpe ≤ 0. */
      min_track_record_days?: number | null;
      track_days?: number;
    };
    equity_curve: Point[];
    benchmark_curve: Point[];
    drawdown_curve: Point[];
    exposure_curve: Point[];
    monthly_returns: Array<{ year: number; month: number; ret_pct: number; bench_pct: number }>;
    yearly_returns: Array<{ year: number; ret_pct: number; bench_pct: number }>;
  };
  risk: {
    drawdowns: Array<{ peak: string; trough: string; recovery: string | null; depth_pct: number; days: number }>;
    contributors: PipelineContributor[];
    detractors: PipelineContributor[];
    concentration: { avg_effective_n: number; cap_binding_pct: number };
    correlation_to_benchmark: number;
    /** Compounded return in benchmark-up (down) months ÷ the benchmark's. */
    capture?: { up: number | null; down: number | null; up_periods: number; down_periods: number };
    /** Expected shortfall: mean of the worst 5% daily returns. */
    cvar_95_pct?: number | null;
    bench_cvar_95_pct?: number | null;
    /** 60-day rolling beta to the equal-weight benchmark. */
    rolling_beta?: Point[];
    /** V3: may be empty on short histories. */
    regimes?: PipelineRegime[];
    attribution?: PipelineAttribution;
  };
  alternatives: PipelineAlternative[];
  /** V4: null when `compare` is false. */
  sensitivity?: PipelineSensitivity | null;
  /** V6: square-root-impact capacity curve; absent on a pre-V6 server. */
  capacity?: PipelineCapacity | null;
  target_weights: {
    as_of: string;
    exposure_pct: number;
    weights: PipelineTargetWeight[];
    /** V3: target book summed per sector / group. */
    groups?: Array<{ group: string; weight_pct: number }>;
  };
  warnings: string[];
}

/* ------------------------------------------------ V5 rebalance ticket ---
 * POST /api/pipeline/orders turns the latest target book into whole-share
 * orders against the user's current holdings. Sells come first (they fund
 * the buys); the ticket never shorts. */

export interface PipelineOrdersRequest {
  /** The same body as /run (market, symbols, history, factors, scheme, ...). */
  spec: PipelineRunRequest;
  /** Total portfolio value incl. cash, account currency, > 0. */
  nav: number;
  /** Shares currently held; omitted / empty = all cash. */
  current?: Record<string, number>;
  /** Suppress trades smaller than this % of NAV (0–5, default 0.25). */
  min_trade_pct?: number;
}

export interface PipelineOrder {
  symbol: string;
  side: "buy" | "sell";
  shares: number;
  price: number;
  notional: number;
  from_weight_pct: number;
  to_weight_pct: number;
  group?: string;
}

export interface PipelineOrders {
  /** Date of the target-weight decision (latest complete bar). */
  as_of: string;
  /** Date of the reference prices (last available close). */
  price_date: string;
  nav: number;
  orders: PipelineOrder[];
  /** Held symbols with no price in the panel (cannot be sized). */
  unpriced: string[];
  summary: {
    buys: number;
    sells: number;
    buy_notional: number;
    sell_notional: number;
    turnover_pct: number;
    est_cost: number;
    /** V5.1: null when `cash_unknown` (a held symbol could not be priced). */
    cash_before: number | null;
    cash_after: number | null;
    /** V5.1: true when `unpriced` is non-empty; cash_before / cash_after are then null. */
    cash_unknown?: boolean;
    target_exposure_pct: number;
  };
}

/* ---------------------------------------- AI investment-committee memo ---
 * Mirrors PIPELINE_CONTRACT_MEMO.md: the client sends exactly the summary it
 * displays (no curves — the body is capped at 12 kB server-side). */

export interface PipelineMemoRequest {
  spec: PipelineRunRequest;
  universe: PipelineResult["universe"];
  signal: {
    weighting: string;
    components: Array<{ expression: string; is_ic: number; oos_ic: number; weight: number; standalone_sharpe: number }>;
    max_pair_corr: number;
    ic_by_horizon?: Array<{ horizon: number; ic: number | null }>;
    composite_is_ic?: number;
    composite_oos_ic?: number | null;
    quantiles?: PipelineQuantiles;
  };
  portfolio: PipelineResult["portfolio"];
  stats: PipelineResult["backtest"]["stats"];
  in_sample: PipelineSplitStats;
  holdout: PipelineSplitStats;
  overfitting: PipelineResult["backtest"]["overfitting"];
  risk: {
    drawdowns: PipelineResult["risk"]["drawdowns"];
    contributors: PipelineContributor[];
    detractors: PipelineContributor[];
    concentration: PipelineResult["risk"]["concentration"];
    correlation_to_benchmark: number;
    capture?: PipelineResult["risk"]["capture"];
    cvar_95_pct?: number | null;
    bench_cvar_95_pct?: number | null;
    regimes?: PipelineRegime[];
    attribution?: PipelineAttribution;
  };
  warnings: string[];
  /** Current UI language — the memo is written in it. */
  lang: "zh" | "en";
}

export type PipelineMemoVerdict = "deploy" | "paper_first" | "iterate" | "reject";

export interface PipelineMemo {
  verdict: PipelineMemoVerdict;
  headline: string;
  strengths: string[];
  concerns: string[];
  next_steps: string[];
  honesty_note: string;
  model: string;
}

export type AIEvent =
  | { type: "thinking"; text: string }
  | { type: "text"; text: string }
  | { type: "tool_use"; name: string; input: unknown }
  | { type: "tool_result"; name: string; result: unknown }
  | { type: "refusal"; message: string; category?: string | null }
  | { type: "error"; message: string }
  | { type: "done"; stop_reason: string };

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.detail ?? `${res.status} ${res.statusText}`);
  }
  return res.json() as Promise<T>;
}

export const api = {
  health: () => fetch("/api/health").then(json<{ status: string; ai_enabled: boolean; model: string | null }>),

  quotes: (symbols: string[]) =>
    fetch(`/api/market/quotes?symbols=${encodeURIComponent(symbols.join(","))}`).then(
      json<{ quotes: Quote[] }>,
    ),

  candles: (symbol: string, period: string, interval?: string) =>
    fetch(
      `/api/market/candles/${encodeURIComponent(symbol)}?period=${period}${interval ? `&interval=${interval}` : ""}`,
    ).then(
      json<{ symbol: string; period: string; interval: string; candles: Candle[] }>,
    ),

  indicator: (symbol: string, name: string, history: string, period?: number) => {
    const qs = new URLSearchParams({ history });
    if (period) qs.set("period", String(period));
    return fetch(`/api/analytics/indicator/${encodeURIComponent(symbol)}/${name}?${qs}`).then(
      json<{ symbol: string; indicator: string; data: Point[] | Record<string, Point[]> }>,
    );
  },

  backtest: (body: Record<string, unknown>) =>
    fetch("/api/analytics/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<BacktestResult>),

  symbolNews: (symbol: string) =>
    fetch(`/api/market/news/${encodeURIComponent(symbol)}`).then(
      json<{ symbol: string; articles: NewsArticle[] }>,
    ),

  newsSummary: (symbol: string) =>
    fetch("/api/ai/news-summary", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ symbol }),
    }).then(json<NewsSummary>),

  paperTrack: (body: Record<string, unknown>) =>
    fetch("/api/paper/track", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<PaperTrack>),

  factorExplain: (expression: string, market: string) =>
    fetch("/api/factors/explain", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression, market }),
    }).then(json<FactorExplanation>),

  factorComposite: (body: Record<string, unknown>) =>
    fetch("/api/factors/composite", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<CompositeResult>),

  factorAnalyze: (expression: string, market: string, horizon: number, top_n = 5, cost_bps = 10) =>
    fetch("/api/factors/analyze", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression, market, horizon, top_n, cost_bps }),
    }).then(json<FactorReport>),

  factorMarginal: (body: {
    candidate: { expression: string; invert?: boolean; horizon?: number };
    others: Array<{ expression: string; invert?: boolean; horizon?: number }>;
    market: string;
    top_n?: number;
    rebalance?: number;
  }) =>
    fetch("/api/factors/marginal", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<MarginalResult>),

  factorCheck: (expression: string, market: string, horizon: number) =>
    fetch("/api/factors/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ expression, market, horizon }),
    }).then(json<FactorCheck>),

  factorBacktest: (body: Record<string, unknown>) =>
    fetch("/api/factors/backtest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<FactorBacktestResult>),

  kronosStatus: () => fetch("/api/kronos/status").then(json<KronosStatus>),

  kronosEvaluate: (symbol: string, horizon?: number) =>
    fetch("/api/kronos/evaluate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(horizon ? { symbol, horizon } : { symbol }),
    }).then(json<KronosEvaluation>),

  kronosForecast: (symbol: string, horizon?: number, interval: string = "1d") =>
    fetch("/api/kronos/forecast", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(horizon ? { symbol, horizon, interval } : { symbol, interval }),
    }).then(json<KronosForecast>),

  aiStatus: () =>
    fetch("/api/ai/status").then(
      json<AiStatus>,
    ),

  marketItems: (type?: string, q?: string) => {
    const qs = new URLSearchParams();
    if (type) qs.set("type", type);
    if (q) qs.set("q", q);
    const suffix = qs.toString() ? `?${qs}` : "";
    return fetch(`/api/marketplace/items${suffix}`).then(
      json<{ count: number; items: MarketItem[] }>,
    );
  },

  searchSymbols: (q: string, limit = 8) =>
    fetch(`/api/market/search?q=${encodeURIComponent(q)}&limit=${limit}`).then(
      json<{ query: string; results: SymbolHit[] }>,
    ),

  paymentConfig: () => fetch("/api/payments/config").then(json<PaymentConfig>),

  createCheckout: (item_id: string, method: PayMethod, return_url: string) =>
    fetch("/api/payments/checkout", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id, method, return_url }),
    }).then(json<Checkout>),

  orderStatus: (provider: string, order_id: string, item_id: string) =>
    fetch(
      `/api/payments/orders/${encodeURIComponent(provider)}/${encodeURIComponent(order_id)}?item_id=${encodeURIComponent(item_id)}`,
    ).then(json<OrderStatus>),

  confirmDemo: (order_id: string, item_id: string) =>
    fetch(`/api/payments/orders/demo/${encodeURIComponent(order_id)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ item_id }),
    }).then(json<OrderStatus>),

  connectOnboard: (email: string, return_url: string) =>
    fetch("/api/payments/connect/onboard", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ email: email || null, return_url }),
    }).then(json<{ account_id: string; url: string }>),

  createListing: (body: ListingCreate) =>
    fetch("/api/marketplace/listings", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<{ item: MarketItem; persistence: string }>),

  myListings: (seller_secret: string) =>
    fetch("/api/marketplace/listings/mine", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seller_secret }),
    }).then(json<{ listings: MyListing[]; persistence: string }>),

  removeListing: (id: string, seller_secret: string) =>
    fetch(`/api/marketplace/listings/${encodeURIComponent(id)}/remove`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ seller_secret }),
    }).then(json<{ removed: string }>),

  wallet: (account_secret: string) =>
    fetch("/api/wallet", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_secret }),
    }).then(json<Wallet>),

  walletTopUp: (account_secret: string, amount_usd: number, method: PayMethod, return_url: string) =>
    fetch("/api/wallet/topup", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_secret, amount_usd, method, return_url }),
    }).then(json<TopUpCheckout>),

  walletTopUpDemoConfirm: (order_id: string, account_secret: string, amount_usd: number) =>
    fetch(`/api/wallet/topup/demo/${encodeURIComponent(order_id)}/confirm`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_secret, amount_usd }),
    }).then(json<OrderStatus & { wallet: Wallet }>),

  walletPurchase: (account_secret: string, item_id: string) =>
    fetch("/api/wallet/purchase", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_secret, item_id }),
    }).then(json<OrderStatus & { wallet: Wallet }>),

  walletWithdraw: (account_secret: string, amount_usd: number, method: "crypto" | "bank", address: string) =>
    fetch("/api/wallet/withdraw", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ account_secret, amount_usd, method, address }),
    }).then(json<Wallet & { id: string; status: string; amount: number }>),

  pipelineConfig: () => fetch("/api/pipeline/config").then(json<PipelineConfig>),

  pipelineRun: (body: PipelineRunRequest) =>
    fetch("/api/pipeline/run", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<PipelineResult>),

  /** V5. 400 `{detail}` on a bad spec / shares / NAV, 404 when the universe download failed, 422 on schema. */
  pipelineOrders: (body: PipelineOrdersRequest) =>
    fetch("/api/pipeline/orders", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<PipelineOrders>),

  /** 503 when no AI key (check `aiStatus().enabled` first), 429 on rate limit, 502 on an empty model reply. */
  pipelineMemo: (body: PipelineMemoRequest) =>
    fetch("/api/pipeline/memo", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    }).then(json<PipelineMemo>),

  listingPayload: (id: string, token: string) =>
    fetch(`/api/marketplace/listings/${encodeURIComponent(id)}/payload?token=${encodeURIComponent(token)}`).then(
      json<{ id: string; integration: MarketItem["integration"] }>,
    ),
};

export interface WalkForwardFold {
  fold: number;
  train_start: string;
  train_end: string;
  test_start: string;
  test_end: string;
  train: Record<string, number>;
  test: Record<string, number>;
  beats_benchmark: boolean;
}

export interface WalkForwardReport {
  folds: WalkForwardFold[];
  aggregate: {
    folds: number;
    train_years: number;
    test_years: number;
    oos_return_pct: number;
    oos_buy_hold_return_pct: number;
    mean_test_sharpe: number;
    worst_fold_return_pct: number;
    folds_beating_benchmark: number;
  };
}

export interface StrategyProposal {
  name: string;
  symbol: string;
  strategy: string;
  params: Record<string, unknown>;
  rationale: string;
  in_sample?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  walk_forward?: WalkForwardReport;
  risks: string[];
  beats_buy_hold: boolean;
}

export interface StrategyForm {
  symbol: string;
  objective: string;
  validation_period: string;
  notes: string;
}

/** Stream an NDJSON endpoint, invoking `onEvent` per parsed line. */
export async function streamNDJSON(
  url: string,
  body: unknown,
  onEvent: (event: AIEvent) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal,
  });

  if (!res.ok || !res.body) {
    const body = await res.json().catch(() => ({}));
    const detail =
      typeof body.detail === "string" ? body.detail : body.detail ? JSON.stringify(body.detail) : null;
    throw new Error(detail ?? `${res.status} ${res.statusText}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    // The final chunk may end mid-line; keep the remainder for the next read.
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        onEvent(JSON.parse(line) as AIEvent);
      } catch {
        // A malformed line is not worth killing the whole stream over.
      }
    }
  }
  if (buffer.trim()) {
    try {
      onEvent(JSON.parse(buffer) as AIEvent);
    } catch {
      /* ignore trailing partial */
    }
  }
}

export const streamAnalysis = (
  messages: Array<{ role: string; content: string }>,
  onEvent: (event: AIEvent) => void,
  signal?: AbortSignal,
) => streamNDJSON("/api/ai/analyze", { messages }, onEvent, signal);

export const streamStrategy = (
  form: StrategyForm,
  onEvent: (event: AIEvent) => void,
  signal?: AbortSignal,
) => streamNDJSON("/api/ai/strategy", form, onEvent, signal);
