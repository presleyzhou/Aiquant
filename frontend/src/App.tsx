import { useEffect, useMemo, useState } from "react";
import { api, type Quote } from "./api";
import { AIPanel } from "./components/AIPanel";
import { BacktestPanel } from "./components/BacktestPanel";
import { FactorLab } from "./components/FactorLab";
import { Tour } from "./components/Tour";
import { KronosPanel } from "./components/KronosPanel";
import { ChartPanel } from "./components/ChartPanel";
import { MarketPage } from "./components/MarketPage";
import { StrategyLab } from "./components/StrategyLab";
import { TickerTape } from "./components/TickerTape";
import { Watchlist } from "./components/Watchlist";
import { useBinanceStream } from "./hooks/useBinanceStream";
import { useQuoteStream } from "./hooks/useQuoteStream";
import { useT } from "./i18n";
import { queueBacktestPreset } from "./store";
import {
  MARKETS,
  candlePalette,
  marketColorVars,
  type MarketId,
  type MarketProfile,
} from "./markets";

type View = MarketId | "lab" | "factors" | "market";

function loadWatchlist(profile: MarketProfile): string[] {
  try {
    const saved = localStorage.getItem(profile.storageKey);
    const parsed = saved ? JSON.parse(saved) : null;
    if (Array.isArray(parsed) && parsed.length) return parsed;
  } catch {
    /* corrupt storage — fall through to the defaults */
  }
  return profile.defaults;
}

interface AiState {
  enabled: boolean;
  model: string | null;
}

export default function App() {
  const { t, lang, setLang } = useT();
  const [view, setView] = useState<View>("us");
  // Which terminal the marketplace should act on (and the tape should show)
  // while the user is browsing the market page.
  const [lastTerminal, setLastTerminal] = useState<MarketId>("us");
  const [lists, setLists] = useState<Record<MarketId, string[]>>(() => ({
    us: loadWatchlist(MARKETS.us),
    crypto: loadWatchlist(MARKETS.crypto),
  }));
  const [actives, setActives] = useState<Record<MarketId, string>>(() => ({
    us: loadWatchlist(MARKETS.us)[0] ?? "AAPL",
    crypto: loadWatchlist(MARKETS.crypto)[0] ?? "BTC-USD",
  }));
  const [ai, setAi] = useState<AiState>({ enabled: false, model: null });

  // One socket / poll loop for both markets.
  const allSymbols = useMemo(
    () => [...new Set([...lists.us, ...lists.crypto])].slice(0, 25),
    [lists],
  );
  const { quotes: yahooQuotes, status } = useQuoteStream(allSymbols);
  // Crypto pairs get true second-level quotes straight from Binance; the
  // merge overrides Yahoo only for symbols that actually emitted a tick.
  const binanceQuotes = useBinanceStream(allSymbols);
  const quotes = useMemo(
    () => ({ ...yahooQuotes, ...binanceQuotes }),
    [yahooQuotes, binanceQuotes],
  );

  useEffect(() => {
    localStorage.setItem(MARKETS.us.storageKey, JSON.stringify(lists.us));
    localStorage.setItem(MARKETS.crypto.storageKey, JSON.stringify(lists.crypto));
  }, [lists]);

  useEffect(() => {
    api
      .aiStatus()
      .then((s) => setAi({ enabled: s.enabled, model: s.model }))
      .catch(() => setAi({ enabled: false, model: null }));
  }, []);

  const switchView = (next: View) => {
    setView(next);
    if (next === "us" || next === "crypto") setLastTerminal(next);
  };

  const add = (market: MarketId, symbol: string) => {
    setLists((prev) =>
      prev[market].includes(symbol) ? prev : { ...prev, [market]: [...prev[market], symbol] },
    );
    setActives((prev) => ({ ...prev, [market]: symbol }));
  };

  const remove = (market: MarketId, symbol: string) => {
    setLists((prev) => {
      const next = prev[market].filter((s) => s !== symbol);
      if (symbol === actives[market]) {
        setActives((a) => ({ ...a, [market]: next[0] ?? "" }));
      }
      return { ...prev, [market]: next };
    });
  };

  const select = (market: MarketId, symbol: string) => {
    setActives((prev) => ({ ...prev, [market]: symbol }));
  };

  const tapeMarket: MarketId = view === "us" || view === "crypto" ? view : lastTerminal;
  const tapeProfile = MARKETS[tapeMarket];
  const activeQuote: Quote | undefined = quotes[actives[tapeMarket]];

  /** Run an AI-generated strategy: put its symbol in the right workspace,
   * queue the preset addressed to that workspace, and switch over. */
  const runGeneratedStrategy = (symbol: string, name: string, payload: Record<string, unknown>) => {
    const market: MarketId = /-(USD|USDT)$/i.test(symbol) ? "crypto" : "us";
    add(market, symbol);
    queueBacktestPreset({ name, payload: { ...payload, symbol }, market });
    switchView(market);
  };

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand__mark">AIQUANT</span>
          <span className="brand__sub">TERMINAL</span>
        </div>
        <nav className="nav-tabs" aria-label="views">
          {(
            [
              ["us", t("nav.us")],
              ["crypto", t("nav.crypto")],
              ["lab", t("nav.lab")],
              ["factors", t("nav.factors")],
              ["market", t("nav.market")],
            ] as Array<[View, string]>
          ).map(([value, label]) => (
            <button
              key={value}
              className={`nav-tab${view === value ? " is-on" : ""}`}
              onClick={() => switchView(value)}
            >
              {label}
            </button>
          ))}
        </nav>
        <div className="status-row">
          <span className="status">
            <span
              className={`dot ${
                status === "open" || status === "polling"
                  ? "dot--on"
                  : status === "connecting"
                    ? "dot--warn"
                    : "dot--off"
              }`}
            />
            {t("status.quotes")}{" "}
            {status === "open"
              ? t("status.connected")
              : status === "polling"
                ? t("status.polling")
                : status === "connecting"
                  ? t("status.connecting")
                  : t("status.closed")}
          </span>
          <span className="status">
            <span className={`dot ${ai.enabled ? "dot--on" : "dot--off"}`} />
            AI {ai.enabled ? (ai.model ?? "on") : t("status.ai.off")}
          </span>
          {activeQuote?.as_of && (
            <span className="status dim">
              {t("status.updated")} {new Date(activeQuote.as_of).toLocaleTimeString()}
            </span>
          )}
          <button
            className="lang-toggle"
            onClick={() => setLang(lang === "zh" ? "en" : "zh")}
            title={lang === "zh" ? "Switch to English" : "切换为中文"}
          >
            {lang === "zh" ? "EN" : "中"}
          </button>
        </div>
      </header>

      <TickerTape
        profile={tapeProfile}
        symbols={lists[tapeMarket]}
        quotes={quotes}
        active={actives[tapeMarket]}
        onSelect={(symbol) => {
          select(tapeMarket, symbol);
          if (view === "market") switchView(tapeMarket);
        }}
      />

      {/* The market page conditionally mounts, but the terminal workspaces and
          the strategy lab only hide: unmounting would wipe AI conversations,
          chart state, or an in-flight generation on every tab switch. */}
      {view === "market" && <MarketPage onRunStrategy={() => switchView(lastTerminal)} />}
      <StrategyLab hidden={view !== "lab"} aiEnabled={ai.enabled} onRun={runGeneratedStrategy} />
      <FactorLab hidden={view !== "factors"} aiEnabled={ai.enabled} />
      {(["us", "crypto"] as MarketId[]).map((market) => (
        <TerminalWorkspace
          key={market}
          profile={MARKETS[market]}
          hidden={view !== market}
          symbols={lists[market]}
          quotes={quotes}
          active={actives[market]}
          ai={ai}
          presetTarget={lastTerminal === market}
          onSelect={(s) => select(market, s)}
          onAdd={(s) => add(market, s)}
          onRemove={(s) => remove(market, s)}
        />
      ))}

      <div className="disclaimer">{t("app.disclaimer")}</div>
      <Tour />
    </div>
  );
}

function TerminalWorkspace(props: {
  profile: MarketProfile;
  hidden: boolean;
  symbols: string[];
  quotes: Record<string, Quote>;
  active: string;
  ai: AiState;
  presetTarget: boolean;
  onSelect: (symbol: string) => void;
  onAdd: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}) {
  const { profile, hidden, symbols, quotes, active, ai, presetTarget, onSelect, onAdd, onRemove } =
    props;
  const { t } = useT();
  return (
    <div
      className="workspace"
      style={{ ...(hidden ? { display: "none" } : {}), ...marketColorVars(profile) } as never}
    >
      <div className="column">
        <Watchlist
          profile={profile}
          symbols={symbols}
          quotes={quotes}
          active={active}
          onSelect={onSelect}
          onAdd={onAdd}
          onRemove={onRemove}
        />
      </div>

      <div className="column">
        {active ? (
          <>
            <ChartPanel symbol={active} palette={candlePalette(profile)} />
            <KronosPanel symbol={active} marketId={profile.id} />
            <BacktestPanel symbol={active} marketId={profile.id} presetTarget={presetTarget} />
          </>
        ) : (
          <div className="panel panel--grow">
            <div className="empty">{t("app.addFirst")}</div>
          </div>
        )}
      </div>

      <div className="column">
        <AIPanel enabled={ai.enabled} model={ai.model} symbol={active || "SPY"} />
      </div>
    </div>
  );
}
