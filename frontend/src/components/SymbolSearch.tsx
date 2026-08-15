import { useEffect, useRef, useState } from "react";
import { api, type SymbolHit } from "../api";

interface Props {
  value: string;
  onChange: (value: string) => void;
  /** User picked a suggestion. */
  onPick: (hit: SymbolHit) => void;
  /** Enter pressed with no suggestion highlighted — submit the raw text. */
  onSubmit?: () => void;
  placeholder?: string;
  disabled?: boolean;
  /** Rank this market's symbols first ("cn" → .SS/.SZ on top). */
  marketBias?: "us" | "cn";
  className?: string;
}

const DEBOUNCE_MS = 250;

/** Text input with fuzzy symbol lookup: type a code, a Chinese/English name,
 * or pinyin initials (gzmt → 贵州茅台) and pick from the dropdown. */
export function SymbolSearch({
  value,
  onChange,
  onPick,
  onSubmit,
  placeholder,
  disabled,
  marketBias,
  className,
}: Props) {
  const [hits, setHits] = useState<SymbolHit[]>([]);
  const [open, setOpen] = useState(false);
  const [cursor, setCursor] = useState(-1);
  const timerRef = useRef<number | undefined>(undefined);
  const seqRef = useRef(0);

  useEffect(() => () => window.clearTimeout(timerRef.current), []);

  const rank = (results: SymbolHit[]): SymbolHit[] => {
    if (!marketBias) return results;
    const isCN = (s: string) => /\.(SS|SZ)$/i.test(s);
    return [...results].sort((a, b) => {
      const aMine = isCN(a.symbol) === (marketBias === "cn") ? 0 : 1;
      const bMine = isCN(b.symbol) === (marketBias === "cn") ? 0 : 1;
      return aMine - bMine;
    });
  };

  const query = (text: string) => {
    window.clearTimeout(timerRef.current);
    const trimmed = text.trim();
    if (!trimmed) {
      setHits([]);
      setOpen(false);
      return;
    }
    timerRef.current = window.setTimeout(async () => {
      const seq = ++seqRef.current;
      try {
        const res = await api.searchSymbols(trimmed);
        if (seq !== seqRef.current) return; // a newer query superseded this one
        setHits(rank(res.results));
        setOpen(true);
        setCursor(-1);
      } catch {
        /* search is a convenience — typing the raw code still works */
      }
    }, DEBOUNCE_MS);
  };

  const pick = (hit: SymbolHit) => {
    setOpen(false);
    setHits([]);
    onPick(hit);
  };

  const handleKey = (e: React.KeyboardEvent) => {
    if (!open || hits.length === 0) {
      if (e.key === "Enter" && onSubmit) {
        e.preventDefault();
        onSubmit();
      }
      return;
    }
    if (e.key === "ArrowDown") {
      e.preventDefault();
      setCursor((c) => (c + 1) % hits.length);
    } else if (e.key === "ArrowUp") {
      e.preventDefault();
      setCursor((c) => (c <= 0 ? hits.length - 1 : c - 1));
    } else if (e.key === "Enter") {
      e.preventDefault();
      if (cursor >= 0) pick(hits[cursor]);
      else if (onSubmit) onSubmit();
    } else if (e.key === "Escape") {
      setOpen(false);
    }
  };

  return (
    <div className={`symsearch ${className ?? ""}`}>
      <input
        className="input symsearch__input"
        value={value}
        placeholder={placeholder}
        disabled={disabled}
        onChange={(e) => {
          onChange(e.target.value);
          query(e.target.value);
        }}
        onFocus={() => hits.length > 0 && setOpen(true)}
        onBlur={() => window.setTimeout(() => setOpen(false), 120)}
        onKeyDown={handleKey}
        autoComplete="off"
        spellCheck={false}
      />
      {open && hits.length > 0 && (
        <ul className="symsearch__list" role="listbox">
          {hits.map((hit, i) => (
            <li
              key={hit.symbol}
              role="option"
              aria-selected={i === cursor}
              className={`symsearch__item${i === cursor ? " is-cursor" : ""}`}
              onMouseDown={(e) => {
                e.preventDefault(); // beat the input's blur
                pick(hit);
              }}
              onMouseEnter={() => setCursor(i)}
            >
              <span className="symsearch__sym">{hit.symbol}</span>
              <span className="symsearch__name">{hit.name}</span>
              <span className="symsearch__exch">{hit.exchange}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
