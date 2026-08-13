import react from "@vitejs/plugin-react";
import { defineConfig } from "vite";

// In dev the browser talks to Vite on :5173 and Vite proxies /api and /ws to the
// backend, so the app uses same-origin relative URLs everywhere. In the Docker
// image nginx does the same job, so no frontend code changes between the two.
export default defineConfig({
  plugins: [react()],
  server: {
    host: true,
    port: 5173,
    proxy: {
      "/api": { target: "http://localhost:8000", changeOrigin: true },
      "/ws": { target: "ws://localhost:8000", ws: true },
    },
  },
});
