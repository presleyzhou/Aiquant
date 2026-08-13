import { useEffect, useRef, useState } from "react";
import { api, type Quote } from "../api";

type Status = "connecting" | "open" | "polling" | "closed";

const POLL_INTERVAL_MS = 12_000;
/** WS attempts that fail before ever opening, after which we assume the host
 *  simply has no WebSocket support (e.g. Vercel serverless) and poll instead. */
const FAILURES_BEFORE_FALLBACK = 2;

/**
 * Live quotes for a watchlist, over WebSocket when the backend supports it and
 * REST polling when it doesn't. The switch is automatic: serverless deploys
 * (Vercel) can't hold a socket, so after two failed connection attempts the
 * hook settles into polling for the rest of the session.
 */
export function useQuoteStream(symbols: string[]) {
  const [quotes, setQuotes] = useState<Record<string, Quote>>({});
  const [status, setStatus] = useState<Status>("connecting");
  const socketRef = useRef<WebSocket | null>(null);
  const symbolsRef = useRef(symbols);
  const retryRef = useRef(0);
  const neverOpenedFailures = useRef(0);
  const closedByUs = useRef(false);

  symbolsRef.current = symbols;

  useEffect(() => {
    closedByUs.current = false;
    let reconnectTimer: number | undefined;
    let pollTimer: number | undefined;

    const mergeQuotes = (incoming: Quote[]) =>
      setQuotes((prev) => {
        const next = { ...prev };
        for (const q of incoming) next[q.symbol] = q;
        return next;
      });

    const startPolling = () => {
      setStatus("polling");
      const poll = async () => {
        if (symbolsRef.current.length === 0) return;
        try {
          const res = await api.quotes(symbolsRef.current);
          mergeQuotes(res.quotes);
        } catch {
          /* transient fetch failure — next tick retries */
        }
      };
      void poll();
      pollTimer = window.setInterval(poll, POLL_INTERVAL_MS);
    };

    const connect = () => {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      let opened = false;
      const ws = new WebSocket(`${proto}//${window.location.host}/ws/quotes`);
      socketRef.current = ws;
      setStatus("connecting");

      ws.onopen = () => {
        opened = true;
        retryRef.current = 0;
        neverOpenedFailures.current = 0;
        setStatus("open");
        ws.send(JSON.stringify({ symbols: symbolsRef.current }));
      };

      ws.onmessage = (event) => {
        const payload = JSON.parse(event.data);
        if (payload.type === "quotes") mergeQuotes(payload.quotes as Quote[]);
      };

      ws.onclose = () => {
        if (closedByUs.current) return;
        if (!opened) {
          neverOpenedFailures.current += 1;
          if (neverOpenedFailures.current >= FAILURES_BEFORE_FALLBACK) {
            startPolling();
            return;
          }
        }
        setStatus("closed");
        const delay = Math.min(1000 * 2 ** retryRef.current++, 15000);
        reconnectTimer = window.setTimeout(connect, delay);
      };

      ws.onerror = () => ws.close();
    };

    connect();
    return () => {
      closedByUs.current = true;
      window.clearTimeout(reconnectTimer);
      window.clearInterval(pollTimer);
      socketRef.current?.close();
    };
  }, []);

  // Push watchlist changes: over the socket when open; polling mode picks the
  // ref up on its next tick automatically.
  useEffect(() => {
    const ws = socketRef.current;
    if (ws?.readyState === WebSocket.OPEN) {
      ws.send(JSON.stringify({ symbols }));
    }
  }, [symbols]);

  return { quotes, status };
}
