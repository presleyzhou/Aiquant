/* Minimal service worker: enables PWA installability.
 * Deliberately network-only — quotes, forecasts and backtests must never be
 * served stale from a cache, so there is no offline mode by design. */
self.addEventListener("install", () => self.skipWaiting());
self.addEventListener("activate", (event) => event.waitUntil(self.clients.claim()));
self.addEventListener("fetch", () => {
  /* passthrough — the browser handles the request normally */
});
