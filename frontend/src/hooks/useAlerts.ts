import { useEffect, useRef, useState } from "react";
import type { Quote } from "../api";
import { markTriggered, savedAlerts, type PriceAlert } from "../store";

export interface AlertToast {
  id: string;
  symbol: string;
  dir: "above" | "below";
  price: number;
  actual: number;
}

/** Rule engine over the live quote stream. Armed alerts fire once when the
 * price crosses the level, produce an in-app toast, and (when permitted) a
 * browser notification — then disarm until the user re-arms them. */
export function useAlerts(quotes: Record<string, Quote>) {
  const [toasts, setToasts] = useState<AlertToast[]>([]);
  const [version, setVersion] = useState(0); // bump to re-read rules after CRUD
  const firedRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    const armed = savedAlerts().filter((a) => !a.triggeredAt);
    for (const alert of armed) {
      if (firedRef.current.has(alert.id)) continue;
      const price = quotes[alert.symbol]?.price;
      if (price === undefined) continue;
      const hit = alert.dir === "above" ? price >= alert.price : price <= alert.price;
      if (!hit) continue;

      firedRef.current.add(alert.id);
      markTriggered(alert.id);
      setVersion((v) => v + 1);
      const toast: AlertToast = { id: alert.id, symbol: alert.symbol, dir: alert.dir, price: alert.price, actual: price };
      setToasts((prev) => [...prev.slice(-3), toast]);
      window.setTimeout(
        () => setToasts((prev) => prev.filter((t) => t.id !== alert.id)),
        10_000,
      );
      notify(alert, price);
    }
  }, [quotes]);

  return { toasts, version, bump: () => setVersion((v) => v + 1) };
}

function notify(alert: PriceAlert, actual: number) {
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    new Notification(`AIQUANT · ${alert.symbol}`, {
      body: `${alert.dir === "above" ? "↑ 上穿" : "↓ 下破"} ${alert.price} （现价 ${actual}）`,
      icon: "/icon-192.png",
      tag: alert.id,
    });
  } catch {
    /* notification construction can throw on some mobile browsers */
  }
}

export function requestNotifyPermission() {
  if ("Notification" in window && Notification.permission === "default") {
    void Notification.requestPermission();
  }
}
