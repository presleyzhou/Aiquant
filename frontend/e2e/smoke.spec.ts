import { expect, test, type Page } from "@playwright/test";

/** Critical-path smoke: open → tabs → watchlist renders → run a backtest.
 * All /api/* traffic is mocked so the suite is hermetic (no backend, no
 * network, no keys) — it guards the FRONTEND against regressions. */

const candles = (n = 120) => {
  const start = 1_690_000_000;
  return Array.from({ length: n }, (_, i) => {
    const base = 100 + Math.sin(i / 9) * 8 + i * 0.05;
    return {
      time: start + i * 86_400,
      open: base,
      high: base * 1.01,
      low: base * 0.99,
      close: base * 1.002,
      volume: 1_000_000 + (i % 7) * 50_000,
    };
  });
};

const curve = (n = 120, drift = 40) =>
  Array.from({ length: n }, (_, i) => ({
    time: 1_690_000_000 + i * 86_400,
    value: 100_000 + i * (drift * 1000 / n),
  }));

async function mockApi(page: Page) {
  await page.route("**/api/**", async (route) => {
    const url = new URL(route.request().url());
    const path = url.pathname;
    const json = (body: unknown) => route.fulfill({ json: body as object });

    if (path === "/api/ai/status") return json({ enabled: false, model: null, effort: null });
    if (path === "/api/kronos/status")
      return json({ enabled: false, loaded: false, model: null, device: null, error: null, mode: "off" });
    if (path.startsWith("/api/marketplace/items"))
      return json({
        items: [
          {
            id: "golden-cross",
            type: "strategy",
            name: "黄金交叉 50/200",
            tagline: "最经典的长周期趋势跟随",
            tags: ["趋势"],
            price: 0,
            currency: "USDC",
            risk: "low",
            author: "AIQUANT",
            version: "1.0",
            payload: { strategy: "sma_cross", fast: 50, slow: 200 },
          },
          {
            id: "trend-sniper-pro",
            type: "strategy",
            name: "趋势狙击 Pro 10/40",
            tagline: "付费策略（测试）",
            description: "测试",
            author: "AIQUANT",
            version: "1.0",
            tags: ["趋势"],
            tier: "paid",
            risk: "medium",
            integration: { backtest: { strategy: "ema_cross", fast: 10, slow: 40 } },
            price: { amount: "4.99", currency: "USD" },
          },
        ],
      });
    if (path === "/api/factors/config")
      return json({ universes: { us: ["AAPL"], crypto: ["BTC-USD"] }, defaults: {}, modes: {} });
    if (path === "/api/market/quotes") {
      const symbols = (url.searchParams.get("symbols") ?? "").split(",").filter(Boolean);
      return json({
        quotes: symbols.map((symbol) => ({
          symbol,
          price: 123.45,
          change: 1.23,
          change_pct: 1.01,
          as_of: new Date().toISOString(),
        })),
      });
    }
    if (path.startsWith("/api/market/news/"))
      return json({
        symbol: path.split("/").pop(),
        articles: [
          { title: "测试头条：市场观望", url: "https://example.com/n1", publisher: "TestWire", published: "" },
        ],
      });
    if (path.startsWith("/api/market/candles/"))
      return json({
        symbol: path.split("/").pop(),
        period: "6mo",
        interval: "1d",
        candles: candles(),
      });
    if (path === "/api/analytics/backtest")
      return json({
        symbol: "AAPL",
        strategy: "sma_cross",
        period: "2y",
        stats: {
          total_return_pct: 12.34,
          excess_vs_buy_hold_pct: -1.5,
          cagr_pct: 6.1,
          sharpe: 0.88,
          sortino: 1.1,
          max_drawdown_pct: -14.2,
          win_rate_pct: 52.0,
          profit_factor: 1.4,
          trade_count: 9,
          buy_hold_return_pct: 13.84,
        },
        equity_curve: curve(),
        benchmark_curve: curve(120, 44),
        drawdown_curve: curve(120, 0).map((p) => ({ ...p, value: -2 })),
        trades: [
          { entry_time: 1_690_000_000, entry_price: 100, exit_time: 1_695_000_000, exit_price: 108, pnl: 800, return_pct: 8.0 },
        ],
      });
    if (path === "/api/factors/evolve")
      return route.fulfill({
        contentType: "application/x-ndjson",
        body: [
          { type: "start", market: "us", population: 20, generations: 3 },
          { type: "gen", gen: 3, generations: 3, best_fitness: 0.05, mean_fitness: 0.02, unique: 18, evaluated_total: 50, hof_size: 1, elapsed: 1.2,
            champion: { expression: "rank(delta(close, 5))", fitness: 0.05, is_ic: 0.051, sharpe: 1.23, total_return_pct: 33.3, cagr_pct: 12.1, max_drawdown_pct: -9.9, bench_return_pct: 20 } },
          { type: "done", market: "us", horizon: 10, generations: 3, evaluated_total: 50, elapsed: 1.2, history: [],
            discovered: [{ expression: "rank(delta(close, 5))", gen: 2, is_ic: 0.051, is_icir: 0.3, oos_ic: 0.04, complexity: 3, accepted: true, reasons: [], invert: false, total_return_pct: 33.3, cagr_pct: 12.1, sharpe: 1.23, max_drawdown_pct: -9.9, bench_return_pct: 20 }] },
        ].map((e) => JSON.stringify(e)).join("\n") + "\n",
      });
    if (path === "/api/pipeline/config")
      return json({
        markets: ["us", "crypto"],
        universes: { us: ["AAPL", "MSFT", "NVDA", "INTC"], crypto: ["BTC-USD", "ETH-USD"] },
        schemes: [
          { id: "equal", zh: "等权 Top-N", en: "Equal-weight Top-N", desc_zh: "入选标的等权", desc_en: "Equal weight" },
          { id: "score", zh: "信号加权", en: "Score-weighted", desc_zh: "按信号强弱", desc_en: "By signal strength" },
          { id: "inverse_vol", zh: "波动率倒数", en: "Inverse volatility", desc_zh: "波动越低权重越高", desc_en: "Lower vol, more weight" },
          { id: "min_variance", zh: "最小方差", en: "Minimum variance", desc_zh: "最低组合波动", desc_en: "Lowest variance" },
          { id: "risk_parity", zh: "风险平价", en: "Risk parity", desc_zh: "风险贡献相同", desc_en: "Equal risk contribution" },
          { id: "hrp", zh: "层次风险平价 HRP", en: "Hierarchical Risk Parity", desc_zh: "相关性聚类分配风险", desc_en: "Cluster-based risk split" },
          { id: "mean_variance", zh: "均值-方差（Grinold α）", en: "Mean-variance (Grinold alpha)", desc_zh: "α 对协方差最优化", desc_en: "Alpha vs covariance" },
        ],
        signal_weightings: ["ic_expanding", "ic", "equal"],
        // V5: custom-universe size bounds and the history lengths
        histories: ["3y", "5y"],
        starter_factors: {
          us: [
            { expression: "neg(delta(close, 5) / ts_std(returns, 20))", zh: "短期反转", en: "Short-term reversal", invert: false, horizon: 10 },
            { expression: "rank(ts_mean(returns, 60))", zh: "中期动量", en: "Medium-term momentum", invert: false, horizon: 10 },
          ],
          crypto: [
            { expression: "rank(ts_mean(returns, 30))", zh: "月度动量", en: "Monthly momentum", invert: false, horizon: 10 },
          ],
        },
        // V3: sector per universe symbol
        sectors: { AAPL: "tech", MSFT: "tech", NVDA: "tech", INTC: "financials", "BTC-USD": "layer1", "ETH-USD": "layer1" },
        defaults: { scheme: "inverse_vol", signal_weighting: "ic_expanding", top_n: 8, rebalance: 10, max_weight: 0.25, cost_bps: 7,
          target_vol_pct: null, vol_lookback: 60, horizon: 10, hold_buffer: 4, trade_rate: 1.0, shrink_to_equal: 0.0, history: "3y" },
        limits: { factors: [1, 8], top_n: [2, 20], rebalance: [1, 30], max_weight: [0.05, 1.0], cost_bps: [0, 50],
          target_vol_pct: [5, 40], vol_lookback: [20, 120], hold_buffer: [0, 20], trade_rate: [0.1, 1.0],
          shrink_to_equal: [0, 1], prior_trials: [0, 10000], symbols: [8, 40] },
      });
    if (path === "/api/pipeline/run") {
      const body = route.request().postDataJSON() as
        { factors?: unknown[]; scheme?: string; shrink_to_equal?: number; prior_trials?: number; symbols?: string[]; history?: string } | null;
      // V5: a custom list echoes back as `custom`; anything outside the fixture's known names is "dropped"
      const known = ["AAPL", "MSFT", "NVDA", "INTC", "AMZN", "GOOG", "META", "TSLA"];
      const custom = Array.isArray(body?.symbols) && body.symbols.length > 0;
      const dropped = custom ? body!.symbols!.filter((sym) => !known.includes(sym)) : [];
      const factors = Array.isArray(body?.factors) && body.factors.length > 0
        ? body.factors
        : [{ expression: "neg(delta(close, 5) / ts_std(returns, 20))", invert: false, horizon: 10 }];
      const scheme = body?.scheme ?? "inverse_vol";
      const split = (from: string, to: string, ret: number, sharpe: number) =>
        ({ from, to, total_return_pct: ret, sharpe, max_drawdown_pct: -9.5, excess_pct: ret - 20 });
      return json({
        spec: { market: "us", factors, signal_weighting: "ic_expanding", scheme, top_n: 8, rebalance: 10, max_weight: 0.25,
          cost_bps: 7, target_vol_pct: null, vol_lookback: 60, hold_buffer: 4, trade_rate: 1.0,
          shrink_to_equal: body?.shrink_to_equal ?? 0, prior_trials: body?.prior_trials ?? 0, compare: true,
          ...(custom ? { symbols: body!.symbols } : {}), history: body?.history ?? "3y" },
        universe: { market: "us", symbols: 4, from: "2023-09-05", to: "2026-09-03", bars: 752,
          custom, history: body?.history ?? "3y", requested: custom ? body!.symbols!.length : null, dropped },
        signal: {
          weighting: "ic_expanding",
          components: (factors as Array<{ expression: string; invert: boolean; horizon: number }>).map((f, i) => ({
            ...f, is_ic: 0.021 - i * 0.004, oos_ic: 0.012, weight: 1 / factors.length, avg_weight: 0.9 / factors.length,
            standalone_sharpe: 0.81,
            // V4: the first factor was gated off on ~17% of days, the rest always on
            active_pct: i === 0 ? 82.6 : 100 })),
          max_pair_corr: 0.31,
          // V2: alpha-decay curve (one null = too few samples) + composite ICs
          ic_by_horizon: [
            { horizon: 1, ic: 0.005 }, { horizon: 2, ic: 0.01 }, { horizon: 3, ic: -0.002 }, { horizon: 5, ic: 0.012 },
            { horizon: 10, ic: 0.018 }, { horizon: 15, ic: 0.021 }, { horizon: 20, ic: null },
          ],
          composite_is_ic: 0.011,
          composite_oos_ic: 0.008,
          // V3: quintile check — bucket 3 null, bucket 4 negative, so both edge cases render
          quantiles: {
            buckets: [
              { bucket: 1, ann_return_pct: 13.5 }, { bucket: 2, ann_return_pct: 18.2 }, { bucket: 3, ann_return_pct: null },
              { bucket: 4, ann_return_pct: -2.4 }, { bucket: 5, ann_return_pct: 31.3 },
            ],
            spread_ann_pct: 17.8, spread_sharpe: 0.94, monotonic: false,
          },
        },
        portfolio: { scheme, top_n: 8, max_weight: 0.25, rebalance: 10, cost_bps: 7, target_vol_pct: null, vol_lookback: 60,
          avg_effective_n: 6.4, avg_exposure_pct: 100.0, avg_turnover_pct: 3.1, rebalances: 60,
          annual_turnover_x: 12.9, breakeven_cost_bps: 52.1, hold_buffer: 4, trade_rate: 1.0 },
        backtest: {
          span: { from: "2023-12-01", to: "2026-09-03" },
          stats: { total_return_pct: 41.2, cagr_pct: 13.4, ann_vol_pct: 15.2, sharpe: 0.88, sortino: 1.21, calmar: 0.9,
            max_drawdown_pct: -14.9, win_rate_pct: 53.1, excess_pct: 6.3, beta: 0.82, tracking_error_pct: 6.1, information_ratio: 0.7,
            rolling_6m_beat_pct: 44.1, // V4: below 45 → red
            benchmark: { total_return_pct: 34.9, cagr_pct: 11.5, ann_vol_pct: 16.0, sharpe: 0.74, max_drawdown_pct: -18.2 } },
          in_sample: split("2023-12-01", "2025-09-01", 30.1, 1.02),
          holdout: { ...split("2025-09-02", "2026-09-03", 8.5, 0.61), psr: 0.906 },
          overfitting: { psr: 0.982, dsr: 0.859, trials: 9, expected_max_sharpe_ann: 0.7,
            t_stat: 2.1, hlz_hurdle: 3.0, min_track_record_days: 336, track_days: 540 },
          equity_curve: curve(),
          benchmark_curve: curve(120, 34),
          drawdown_curve: curve(120, 0).map((p) => ({ ...p, value: -2 })),
          exposure_curve: curve(120, 0).map((p) => ({ ...p, value: 100 })),
          monthly_returns: Array.from({ length: 20 }, (_, i) => ({
            year: 2024 + Math.floor(i / 12), month: (i % 12) + 1, ret_pct: ((i * 7) % 11) - 4, bench_pct: ((i * 5) % 9) - 3 })),
          yearly_returns: [{ year: 2024, ret_pct: 12.1, bench_pct: 9.7 }, { year: 2025, ret_pct: 15.3, bench_pct: 14.0 }],
        },
        risk: {
          drawdowns: [
            { peak: "2024-03-01", trough: "2024-04-10", recovery: "2024-06-02", depth_pct: -12.3, days: 40 },
            { peak: "2025-11-03", trough: "2026-01-20", recovery: null, depth_pct: -9.1, days: 78 },
          ],
          contributors: [{ symbol: "NVDA", contribution_pct: 4.2, avg_weight_pct: 10.1, days_held: 230 }],
          detractors: [{ symbol: "INTC", contribution_pct: -2.1, avg_weight_pct: 6.0, days_held: 120 }],
          concentration: { avg_effective_n: 6.4, cap_binding_pct: 30.0 },
          correlation_to_benchmark: 0.85,
          capture: { up: 0.94, down: 0.71, up_periods: 14, down_periods: 4 },
          cvar_95_pct: -1.47,
          bench_cvar_95_pct: -0.7,
          rolling_beta: curve(120, 0).map((p, i) => ({ ...p, value: 0.85 + 0.2 * Math.sin(i / 9) })),
          // V3: regimes + Brinson-Fachler attribution
          regimes: [
            { regime: "low_vol", days: 161, ann_return_pct: 1.5, bench_ann_return_pct: 8.5, sharpe: 0.13, hit_rate_pct: 50.3 },
            { regime: "mid_vol", days: 160, ann_return_pct: 17.1, bench_ann_return_pct: 2.2, sharpe: 1.46, hit_rate_pct: 51.2 },
            { regime: "high_vol", days: 160, ann_return_pct: 35.5, bench_ann_return_pct: 23.8, sharpe: 3.09, hit_rate_pct: 56.2 },
            { regime: "uptrend", days: 361, ann_return_pct: 17.7, bench_ann_return_pct: 13.5, sharpe: 1.56, hit_rate_pct: 51.0 },
            { regime: "downtrend", days: 80, ann_return_pct: -6.2, bench_ann_return_pct: -9.9, sharpe: null, hit_rate_pct: 48.7 },
          ],
          attribution: {
            allocation_pct: -4.7, selection_pct: 10.2, interaction_pct: 5.7,
            groups: [
              { group: "financials", avg_weight_pct: 31.4, bench_weight_pct: 26.7, allocation_pct: -0.3, selection_pct: 7.6 },
              { group: "tech", avg_weight_pct: 68.6, bench_weight_pct: 73.3, allocation_pct: -4.4, selection_pct: 2.6 },
            ],
          },
        },
        alternatives: [
          // V3.1: ΔSharpe vs 1/N and its bootstrap p-value (null on the equal row)
          { scheme: "equal", total_return_pct: 38.0, sharpe: 0.81, psr: 0.951, max_drawdown_pct: -16.0, ann_vol_pct: 16.1, avg_turnover_pct: 2.9,
            delta_sharpe_vs_equal_ann: 0.0, p_value_vs_equal: null },
          { scheme, total_return_pct: 41.2, sharpe: 0.88, psr: 0.979, max_drawdown_pct: -14.9, ann_vol_pct: 15.2, avg_turnover_pct: 3.1,
            delta_sharpe_vs_equal_ann: 0.1, p_value_vs_equal: 0.702 },
          { scheme: "risk_parity", total_return_pct: 36.5, sharpe: 0.79, psr: 0.902, max_drawdown_pct: -13.8, ann_vol_pct: 14.4, avg_turnover_pct: 3.6,
            delta_sharpe_vs_equal_ann: -0.03, p_value_vs_equal: 0.88 },
          { scheme: "hrp", total_return_pct: 37.2, sharpe: 0.84, psr: null, max_drawdown_pct: -13.1, ann_vol_pct: 14.0, avg_turnover_pct: 3.4,
            delta_sharpe_vs_equal_ann: 0.31, p_value_vs_equal: 0.021 },
        ].filter((a, i, arr) => arr.findIndex((b) => b.scheme === a.scheme) === i),
        // V4: 3×3 neighbourhood; the centre (top_n 8, rebalance 10) equals the headline Sharpe and towers over
        // its neighbours (spike 0.64 > 0.5 → parameter_spike); one cell could not be simulated
        sensitivity: {
          top_n: [5, 8, 11],
          rebalance: [5, 10, 20],
          cells: [
            [{ sharpe: 0.31, excess_pct: 1.2, max_drawdown_pct: -15.1 }, { sharpe: 0.22, excess_pct: -0.4, max_drawdown_pct: -16.3 }, { sharpe: 0.18, excess_pct: -1.1, max_drawdown_pct: -17.0 }],
            [{ sharpe: 0.29, excess_pct: 0.8, max_drawdown_pct: -15.5 }, { sharpe: 0.88, excess_pct: 6.3, max_drawdown_pct: -14.9 }, { sharpe: 0.25, excess_pct: -0.2, max_drawdown_pct: -16.8 }],
            [null, { sharpe: 0.12, excess_pct: -2.5, max_drawdown_pct: -18.9 }, { sharpe: -0.15, excess_pct: -6.0, max_drawdown_pct: -21.2 }],
          ],
          median_sharpe: 0.24, min_sharpe: -0.15, spike: 0.64,
        },
        target_weights: {
          as_of: "2026-09-03", exposure_pct: 100.0,
          weights: [
            { symbol: "AAPL", weight_pct: 25.0, score_rank: 1, group: "tech" },
            { symbol: "MSFT", weight_pct: 25.0, score_rank: 2, group: "tech" },
            { symbol: "NVDA", weight_pct: 25.0, score_rank: 3, group: "tech" },
            { symbol: "INTC", weight_pct: 25.0, score_rank: 4, group: "financials" },
          ],
          groups: [{ group: "tech", weight_pct: 75.0 }, { group: "financials", weight_pct: 25.0 }],
        },
        warnings: ["few_rebalances", "not_significant", "parameter_spike"],
      });
    }
    if (path === "/api/pipeline/orders") {
      // V5: a two-order ticket — the sell (funding) first, then the buy; NAV echoed from the request
      const body = route.request().postDataJSON() as { nav?: number } | null;
      const nav = body?.nav ?? 100000;
      return json({
        as_of: "2026-09-03",
        price_date: "2026-09-04",
        nav,
        orders: [
          { symbol: "INTC", side: "sell", shares: 100, price: 31.2, notional: 3120.0, from_weight_pct: 6.24, to_weight_pct: 0.0, group: "financials" },
          { symbol: "AAPL", side: "buy", shares: 55, price: 227.1, notional: 12490.5, from_weight_pct: 4.54, to_weight_pct: 25.0, group: "tech" },
        ],
        unpriced: ["ZZZZ"],
        // V5.1: an unpriced holding makes cash unknown — both cash figures null
        summary: { buys: 1, sells: 1, buy_notional: 12490.5, sell_notional: 3120.0, turnover_pct: 15.6, est_cost: 10.9,
          cash_before: null, cash_after: null, cash_unknown: true, target_exposure_pct: 100.0 },
      });
    }
    if (path === "/api/pipeline/memo")
      return json({
        verdict: "paper_first",
        headline: "信号有效但样本偏短，先以模拟盘验证三个月。",
        strengths: ["留出期超额为正", "换手可控"],
        concerns: ["夏普 t 值 2.1 未过 3.0 门槛", "分位数收益不单调"],
        next_steps: ["部署到模拟持仓", "三个月后复核 MinTRL"],
        honesty_note: "以上判断仅基于回测摘要，未见逐日曲线。",
        model: "claude-sonnet-5",
      });
    if (path === "/api/paper/track")
      return json({
        kind: "strategy", started_at: "2024-01-15", as_of: "2024-06-01", days_live: 138,
        equity_curve: curve(), benchmark_curve: curve(120, 30),
        stats: { return_pct: 8.2, bench_return_pct: 6.1, excess_pct: 2.1, max_drawdown_pct: -4.4, current_drawdown_pct: -1.2,
          sharpe: 1.31, ann_vol_pct: 12.0, win_rate_pct: 54.0, bars: 96, last_7d_pct: 0.9, last_30d_pct: 2.4 },
        pre: { return_pct: 40.0, bench_return_pct: 30.0, excess_pct: 10.0, max_drawdown_pct: -9.0, current_drawdown_pct: 0,
          sharpe: 1.1, ann_vol_pct: 14.0, win_rate_pct: 53.0, bars: 500, last_7d_pct: null, last_30d_pct: null },
        decay: { verdict: "holding", sharpe_delta: 0.21, excess_delta: -7.9 },
        position: { state: "long", since: "2024-05-02", symbols: ["AAPL"] },
        trades_live: 3,
        daily_returns: Array.from({ length: 30 }, (_, i) => ({ time: 1_700_000_000 + i * 86_400, ret_pct: (i % 3) - 1 })),
      });
    if (path === "/api/payments/config")
      return json({ methods: { card: false, crypto: false }, providers: { card: null, crypto: null }, demo: true,
        connect: false, platform_fee_pct: 10, persistence: "file", note: "演示", provider: "demo", real: false });
    if (path === "/api/payments/checkout")
      return json({ order_id: "demo_e2e", provider: "demo", method: "card", status: "pending", demo: true,
        item_id: "c_e2e", amount: "3.50", currency: "USD", hosted_url: null });
    if (path.startsWith("/api/payments/orders/demo/"))
      return json({ order_id: "demo_e2e", provider: "demo", status: "confirmed", demo: true, item_id: "c_e2e", token: "tok.sig" });
    if (path === "/api/marketplace/listings")
      return json({ persistence: "file", item: {
        id: "c_e2e", type: "strategy", name: "E2E 社区策略", tagline: "测试上架", description: "测试", author: "e2e", version: "1.0",
        tags: ["测试"], tier: "paid", risk: "medium", integration: {}, price: { amount: "3.50", currency: "USD" },
        community: true, locked: true, payout_method: "crypto", created_at: 1, sales: 0 } });
    if (path === "/api/marketplace/listings/mine") return json({ listings: [], persistence: "file" });
    if (path.startsWith("/api/marketplace/listings/c_e2e/payload"))
      return json({ id: "c_e2e", integration: { backtest: { strategy: "sma_cross", fast: 20, slow: 50 } } });
    if (path === "/api/wallet") return json({ balance_usd: 0, demo_usd: 0, entries: [] });
    if (path === "/api/wallet/topup")
      return json({ kind: "topup", order_id: "demo_top", provider: "demo", method: "card", status: "pending", demo: true,
        amount: "25.00", currency: "USD", hosted_url: null });
    if (path.startsWith("/api/wallet/topup/demo/"))
      return json({ order_id: "demo_top", provider: "demo", status: "confirmed", demo: true, kind: "topup",
        wallet: { balance_usd: 0, demo_usd: 25, entries: [{ id: "e1", kind: "topup", amount: 25, demo: true, ref: "demo_top", note: "demo", at: 1_700_000_000 }] } });
    if (path === "/api/wallet/purchase")
      return json({ order_id: "wal_1", provider: "wallet", status: "confirmed", demo: true, item_id: "trend-sniper-pro", token: "tok.sig",
        wallet: { balance_usd: 0, demo_usd: 20.01, entries: [] } });
    // anything unmocked answers empty-but-valid, never hangs
    return json({});
  });

  await page.addInitScript(() => {
    localStorage.setItem("aiquant.tour.done", "1"); // tour must not block clicks
    localStorage.setItem("aiquant.lang", "zh");
    // Hermeticity: kill ALL WebSockets (quote stream, Binance) so the app
    // settles into REST polling, which page.route() mocks. Without this a
    // locally-running backend leaks real data into the suite via the vite
    // preview proxy.
    class DeadSocket {
      onopen: unknown; onmessage: unknown; onerror: ((e: unknown) => void) | null = null;
      onclose: ((e: unknown) => void) | null = null;
      constructor() {
        setTimeout(() => {
          this.onerror?.(new Event("error"));
          this.onclose?.(new Event("close"));
        }, 0);
      }
      send() {}
      close() {}
    }
    // @ts-expect-error deliberate stub
    window.WebSocket = DeadSocket;
  });
}

test.beforeEach(async ({ page }) => {
  await mockApi(page);
});

test("loads the terminal with watchlist and chart", async ({ page }) => {
  await page.goto("/");
  await expect(page.getByRole("button", { name: "美股" })).toBeVisible();
  await expect(page.getByText("自选列表").first()).toBeVisible();
  // default watchlist symbols render with mocked quotes
  await expect(page.getByText("AAPL").first()).toBeVisible();
  // quotes arrive via the WS→REST-polling fallback — allow it time to settle
  await expect(page.getByText("123.45").first()).toBeVisible({ timeout: 15_000 });
});

test("switches across all tabs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "数字货币" }).click();
  await expect(page.getByText("BTC-USD").first()).toBeVisible();

  await page.getByRole("button", { name: "AI 策略" }).click();
  await expect(page.getByText("AI 策略工坊")).toBeVisible();

  await page.getByRole("button", { name: "因子挖掘" }).click();
  await expect(page.getByText("Loop Engineering")).toBeVisible();

  await page.getByRole("button", { name: "端到端量化", exact: true }).click();
  await expect(page.getByText("端到端量化投资")).toBeVisible();

  await page.getByRole("button", { name: "市场", exact: true }).click();
  await expect(page.getByText("可运行策略")).toBeVisible();
});

test("runs a backtest and renders honest stats", async ({ page }) => {
  await page.goto("/");
  await page.locator("button", { hasText: "运行回测" }).first().click();
  await expect(page.getByText("+12.34%").first()).toBeVisible();
  await expect(page.getByText("总收益").first()).toBeVisible();
  // the benchmark comparison — the honesty fixture — must render too
  await expect(page.getByText("超额 vs 买入持有").first()).toBeVisible();
  await expect(page.getByText("-1.50%").first()).toBeVisible();
});

test("first visit shows the tour; skip persists", async ({ page }) => {
  await page.addInitScript(() => {
    if (!sessionStorage.getItem("tour-e2e-armed")) {
      sessionStorage.setItem("tour-e2e-armed", "1");
      localStorage.removeItem("aiquant.tour.done");
    }
  });
  await page.goto("/");
  await expect(page.getByTestId("tour")).toBeVisible();
  await expect(page.getByText("自选与实时行情").first()).toBeVisible();
  await page.getByRole("button", { name: "下一步" }).click();
  await expect(page.getByTestId("tour").getByText("策略回测")).toBeVisible();
  await page.getByRole("button", { name: "跳过" }).click();
  await expect(page.getByTestId("tour")).toHaveCount(0);
  await page.reload();
  await expect(page.getByTestId("tour")).toHaveCount(0);
});

test("language toggle switches the chrome to English", async ({ page }) => {
  await page.goto("/");
  await page.locator(".lang-toggle").click();
  await expect(page.getByRole("button", { name: "Crypto" })).toBeVisible();
  await expect(page.getByText("WATCHLIST").first()).toBeVisible();
});

test("genetic evolution engine streams a champion", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "因子挖掘" }).click();
  await page.getByRole("tab", { name: "🧬 遗传进化" }).click();
  await page.locator("button", { hasText: "开始进化" }).click();
  await expect(page.getByText("rank(delta(close, 5))").first()).toBeVisible();
  await expect(page.getByText("+33.30%").first()).toBeVisible(); // cumulative return
  await expect(page.getByText("✓ 入选").first()).toBeVisible();
});

test("paper page shows position, decay verdict and backtest-vs-live table", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem(
      "aiquant.paper",
      JSON.stringify([
        { id: "p1", kind: "strategy", name: "AAPL · SMA", config: { symbol: "AAPL", strategy: "sma_cross" }, startedAt: "2024-01-15" },
        { id: "p2", kind: "strategy", name: "MSFT · RSI", config: { symbol: "MSFT", strategy: "rsi_reversion" }, startedAt: "2024-02-01", note: "对照组" },
      ]),
    );
  });
  await page.goto("/");
  await page.getByRole("button", { name: "模拟持仓" }).click();
  await expect(page.getByText("组合总览")).toBeVisible();
  await expect(page.getByText("2 个部署", { exact: false })).toBeVisible();
  await expect(page.getByText("多头 · 自 2024-05-02").first()).toBeVisible();
  await expect(page.getByText("边际保持", { exact: false }).first()).toBeVisible();
  await expect(page.getByText("回测期（上线前）").first()).toBeVisible();
  await expect(page.getByText("对照组")).toBeVisible();
  // remove needs a confirm click; a single click must NOT delete
  const cards = page.locator(".pp-card");
  await expect(cards).toHaveCount(2);
  await cards.first().getByTitle("移除").click();
  await expect(cards).toHaveCount(2);
  await cards.first().getByTitle("移除").click();
  await expect(cards).toHaveCount(1);
});

test("marketplace: list a paid strategy, buy it in demo mode, payload unlocks", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "市场" }).click();
  await page.getByRole("button", { name: /出售我的策略/ }).click();
  const dialog = page.getByRole("dialog", { name: "上架到市场" });
  await dialog.locator("input[type=number]").first().fill("3.5");
  await dialog.getByLabel("名称").fill("E2E 社区策略");
  await dialog.getByPlaceholder("0x… / bc1…").fill("0x1234567890abcdef1234567890abcdef12345678");
  await dialog.getByRole("button", { name: "上架" }).click();
  await expect(page.getByText("已上架 ✓", { exact: false })).toBeVisible();
  const card = page.locator(".mk-card", { hasText: "E2E 社区策略" });
  await expect(card).toBeVisible();
  await card.click();
  await page.getByRole("button", { name: /购买/ }).click();
  await page.getByRole("button", { name: /模拟支付完成/ }).click();
  // detail modal stays open; entitlement stored, payload merged → run button appears
  await expect(page.getByRole("button", { name: /在回测中运行/ })).toBeVisible();
  await expect(page.getByText("演示购买")).toBeVisible();
});

test("wallet: demo top-up credits the balance and pays for an item", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "市场" }).click();
  await page.getByRole("button", { name: "充值", exact: true }).click();
  const dialog = page.getByRole("dialog", { name: "钱包充值" });
  await dialog.getByRole("button", { name: /演示充值 \$25/ }).click();
  await dialog.getByRole("button", { name: /模拟支付完成/ }).click();
  await expect(page.getByText("演示充值 $25.00 已记入演示余额")).toBeVisible();
  await expect(page.locator(".mk-wallet__demo")).toHaveText("+$25.00 demo");
  // buy a priced catalogue item from the demo balance
  await page.locator(".mk-card", { hasText: "趋势狙击" }).first().click();
  await page.getByRole("button", { name: /购买/ }).click();
  await page.getByRole("button", { name: /用演示余额支付/ }).click();
  await expect(page.getByRole("button", { name: /在回测中运行/ })).toBeVisible();
  await expect(page.getByText("演示购买")).toBeVisible();
});

test("pipeline: tick a starter factor, run the six stages, deploy to paper", async ({ page }) => {
  // six stages, a memo, a deploy and a reload-restore in one flow — give it the long budget
  test.slow();
  // ONLY this test sees AI as enabled — later routes win, so this overrides mockApi's status
  await page.route("**/api/ai/status", (route) => route.fulfill({ json: { enabled: true, model: "claude-sonnet-5", effort: "high" } }));
  let memoBody: Record<string, unknown> | null = null;
  await page.route("**/api/pipeline/memo", (route) => {
    memoBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fallback();
  });
  let runBody: Record<string, unknown> | null = null;
  await page.route("**/api/pipeline/run", (route) => {
    runBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fallback();
  });
  await page.goto("/");
  await page.getByRole("button", { name: "端到端量化", exact: true }).click();
  await expect(page.getByText("端到端量化投资")).toBeVisible();
  // before any factor is ticked the run button is disabled — honesty by construction
  const run = page.getByTestId("pl-run");
  await expect(run).toBeDisabled();
  // ③ all seven scheme cards come from config, including the V2 HRP card
  const schemeCards = page.getByRole("radiogroup", { name: "权重方案" }).getByRole("radio");
  await expect(schemeCards).toHaveCount(7);
  await expect(page.getByRole("radio", { name: /层次风险平价 HRP/ })).toBeVisible();
  await page.getByRole("checkbox", { name: "短期反转" }).check();
  await expect(run).toBeEnabled();
  // ① V5 custom universe: too few tickers disables Run with a reason; nine (one bogus) enables it
  await expect(page.getByTestId("pl-history")).toHaveValue("3y");
  await page.getByTestId("pl-custom-toggle").check();
  const symbols = page.getByTestId("pl-symbols");
  await expect(symbols).toBeVisible();
  await symbols.fill("AAPL MSFT NVDA");
  await expect(page.getByTestId("pl-symbols-count")).toHaveText("3 / 40（至少 8）");
  await expect(page.getByTestId("pl-symbols-count")).toHaveClass(/is-bad/);
  await expect(run).toBeDisabled();
  await expect(page.getByTestId("pl-run-hint")).toContainText("至少需要 8 个标的");
  await symbols.fill("AAPL, MSFT, NVDA, INTC\nAMZN GOOG META tsla zzzz");
  await expect(page.getByTestId("pl-symbols-count")).toHaveText("9 / 40（至少 8）");
  await expect(page.getByTestId("pl-symbols-count")).not.toHaveClass(/is-bad/);
  await expect(page.getByTestId("pl-symbols-issue")).toHaveCount(0);
  await expect(run).toBeEnabled();
  await run.click();
  // ① → request: the parsed, uppercased, deduped list travels only because the toggle is on; history defaults to 3y
  await expect(page.getByTestId("pl-sharpe")).toBeVisible();
  expect(runBody).not.toBeNull();
  expect(runBody!.symbols).toEqual(["AAPL", "MSFT", "NVDA", "INTC", "AMZN", "GOOG", "META", "TSLA", "ZZZZ"]);
  expect(runBody!.history).toBe("3y");
  // ① after the run: the custom summary chip and the dropped-ticker warning
  await expect(page.getByTestId("pl-universe-summary")).toContainText("自定义 · 4 只 · 3y");
  const dropped = page.getByTestId("pl-dropped");
  await expect(dropped).toBeVisible();
  await expect(dropped).toHaveText("⚠ 未能获取 1 个标的：ZZZZ");
  // ④ headline stats: Sharpe alongside its benchmark
  await expect(page.getByTestId("pl-sharpe")).toContainText("0.88");
  await expect(page.getByTestId("pl-sharpe")).toContainText("0.74");
  // ④ V2 overfitting check: PSR printed and coloured green (≥ 0.95)
  const psr = page.getByTestId("pl-psr");
  await expect(psr).toBeVisible();
  await expect(psr).toContainText("0.98");
  await expect(psr.locator(".pl-tone--ok")).toBeVisible();
  // ② alpha-decay bars and ⑤ capture / rolling beta rendered from the V2 fields
  await expect(page.getByTestId("pl-ic-decay")).toBeVisible();
  await expect(page.getByTestId("pl-capture")).toContainText("0.94");
  await expect(page.getByTestId("pl-rolling-beta")).toBeVisible();
  // warnings are translated, not shown as raw codes (incl. the V3 `not_significant` and V4 `parameter_spike` codes)
  await expect(page.getByText("调仓次数过少", { exact: false })).toBeVisible();
  await expect(page.getByText("谈不上统计显著", { exact: false })).toBeVisible();
  await expect(page.locator(".pl-warning", { hasText: "参数尖峰" })).toBeVisible();
  // no result was in storage before this run, so no restored chip; the run persisted itself
  await expect(page.getByTestId("pl-restored")).toHaveCount(0);
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem("aiquant.pipeline.last") ?? "null")?.backtest?.stats?.sharpe)).toBe(0.88);
  // ④ V4 rolling half-year hit rate (44.1 → red) in the stat grid
  const rolling = page.getByTestId("pl-rolling-hit");
  await expect(rolling).toContainText("44.1%");
  await expect(rolling).toContainText("vs 等权基准");
  await expect(rolling.locator(".pl-tone--bad")).toBeVisible();
  // ② V4 active-days chip only on the gated factor (82.6 → "启用 83%")
  const activeChips = page.getByTestId("pl-active-chip");
  await expect(activeChips).toHaveCount(1);
  await expect(activeChips.first()).toBeVisible();
  await expect(activeChips.first()).toHaveText("启用 83%");
  // ③ → request: V3 shrink_to_equal and the browser's prior_trials count travel with the run
  expect(runBody).not.toBeNull();
  expect(runBody!.shrink_to_equal).toBe(0);
  expect(runBody!.prior_trials).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem("aiquant.pipeline.trials"))).toBe("1");
  await expect(page.getByTestId("pl-trials")).toContainText("已尝试 1 次");
  await expect(page.getByTestId("pl-shrink")).toHaveValue("0");
  // ② V3 quantile chart: five bars, one dashed (null), spread chip and the monotonic badge
  const quant = page.getByTestId("pl-quantiles");
  await expect(quant).toBeVisible();
  await expect(quant.locator("rect[data-bucket]")).toHaveCount(5);
  await expect(quant.locator("rect.pl-decay__none")).toHaveCount(1);
  await expect(page.getByTestId("pl-spread")).toContainText("+17.8%");
  await expect(page.getByTestId("pl-monotonic")).toContainText("非单调");
  // ④ V3 t-stat (2.1 → amber) with the HLZ hurdle, and MinTRL vs actual track (green: 540 ≥ 336)
  const tstat = page.getByTestId("pl-tstat");
  await expect(tstat).toContainText("2.10");
  await expect(tstat).toContainText("t 3.0 门槛");
  await expect(tstat.locator(".pl-tone--warn")).toBeVisible();
  const mintrl = page.getByTestId("pl-mintrl");
  await expect(mintrl).toContainText("需 336 天 / 已有 540 天");
  await expect(mintrl.locator(".pl-tone--ok")).toBeVisible();
  // ④ V3.1 alternatives: ΔSharpe vs 1/N + p-value columns, HRP significant (green), DeMiguel note
  const alts = page.locator(".pl-alts");
  await expect(alts).toContainText("Δ夏普 vs 等权");
  await expect(alts).toContainText("0.021");
  await expect(alts.locator("tr", { hasText: "HRP" }).locator(".pl-tone--ok").first()).toBeVisible();
  await expect(page.getByTestId("pl-alts-note")).toContainText("DeMiguel");
  // ④ V4 sensitivity heatmap: 9 cells (one dashed null), the chosen centre outlined with the headline Sharpe, spike chip red
  const sens = page.getByTestId("pl-sens");
  await expect(sens).toBeVisible();
  await expect(sens.locator(".pl-sens__cell")).toHaveCount(9);
  await expect(sens.locator(".pl-sens__cell--none")).toHaveCount(1);
  const chosenCell = sens.locator(".pl-sens__cell.is-chosen");
  await expect(chosenCell).toHaveCount(1);
  await expect(chosenCell).toHaveText("0.88");
  await expect(chosenCell).toHaveAttribute("data-chosen", "true");
  await expect(chosenCell).toHaveCSS("outline-style", "solid");
  await expect(sens.locator(".pl-sens__cell").filter({ hasText: "-0.15" })).toBeVisible();
  const spike = page.getByTestId("pl-spike");
  await expect(spike).toBeVisible();
  await expect(spike).toHaveText("尖峰 +0.64");
  await expect(spike).toHaveClass(/pl-tone--bad/);
  await expect(page.getByText("邻域中位夏普 0.24")).toBeVisible();
  await expect(page.getByText("López de Prado", { exact: false })).toBeVisible();
  // ④ V4 Markdown report: the clipboard is stubbed so the suite stays hermetic, then the content is checked
  await page.evaluate(() => {
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText: (s: string) => { (window as unknown as { __md: string }).__md = s; return Promise.resolve(); } },
    });
  });
  await page.getByTestId("pl-copy-md").click();
  await expect(page.getByTestId("pl-md-copied")).toBeVisible();
  const md = await page.evaluate(() => (window as unknown as { __md: string }).__md);
  expect(md).toContain("# 端到端量化回测报告");
  expect(md).toContain("波动率倒数");
  expect(md).toContain("| 夏普 | 0.88 | 0.74 |");
  expect(md).toContain("## 样本内 vs 留出期");
  expect(md).toContain("PSR 0.98 · DSR 0.86 · 夏普 t 值 2.10（门槛 3.0）· MinTRL 需 336 天 / 已有 540 天");
  expect(md).toContain("## 参数敏感性（Top-N 5/8/11 × 调仓 5/10/20）");
  expect(md).toContain("**0.88**");
  expect(md).toContain("滚动半年胜率 | 44.1%");
  expect(md).toContain("| 1 | AAPL | 科技 | 25.0% |");
  expect(md).toContain("参数尖峰");
  expect(md).not.toContain("equity_curve");
  // ⑤ V3 regime table (five rows, labels translated) and Brinson-Fachler attribution
  const regimes = page.getByTestId("pl-regimes");
  await expect(regimes.locator("tbody tr")).toHaveCount(5);
  await expect(regimes).toContainText("高波动");
  await expect(regimes).toContainText("下行趋势");
  await expect(page.getByTestId("pl-attr-chips")).toContainText("选股效应 +10.2%");
  const attribution = page.getByTestId("pl-attribution");
  await expect(attribution).toBeVisible();
  await expect(attribution.locator("tbody tr")).toHaveCount(2);
  await expect(attribution).toContainText("金融");
  // ⑥ target weights + sector column + sector stack
  const weights = page.getByTestId("pl-weights");
  await expect(weights).toBeVisible();
  await expect(weights.getByText("AAPL")).toBeVisible();
  await expect(weights).toContainText("科技");
  const stack = page.getByTestId("pl-sector-stack");
  await expect(stack).toBeVisible();
  await expect(stack.locator(".pl-stack__seg")).toHaveCount(2);
  await expect(stack).toContainText("75.0%");
  // ⑥ committee memo: AI enabled in this test → button live, verdict badge + headline rendered
  const memoBtn = page.getByTestId("pl-memo-btn");
  await expect(memoBtn).toBeEnabled();
  await expect(page.getByTestId("pl-memo-disabled")).toHaveCount(0);
  await memoBtn.click();
  const verdict = page.getByTestId("pl-memo-verdict");
  await expect(verdict).toHaveText("先模拟");
  await expect(verdict).toHaveClass(/pl-verdict--paper_first/);
  await expect(page.getByTestId("pl-memo-headline")).toContainText("先以模拟盘验证三个月");
  await expect(page.getByTestId("pl-memo")).toContainText("由 claude-sonnet-5 生成");
  // the memo request is the compact summary: no curves, current UI language, truncations applied
  expect(memoBody).not.toBeNull();
  expect(memoBody!.lang).toBe("zh");
  expect(memoBody!).not.toHaveProperty("backtest");
  expect(JSON.stringify(memoBody)).not.toContain("equity_curve");
  expect(JSON.stringify(memoBody)).not.toContain("rolling_beta");
  expect((memoBody!.risk as { drawdowns: unknown[] }).drawdowns.length).toBeLessThanOrEqual(3);
  // ⑥ V5 rebalance ticket: NAV 50000 + one holding → sell row first, then the buy; summary chips; CSV copy
  let ordersBody: Record<string, unknown> | null = null;
  await page.route("**/api/pipeline/orders", (route) => {
    ordersBody = route.request().postDataJSON() as Record<string, unknown>;
    return route.fallback();
  });
  const ticket = page.getByTestId("pl-ticket");
  await expect(ticket).toBeVisible();
  await expect(page.getByTestId("pl-ticket-nav")).toHaveValue("100000");
  await expect(page.getByTestId("pl-ticket-min")).toHaveValue("0.25");
  await page.getByTestId("pl-ticket-nav").fill("50000");
  const holdings = page.getByTestId("pl-ticket-holdings");
  await holdings.fill("AAPL 10\nnonsense line");
  await expect(page.getByTestId("pl-ticket-badlines")).toContainText("第 2 行无法解析：nonsense line");
  await expect(page.getByTestId("pl-ticket-build")).toBeDisabled();
  await holdings.fill("AAPL 10");
  await expect(page.getByTestId("pl-ticket-badlines")).toHaveCount(0);
  await page.getByTestId("pl-ticket-build").click();
  const orderRows = page.getByTestId("pl-ticket-table").locator("tbody tr");
  await expect(orderRows).toHaveCount(2);
  await expect(orderRows.nth(0)).toHaveAttribute("data-side", "sell");
  await expect(orderRows.nth(0)).toContainText("卖出");
  await expect(orderRows.nth(0)).toContainText("INTC");
  await expect(orderRows.nth(1)).toHaveAttribute("data-side", "buy");
  await expect(orderRows.nth(1)).toContainText("买入");
  await expect(orderRows.nth(1)).toContainText("12,490.50");
  await expect(page.getByTestId("pl-ticket-turnover")).toHaveText("换手 15.6%");
  await expect(page.getByTestId("pl-ticket-unpriced")).toContainText("ZZZZ");
  await expect(page.getByTestId("pl-ticket-cash-unknown")).toHaveText("现金未知（有持仓无法定价）");
  await expect(page.getByTestId("pl-ticket-cash")).toHaveCount(0);
  await expect(page.getByTestId("pl-ticket-dates")).toContainText("2026-09-04");
  await expect(page.getByTestId("pl-ticket-note")).toHaveText("参考价为最近收盘价，实际以开盘成交；股数已取整、不做空。");
  // the request carried the current spec (the run on screen), the NAV, the parsed holdings and the default threshold
  expect(ordersBody).not.toBeNull();
  expect(ordersBody!.nav).toBe(50000);
  expect(ordersBody!.min_trade_pct).toBe(0.25);
  expect(ordersBody!.current).toEqual({ AAPL: 10 });
  expect((ordersBody!.spec as { market: string; symbols?: string[] }).market).toBe("us");
  expect((ordersBody!.spec as { symbols?: string[] }).symbols).toHaveLength(9);
  // CSV copy goes through the same stubbed clipboard as the Markdown report
  await page.getByTestId("pl-ticket-csv").click();
  await expect(page.getByTestId("pl-ticket-csv-copied")).toBeVisible();
  const csv = await page.evaluate(() => (window as unknown as { __md: string }).__md);
  expect(csv.split("\n")[0]).toBe("side,symbol,shares,price,notional,from_weight_pct,to_weight_pct,group");
  expect(csv).toContain("sell,INTC,100,31.2,3120.00");
  expect(csv).toContain("buy,AAPL,55,227.1,12490.50");
  const deploy = page.getByTestId("pl-deploy");
  await expect(deploy).toBeVisible();
  await deploy.click();
  await expect(page.getByTestId("pl-deployed")).toBeVisible();
  // the deployment landed in browser storage with the pipeline kind
  const kinds = await page.evaluate(() =>
    (JSON.parse(localStorage.getItem("aiquant.paper") ?? "[]") as Array<{ kind: string }>).map((d) => d.kind),
  );
  expect(kinds).toContain("pipeline");
  // V4 last-result persistence: a reload restores the run from storage and says so; no new request is made
  let runsAfterReload = 0;
  await page.route("**/api/pipeline/run", (route) => {
    runsAfterReload += 1;
    return route.fallback();
  });
  await page.reload();
  await page.getByRole("button", { name: "端到端量化", exact: true }).click();
  const restored = page.getByTestId("pl-restored");
  await expect(restored).toBeVisible();
  await expect(restored).toHaveText("已恢复上次结果 · 2026-09-03");
  await expect(page.getByTestId("pl-sharpe")).toContainText("0.88");
  await expect(page.getByTestId("pl-sens").locator(".pl-sens__cell")).toHaveCount(9);
  expect(runsAfterReload).toBe(0);
  expect(await page.evaluate(() => localStorage.getItem("aiquant.pipeline.last"))).not.toBeNull();
  // the next run clears the chip
  await page.getByRole("checkbox", { name: "短期反转" }).check();
  await page.getByTestId("pl-run").click();
  await expect(page.getByTestId("pl-trials")).toContainText("已尝试 2 次");
  await expect(restored).toHaveCount(0);
});
