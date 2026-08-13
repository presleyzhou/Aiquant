import { useMemo } from "react";
import type { Quote } from "../api";
import { usePriceFlash } from "../hooks/usePriceFlash";
import { displayName, marketColorVars, type MarketProfile } from "../markets";

interface Props {
  profile: MarketProfile;
  symbols: string[];
  quotes: Record<string, Quote>;
  active: string;
  onSelect: (symbol: string) => void;
}

/** Auto-scrolling tape. The list is repeated so one half is always at least a
 * screen wide, then doubled; animating to -50% loops seamlessly. Hover pauses
 * it (so items stay clickable), and reduced-motion turns it back into a
 * plain scrollable strip. */
export function TickerTape({ profile, symbols, quotes, active, onSelect }: Props) {
  const flash = usePriceFlash(quotes);

  const half = useMemo(() => {
    const base = symbols.slice(0, 16);
    if (base.length === 0) return [];
    const reps = Math.max(1, Math.ceil(10 / base.length));
    return Array.from({ length: reps }, () => base).flat();
  }, [symbols]);

  if (half.length === 0) return <div className="ticker" />;

  // ~4.5s of travel per item keeps the speed constant regardless of list size.
  const duration = Math.round(half.length * 4.5);

  const renderItem = (symbol: string, index: number, decorative: boolean) => {
    const q = quotes[symbol];
    const pct = q?.change_pct;
    const tone = pct === undefined ? "flat" : pct > 0 ? "up" : pct < 0 ? "dn" : "flat";
    const name = displayName(profile, symbol);
    return (
      <button
        key={`${decorative ? "b" : "a"}-${index}`}
        className={`ticker__item${symbol === active && !decorative ? " is-active" : ""}`}
        onClick={() => onSelect(symbol)}
        aria-hidden={decorative || undefined}
        tabIndex={decorative ? -1 : undefined}
      >
        <span className="ticker__sym">{symbol}</span>
        {name && <span className="ticker__name">{name}</span>}
        <span key={q?.price} className={`ticker__px${flash[symbol] ? ` px--${flash[symbol]}` : ""}`}>
          {q?.price?.toFixed(2) ?? "—"}
        </span>
        <span className={tone}>
          {pct === undefined ? "" : `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`}
        </span>
      </button>
    );
  };

  return (
    <div className="ticker" style={marketColorVars(profile) as never}>
      <div
        className="ticker__track"
        key={`${profile.id}:${half.length}`}
        style={{ animationDuration: `${duration}s` }}
      >
        {half.map((s, i) => renderItem(s, i, false))}
        {half.map((s, i) => renderItem(s, i, true))}
      </div>
    </div>
  );
}
