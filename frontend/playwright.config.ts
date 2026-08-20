import { defineConfig } from "@playwright/test";

/** E2E smoke against the PRODUCTION build served by `vite preview`.
 * Every /api/* call is mocked inside the specs, so runs need no backend,
 * no API keys and no network — safe for CI. */
export default defineConfig({
  testDir: "./e2e",
  timeout: 30_000,
  retries: process.env.CI ? 1 : 0,
  use: {
    baseURL: "http://127.0.0.1:4173",
    viewport: { width: 1440, height: 900 },
  },
  webServer: {
    command: "npm run preview -- --host 127.0.0.1 --port 4173 --strictPort",
    url: "http://127.0.0.1:4173",
    reuseExistingServer: !process.env.CI,
    timeout: 30_000,
  },
});
