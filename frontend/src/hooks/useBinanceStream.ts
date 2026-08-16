import { useEffect, useRef, useState } from "react";
import type { Quote } from "../api";

/** True second-level quotes for the crypto workspace, straight from Binance's
 * public combined stream (no key, no backend hop). `XXX-USD` symbols map to
 * Binance `XXXUSDT` pairs — USDT tracks USD within a few basis points, far
 * tighter than Yahoo's crypto quote delay. Symbols without a USDT pair simply
 * never emit, so the Yahoo value they already have keeps showing.
 *
 * miniTicker payload: c = last price, o = open 24h ago, h/l = 24h range,
 * v = 24h base volume. Change% is computed against the 24h open, matching how
 * exchanges quote daily change for round-the-clock markets. */
export function useBinanceStream(symbols: string[]): Record<string, Quote> {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const retryRef = useRef(0);

  // Stable dependency: reconnect only when the actual symbol set changes.
  const key = [...symbols]
    .filter((s) => /-USD$/i.test(s))
    .map((s) => s.toUpperCase())
    .sort()
    .join(",");

  useEffect(() => {
    if (!key) {
      setQuotes({});
      return;
    }
    const pairs = key.split(",");
    // BTC-USD -> btcusdt@miniTicker; keep a reverse map for incoming events.
    const byStream = new Map<string, string>();
    const streams = pairs.map((sym) => {
      const stream = `${sym.replace(/-USD$/, "").toLowerCase()}usdt@miniTicker`;
      byStream.set(stream.split("@")[0].toUpperCase(), sym);
      return stream;
    });

    let ws: WebSocket | null = null;
    let closed = false;
    let timer: number | undefined;

    const connect = () => {
      ws = new WebSocket(`wss://stream.binance.com:9443/stream?streams=${streams.join("/")}`);

      ws.onmessage = (event) => {
        try {
          const { data } = JSON.parse(event.data as string);
          const symbol = byStream.get(String(data?.s ?? ""));
          if (!symbol) return;
          const price = Number(data.c);
          const open = Number(data.o);
          if (!Number.isFinite(price) || !Number.isFinite(open)) return;
          setQuotes((prev) => ({
            ...prev,
            [symbol]: {
              symbol,
              price,
              change: price - open,
              change_pct: open ? ((price - open) / open) * 100 : undefined,
              day_high: Number(data.h) || undefined,
              day_low: Number(data.l) || undefined,
              volume: Number(data.v) || undefined,
              currency: "USDT",
              as_of: new Date().toISOString(),
            },
          }));
          retryRef.current = 0;
        } catch {
          /* malformed frame — skip */
        }
      };

      ws.onclose = () => {
        if (closed) return;
        // Exponential backoff, capped at 30s; Yahoo values cover the gap.
        const delay = Math.min(30_000, 1_000 * 2 ** retryRef.current++);
        timer = window.setTimeout(connect, delay);
      };
      ws.onerror = () => ws?.close();
    };

    connect();
    return () => {
      closed = true;
      window.clearTimeout(timer);
      ws?.close();
    };
  }, [key]);

  return quotes;
}
