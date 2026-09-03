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

test("switches across all four tabs", async ({ page }) => {
  await page.goto("/");
  await page.getByRole("button", { name: "数字货币" }).click();
  await expect(page.getByText("BTC-USD").first()).toBeVisible();

  await page.getByRole("button", { name: "AI 策略" }).click();
  await expect(page.getByText("AI 策略工坊")).toBeVisible();

  await page.getByRole("button", { name: "因子挖掘" }).click();
  await expect(page.getByText("Loop Engineering")).toBeVisible();

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
