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
        starter_factors: {
          us: [
            { expression: "neg(delta(close, 5) / ts_std(returns, 20))", zh: "短期反转", en: "Short-term reversal", invert: false, horizon: 10 },
            { expression: "rank(ts_mean(returns, 60))", zh: "中期动量", en: "Medium-term momentum", invert: false, horizon: 10 },
          ],
          crypto: [
            { expression: "rank(ts_mean(returns, 30))", zh: "月度动量", en: "Monthly momentum", invert: false, horizon: 10 },
          ],
        },
        defaults: { scheme: "inverse_vol", signal_weighting: "ic_expanding", top_n: 8, rebalance: 10, max_weight: 0.25, cost_bps: 7,
          target_vol_pct: null, vol_lookback: 60, horizon: 10, hold_buffer: 4, trade_rate: 1.0 },
        limits: { factors: [1, 8], top_n: [2, 20], rebalance: [1, 30], max_weight: [0.05, 1.0], cost_bps: [0, 50],
          target_vol_pct: [5, 40], vol_lookback: [20, 120], hold_buffer: [0, 20], trade_rate: [0.1, 1.0] },
      });
    if (path === "/api/pipeline/run") {
      const body = route.request().postDataJSON() as { factors?: unknown[]; scheme?: string } | null;
      const factors = Array.isArray(body?.factors) && body.factors.length > 0
        ? body.factors
        : [{ expression: "neg(delta(close, 5) / ts_std(returns, 20))", invert: false, horizon: 10 }];
      const scheme = body?.scheme ?? "inverse_vol";
      const split = (from: string, to: string, ret: number, sharpe: number) =>
        ({ from, to, total_return_pct: ret, sharpe, max_drawdown_pct: -9.5, excess_pct: ret - 20 });
      return json({
        spec: { market: "us", factors, signal_weighting: "ic_expanding", scheme, top_n: 8, rebalance: 10, max_weight: 0.25,
          cost_bps: 7, target_vol_pct: null, vol_lookback: 60, hold_buffer: 4, trade_rate: 1.0, compare: true },
        universe: { market: "us", symbols: 4, from: "2023-09-05", to: "2026-09-03", bars: 752 },
        signal: {
          weighting: "ic_expanding",
          components: (factors as Array<{ expression: string; invert: boolean; horizon: number }>).map((f, i) => ({
            ...f, is_ic: 0.021 - i * 0.004, oos_ic: 0.012, weight: 1 / factors.length, avg_weight: 0.9 / factors.length,
            standalone_sharpe: 0.81 })),
          max_pair_corr: 0.31,
          // V2: alpha-decay curve (one null = too few samples) + composite ICs
          ic_by_horizon: [
            { horizon: 1, ic: 0.005 }, { horizon: 2, ic: 0.01 }, { horizon: 3, ic: -0.002 }, { horizon: 5, ic: 0.012 },
            { horizon: 10, ic: 0.018 }, { horizon: 15, ic: 0.021 }, { horizon: 20, ic: null },
          ],
          composite_is_ic: 0.011,
          composite_oos_ic: 0.008,
        },
        portfolio: { scheme, top_n: 8, max_weight: 0.25, rebalance: 10, cost_bps: 7, target_vol_pct: null, vol_lookback: 60,
          avg_effective_n: 6.4, avg_exposure_pct: 100.0, avg_turnover_pct: 3.1, rebalances: 60,
          annual_turnover_x: 12.9, breakeven_cost_bps: 52.1, hold_buffer: 4, trade_rate: 1.0 },
        backtest: {
          span: { from: "2023-12-01", to: "2026-09-03" },
          stats: { total_return_pct: 41.2, cagr_pct: 13.4, ann_vol_pct: 15.2, sharpe: 0.88, sortino: 1.21, calmar: 0.9,
            max_drawdown_pct: -14.9, win_rate_pct: 53.1, excess_pct: 6.3, beta: 0.82, tracking_error_pct: 6.1, information_ratio: 0.7,
            benchmark: { total_return_pct: 34.9, cagr_pct: 11.5, ann_vol_pct: 16.0, sharpe: 0.74, max_drawdown_pct: -18.2 } },
          in_sample: split("2023-12-01", "2025-09-01", 30.1, 1.02),
          holdout: { ...split("2025-09-02", "2026-09-03", 8.5, 0.61), psr: 0.906 },
          overfitting: { psr: 0.982, dsr: 0.859, trials: 9, expected_max_sharpe_ann: 0.7 },
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
        },
        alternatives: [
          { scheme: "equal", total_return_pct: 38.0, sharpe: 0.81, psr: 0.951, max_drawdown_pct: -16.0, ann_vol_pct: 16.1, avg_turnover_pct: 2.9 },
          { scheme, total_return_pct: 41.2, sharpe: 0.88, psr: 0.979, max_drawdown_pct: -14.9, ann_vol_pct: 15.2, avg_turnover_pct: 3.1 },
          { scheme: "risk_parity", total_return_pct: 36.5, sharpe: 0.79, psr: 0.902, max_drawdown_pct: -13.8, ann_vol_pct: 14.4, avg_turnover_pct: 3.6 },
          { scheme: "hrp", total_return_pct: 37.2, sharpe: 0.84, psr: null, max_drawdown_pct: -13.1, ann_vol_pct: 14.0, avg_turnover_pct: 3.4 },
        ].filter((a, i, arr) => arr.findIndex((b) => b.scheme === a.scheme) === i),
        target_weights: {
          as_of: "2026-09-03", exposure_pct: 100.0,
          weights: [
            { symbol: "AAPL", weight_pct: 25.0, score_rank: 1 },
            { symbol: "MSFT", weight_pct: 25.0, score_rank: 2 },
            { symbol: "NVDA", weight_pct: 25.0, score_rank: 3 },
            { symbol: "INTC", weight_pct: 25.0, score_rank: 4 },
          ],
        },
        warnings: ["few_rebalances"],
      });
    }
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
  await run.click();
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
  // warnings are translated, not shown as raw codes
  await expect(page.getByText("调仓次数过少", { exact: false })).toBeVisible();
  // ⑥ target weights + deploy
  const weights = page.getByTestId("pl-weights");
  await expect(weights).toBeVisible();
  await expect(weights.getByText("AAPL")).toBeVisible();
  const deploy = page.getByTestId("pl-deploy");
  await expect(deploy).toBeVisible();
  await deploy.click();
  await expect(page.getByTestId("pl-deployed")).toBeVisible();
  // the deployment landed in browser storage with the pipeline kind
  const kinds = await page.evaluate(() =>
    (JSON.parse(localStorage.getItem("aiquant.paper") ?? "[]") as Array<{ kind: string }>).map((d) => d.kind),
  );
  expect(kinds).toContain("pipeline");
});
