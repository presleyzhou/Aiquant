import { useEffect, useRef } from "react";
import type { Quote } from "../api";

/**
 * Tracks the direction of each symbol's last price change.
 *
 * Pairs with the `key={price}` trick: when a price changes, the element
 * remounts and its mount animation replays, tinted by the returned direction.
 * The direction map is intentionally persistent — it only matters at the
 * moment of remount, so stale entries are harmless.
 */
export function usePriceFlash(quotes: Record<string, Quote>) {
  const prevRef = useRef<Record<string, number>>({});
  const dirRef = useRef<Record<string, "up" | "dn">>({});

  for (const [symbol, quote] of Object.entries(quotes)) {
    const prev = prevRef.current[symbol];
    if (quote.price !== undefined && prev !== undefined && quote.price !== prev) {
      dirRef.current[symbol] = quote.price > prev ? "up" : "dn";
    }
  }

  useEffect(() => {
    for (const [symbol, quote] of Object.entries(quotes)) {
      if (quote.price !== undefined) prevRef.current[symbol] = quote.price;
    }
  });

  return dirRef.current;
}
