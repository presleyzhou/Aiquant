import { Suspense, lazy, useEffect, useMemo, useState } from "react";
import { api, type Quote } from "./api";
import { AIPanel } from "./components/AIPanel";
import { BacktestPanel } from "./components/BacktestPanel";
import { Tour } from "./components/Tour";
import { UsagePopover } from "./components/UsagePopover";
import { ErrorBoundary } from "./components/ErrorBoundary";

// Code-split the heavy views: each loads on first visit and then stays
// mounted (hidden) so its state survives tab switches.
const StrategyLab = lazy(() => import("./components/StrategyLab").then((m) => ({ default: m.StrategyLab })));
const FactorLab = lazy(() => import("./components/FactorLab").then((m) => ({ default: m.FactorLab })));
const PipelinePage = lazy(() => import("./components/PipelinePage").then((m) => ({ default: m.PipelinePage })));
const PaperPage = lazy(() => import("./components/PaperPage").then((m) => ({ default: m.PaperPage })));
const MarketPage = lazy(() => import("./components/MarketPage").then((m) => ({ default: m.MarketPage })));
import { parseShareFromUrl } from "./share";
import { KronosPanel } from "./components/KronosPanel";
import { NewsPanel } from "./components/NewsPanel";
import { ChartPanel } from "./components/ChartPanel";
import { TickerTape } from "./components/TickerTape";
import { Watchlist } from "./components/Watchlist";
import { useAlerts } from "./hooks/useAlerts";
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

type View = MarketId | "lab" | "factors" | "pipeline" | "paper" | "market";

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
  // views that have been opened at least once — mounted lazily, kept alive after
  const [visited, setVisited] = useState<Set<View>>(() => new Set<View>(["us"]));
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
  const { toasts, version: alertsVersion, bump: bumpAlerts } = useAlerts(quotes);

  useEffect(() => {
    localStorage.setItem(MARKETS.us.storageKey, JSON.stringify(lists.us));
    localStorage.setItem(MARKETS.crypto.storageKey, JSON.stringify(lists.crypto));
  }, [lists]);

  // Shared-link replay: switch to the right workspace, add the symbol, and
  // (for backtests) queue the preset — panels handle the rest themselves.
  useEffect(() => {
    // Payment / Connect return links land on the market view.
    if (new URLSearchParams(window.location.search).get("view") === "market") {
      switchView("market");
      return;
    }
    const share = parseShareFromUrl();
    if (!share) return;
    const market = share.market as MarketId;
    if (share.symbol) {
      add(market, share.symbol);
      select(market, share.symbol);
    }
    if (share.kind === "fb") {
      switchView("factors");
      return;
    }
    switchView(market);
    if (share.kind === "bt" && share.symbol && share.backtestPayload) {
      queueBacktestPreset({
        name: t("share.preset"),
        payload: { ...share.backtestPayload, symbol: share.symbol },
        market,
      });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    api
      .aiStatus()
      .then((s) => setAi({ enabled: s.enabled, model: s.model }))
      .catch(() => setAi({ enabled: false, model: null }));
  }, []);

  const switchView = (next: View) => {
    setVisited((prev) => (prev.has(next) ? prev : new Set(prev).add(next)));
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
              ["pipeline", t("nav.pipeline")],
              ["paper", t("nav.paper")],
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
          <UsagePopover model={ai.enabled ? (ai.model ?? "on") : null} />
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
      <Suspense fallback={<div className="lab"><div className="lab__inner"><div className="empty">…</div></div></div>}>
        {view === "market" && (
          <ErrorBoundary name="市场">
            <MarketPage onRunStrategy={() => switchView(lastTerminal)} />
          </ErrorBoundary>
        )}
        {visited.has("lab") && (
          <ErrorBoundary name="AI 策略">
            <StrategyLab hidden={view !== "lab"} aiEnabled={ai.enabled} onRun={runGeneratedStrategy} />
          </ErrorBoundary>
        )}
        {visited.has("factors") && (
          <ErrorBoundary name="因子挖掘">
            <FactorLab hidden={view !== "factors"} aiEnabled={ai.enabled} />
          </ErrorBoundary>
        )}
        {visited.has("pipeline") && (
          <ErrorBoundary name="端到端量化">
            <PipelinePage hidden={view !== "pipeline"} />
          </ErrorBoundary>
        )}
        {visited.has("paper") && (
          <ErrorBoundary name="模拟持仓">
            <PaperPage hidden={view !== "paper"} />
          </ErrorBoundary>
        )}
      </Suspense>
      {(["us", "crypto"] as MarketId[]).map((market) => (
        <TerminalWorkspace
          key={market}
          profile={MARKETS[market]}
          hidden={view !== market}
          symbols={lists[market]}
          quotes={quotes}
          active={actives[market]}
          ai={ai}
          alertsVersion={alertsVersion}
          onAlertsChange={bumpAlerts}
          presetTarget={lastTerminal === market}
          onSelect={(s) => select(market, s)}
          onAdd={(s) => add(market, s)}
          onRemove={(s) => remove(market, s)}
        />
      ))}

      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((toast) => (
            <div key={toast.id} className="toast">
              <b>{toast.symbol}</b>{" "}
              {toast.dir === "above" ? t("al.hitAbove") : t("al.hitBelow")} {toast.price}
              <span className="dim"> · {t("al.now")} {toast.actual}</span>
            </div>
          ))}
        </div>
      )}
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
  alertsVersion: number;
  onAlertsChange: () => void;
  presetTarget: boolean;
  onSelect: (symbol: string) => void;
  onAdd: (symbol: string) => void;
  onRemove: (symbol: string) => void;
}) {
  const {
    profile,
    hidden,
    symbols,
    quotes,
    active,
    ai,
    alertsVersion,
    onAlertsChange,
    presetTarget,
    onSelect,
    onAdd,
    onRemove,
  } = props;
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
          alertsVersion={alertsVersion}
          onAlertsChange={onAlertsChange}
          onSelect={onSelect}
          onAdd={onAdd}
          onRemove={onRemove}
        />
      </div>

      <div className="column">
        {active ? (
          <>
            <ErrorBoundary name="走势">
              <ChartPanel symbol={active} palette={candlePalette(profile)} />
            </ErrorBoundary>
            <ErrorBoundary name="Kronos">
              <KronosPanel symbol={active} marketId={profile.id} />
            </ErrorBoundary>
            <ErrorBoundary name="策略回测">
              <BacktestPanel symbol={active} marketId={profile.id} presetTarget={presetTarget} />
            </ErrorBoundary>
          </>
        ) : (
          <div className="panel panel--grow">
            <div className="empty">{t("app.addFirst")}</div>
          </div>
        )}
      </div>

      <div className="column">
        <ErrorBoundary name="新闻情绪">
          <NewsPanel symbol={active || "SPY"} aiEnabled={ai.enabled} />
        </ErrorBoundary>
        <ErrorBoundary name="AI 分析">
          <AIPanel enabled={ai.enabled} model={ai.model} symbol={active || "SPY"} />
        </ErrorBoundary>
      </div>
    </div>
  );
}
