import { chromium } from "@playwright/test";
const OUT = "/Users/presley/Claude/Projects/Aiquant/docs/lecture/shots";
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2, colorScheme: "dark" });

/** Screenshot the visible part of an element (works inside scroll containers). */
async function shotEl(loc, path, pad = 12) {
  await loc.scrollIntoViewIfNeeded();
  await wait(600);
  const box = await loc.boundingBox();
  const vp = page.viewportSize();
  const x = Math.max(0, box.x - pad), y = Math.max(0, box.y - pad);
  const w = Math.min(vp.width - x, box.width + pad * 2), h = Math.min(vp.height - y, box.height + pad * 2);
  await page.screenshot({ path, clip: { x, y, width: w, height: h } });
}

await page.goto("http://localhost:5173/");
await page.evaluate(() => {
  localStorage.setItem("aiquant.tour.done", "1");
  localStorage.setItem("aiquant.lang", "zh");
  localStorage.setItem("aiquant.factors.zoo", JSON.stringify([
    { expression: "rank(ts_corr(close, volume, 20))", market: "us", horizon: 10, is_ic: 0.016, is_icir: 0.12, oos_ic: 0.011, savedAt: new Date().toISOString() },
    { expression: "rank(delta(close, 20))", market: "us", horizon: 10, is_ic: 0.02, is_icir: 0.15, oos_ic: 0.012, savedAt: new Date().toISOString() },
    { expression: "rank(ts_min(zscore(ts_mean(low, 40)), 20))", market: "us", horizon: 10, is_ic: -0.026, is_icir: -0.31, oos_ic: -0.02, savedAt: new Date().toISOString() },
  ]));
  localStorage.setItem("aiquant.paper", JSON.stringify([
    { id: "p1", kind: "strategy", name: "AAPL · SMA 20/50", config: { symbol: "AAPL", strategy: "sma_cross", fast: 20, slow: 50 }, startedAt: "2026-03-02" },
    { id: "p3", kind: "factor", name: "动量因子 Top5", config: { expression: "rank(delta(close,20))", market: "us", top_n: 5, rebalance: 10, invert: false }, startedAt: "2026-05-04" },
  ]));
});
await page.reload();
await wait(6000);
await page.screenshot({ path: `${OUT}/terminal.png`, clip: { x: 0, y: 0, width: 1280, height: 800 } });
console.log("terminal");

const tab = async (name) => { await page.getByRole("button", { name, exact: true }).first().click(); await wait(2500); };
await tab("因子挖掘");
await page.screenshot({ path: `${OUT}/mining.png`, clip: { x: 0, y: 100, width: 1280, height: 560 } });
console.log("mining");

// GP first (long): toggle engine, smallest population/generations
await page.locator(".engine-toggle .chip").nth(1).click();
await wait(1500);
const runBtn = page.locator("button", { hasText: "开始进化" }).first();
await runBtn.waitFor({ timeout: 30000 }).catch(async (e) => { await page.screenshot({ path: `${OUT}/debug-fail.png` }); throw e; });
// the GP form is the block that contains the run button: pick its selects (market, horizon, population, generations, ...)
await page.locator("label.field", { hasText: "种群规模" }).locator("select").selectOption({ index: 0 });
await page.locator("label.field", { hasText: "进化代数" }).locator("select").selectOption({ index: 0 });
await runBtn.click();
await page.locator(".fl-zoo-row").first().waitFor({ timeout: 500000 });
await wait(1500);
await page.setViewportSize({ width: 1280, height: 1000 });
await shotEl(page.locator(".lab-panel").first(), `${OUT}/gp-progress.png`);
await shotEl(page.locator(".panel", { hasText: "发现" }).first(), `${OUT}/gp.png`);
console.log("gp");

// back to LLM engine view for the library shots
await page.locator(".engine-toggle .chip").nth(0).click();
await wait(1500);
await page.setViewportSize({ width: 1280, height: 1500 });
await wait(800);
const rep = page.locator(".fr > button").first();
await rep.scrollIntoViewIfNeeded();
await rep.click();
await page.locator(".fr__body").first().waitFor({ timeout: 120000 });
await page.getByRole("button", { name: "Δ" }).first().click();
await page.locator(".fl-badge", { hasText: "Δ 夏普" }).first().waitFor({ timeout: 120000 });
await wait(800);
await shotEl(page.locator(".fr__body").first(), `${OUT}/report.png`);
await page.locator(".fr > button").first().click(); // collapse report
await wait(600);
await shotEl(page.locator(".lab-saved").first(), `${OUT}/library.png`);
console.log("report + library");

// portfolio backtest of the first factor (▶) — chart panel appears
await page.locator(".lab-saved__actions button").first().click();
await page.locator(".lab canvas").first().waitFor({ timeout: 120000 });
await wait(2500);
const chartPanel = page.locator(".panel", { has: page.locator("canvas") }).first();
await shotEl(chartPanel, `${OUT}/portfolio.png`);
console.log("portfolio");

// paper trading
await page.setViewportSize({ width: 1280, height: 1300 });
await tab("模拟持仓");
await page.locator(".pp-compare").first().waitFor({ timeout: 180000 });
await wait(2500);
await shotEl(page.locator(".pp-summary").first(), `${OUT}/paper-summary.png`);
await shotEl(page.locator(".pp-card").first(), `${OUT}/paper.png`);
console.log("paper");
await browser.close();
