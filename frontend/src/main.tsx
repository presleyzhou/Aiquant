import React from "react";
import ReactDOM from "react-dom/client";
import App from "./App";
import { LangProvider } from "./i18n";
import "./styles.css";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode>
    <LangProvider>
      <App />
    </LangProvider>
  </React.StrictMode>,
);

// Vercel Web Analytics — no-ops locally and until enabled in the dashboard.
import { inject } from "@vercel/analytics";

inject();

// Error monitoring — dynamically imported ONLY when a DSN is configured at
// build time, so the default bundle carries zero Sentry bytes.
const sentryDsn = import.meta.env.VITE_SENTRY_DSN as string | undefined;
if (sentryDsn) {
  import("@sentry/react")
    .then((Sentry) => Sentry.init({ dsn: sentryDsn, tracesSampleRate: 0.05 }))
    .catch(() => {});
}

// PWA installability; the worker is network-only by design (see public/sw.js).
if ("serviceWorker" in navigator && import.meta.env.PROD) {
  window.addEventListener("load", () => {
    navigator.serviceWorker.register("/sw.js").catch(() => {});
  });
}
