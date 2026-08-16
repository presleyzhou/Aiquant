import { useState } from "react";
import type { Quote } from "../api";
import { usePriceFlash } from "../hooks/usePriceFlash";
import { useT } from "../i18n";
import { displayName, type MarketProfile } from "../markets";
import { SymbolSearch } from "./SymbolSearch";

interface Props {
  profile: MarketProfile;
  symbols: string[];
  quotes: Record<string, Quote>;
  active: string;
  onSelect: (symbol: string) => void;
  onAdd: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}

export function Watchlist({ profile, symbols, quotes, active, onSelect, onAdd, onRemove }: Props) {
  const { t } = useT();
  const [draft, setDraft] = useState("");
  const flash = usePriceFlash(quotes);

  const submit = (e: React.FormEvent) => {
    e.preventDefault();
    const symbol = draft.trim().toUpperCase();
    if (!symbol) return;
    onAdd(symbol);
    setDraft("");
  };

  return (
    <div className="panel panel--grow">
      <div className="panel__head">
        <span className="panel__title">{t("watch.title")}</span>
        <span className="panel__meta">{symbols.length}</span>
      </div>

      <form className="watch-form" onSubmit={submit}>
        <SymbolSearch
          className="watch-form__search"
          value={draft}
          onChange={setDraft}
          marketBias={profile.id}
          placeholder={t(profile.id === "crypto" ? "watch.ph.crypto" : "watch.ph.us")}
          onPick={(hit) => {
            onAdd(hit.symbol.toUpperCase());
            setDraft("");
          }}
          onSubmit={() => {
            const symbol = draft.trim().toUpperCase();
            if (symbol) {
              onAdd(symbol);
              setDraft("");
            }
          }}
        />
        <button className="btn" type="submit">
          {t("watch.add")}
        </button>
      </form>
      {profile.id === "crypto" && <div className="watch-hint">{t("watch.hint.crypto")}</div>}

      <div className="panel__body panel__body--flush">
        {symbols.length === 0 ? (
          <div className="empty">{t("watch.empty")}</div>
        ) : (
          <ul className="watch-list">
            {symbols.map((symbol) => {
              const q = quotes[symbol];
              const pct = q?.change_pct;
              const tone = pct === undefined ? "flat" : pct > 0 ? "up" : pct < 0 ? "dn" : "flat";
              const name = displayName(profile, symbol);
              return (
                <li
                  key={symbol}
                  className={`watch-row${symbol === active ? " is-active" : ""}`}
                  onClick={() => onSelect(symbol)}
                >
                  <span className="watch-row__id">
                    <span className="watch-row__sym">{symbol}</span>
                    {name && <span className="watch-row__name">{name}</span>}
                  </span>
                  <span
                    key={q?.price}
                    className={`watch-row__px${flash[symbol] ? ` px--${flash[symbol]}` : ""}`}
                  >
                    {q?.error ? <span className="dim">n/a</span> : (q?.price?.toFixed(2) ?? "—")}
                  </span>
                  <span className={`watch-row__chg ${tone}`}>
                    {pct === undefined ? "" : `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`}
                  </span>
                  <button
                    className="watch-row__x"
                    title={`${t("watch.remove")} ${symbol}`}
                    aria-label={`${t("watch.remove")} ${symbol}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      onRemove(symbol);
                    }}
                  >
                    ×
                  </button>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
