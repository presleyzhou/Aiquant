import { useCallback, useEffect, useMemo, useState } from "react";
import { api, type Quote } from "./api";
import { AIPanel } from "./components/AIPanel";
import { BacktestPanel } from "./components/BacktestPanel";
import { ChartPanel } from "./components/ChartPanel";
import { MarketPage } from "./components/MarketPage";
import { StrategyLab } from "./components/StrategyLab";
import { TickerTape } from "./components/TickerTape";
import { Watchlist } from "./components/Watchlist";
import { useQuoteStream } from "./hooks/useQuoteStream";
import { queueBacktestPreset } from "./store";
import {
  MARKETS,
  candlePalette,
  marketColorVars,
  type MarketId,
  type MarketProfile,
} from "./markets";

type View = MarketId | "lab" | "market";

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
  const [view, setView] = useState<View>("us");
  // Which terminal the marketplace should act on (and the tape should show)
  // while the user is browsing the market page.
  const [lastTerminal, setLastTerminal] = useState<MarketId>("us");
  const [lists, setLists] = useState<Record<MarketId, string[]>>(() => ({
    us: loadWatchlist(MARKETS.us),
    cn: loadWatchlist(MARKETS.cn),
  }));
  const [actives, setActives] = useState<Record<MarketId, string>>(() => ({
    us: loadWatchlist(MARKETS.us)[0] ?? "AAPL",
    cn: loadWatchlist(MARKETS.cn)[0] ?? "600519.SS",
  }));
  const [ai, setAi] = useState<AiState>({ enabled: false, model: null });

  // One socket / poll loop for both markets.
  const allSymbols = useMemo(
    () => [...new Set([...lists.us, ...lists.cn])].slice(0, 25),
    [lists],
  );
  const { quotes, status } = useQuoteStream(allSymbols);

  useEffect(() => {
    localStorage.setItem(MARKETS.us.storageKey, JSON.stringify(lists.us));
    localStorage.setItem(MARKETS.cn.storageKey, JSON.stringify(lists.cn));
  }, [lists]);

  useEffect(() => {
    api
      .aiStatus()
      .then((s) => setAi({ enabled: s.enabled, model: s.model }))
      .catch(() => setAi({ enabled: false, model: null }));
  }, []);

  const switchView = useCallback((next: View) => {
    setView(next);
    if (next === "us" || next === "cn") setLastTerminal(next);
  }, []);

  const add = useCallback((market: MarketId, symbol: string) => {
    setLists((prev) =>
      prev[market].includes(symbol) ? prev : { ...prev, [market]: [...prev[market], symbol] },
    );
    setActives((prev) => ({ ...prev, [market]: symbol }));
  }, []);

  const remove = (market: MarketId, symbol: string) => {
    // Two separate setState calls, not a nested one: updater functions must be
    // pure (StrictMode double-invokes them; concurrent React may replay them).
    const next = lists[market].filter((s) => s !== symbol);
    setLists((prev) => ({ ...prev, [market]: next }));
    if (symbol === actives[market]) {
      setActives((a) => ({ ...a, [market]: next[0] ?? "" }));
    }
  };

  const select = useCallback((market: MarketId, symbol: string) => {
    setActives((prev) => ({ ...prev, [market]: symbol }));
  }, []);

  const tapeMarket: MarketId = view === "us" || view === "cn" ? view : lastTerminal;
  const tapeProfile = MARKETS[tapeMarket];
  const activeQuote: Quote | undefined = quotes[actives[tapeMarket]];

  /** Run an AI-generated strategy: put its symbol in the right workspace,
   * queue the preset addressed to that workspace, and switch over. */
  const runGeneratedStrategy = useCallback(
    (symbol: string, name: string, payload: Record<string, unknown>) => {
      const market: MarketId = /\.(SS|SZ)$/i.test(symbol) ? "cn" : "us";
      add(market, symbol);
      queueBacktestPreset({ name, payload: { ...payload, symbol }, market });
      switchView(market);
    },
    [add, switchView],
  );

  const openLastTerminal = useCallback(() => switchView(lastTerminal), [switchView, lastTerminal]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand__mark">AIQUANT</span>
          <span className="brand__sub">TERMINAL</span>
        </div>
        <nav className="nav-tabs" aria-label="页面切换">
          {(
            [
              ["us", MARKETS.us.label],
              ["cn", MARKETS.cn.label],
              ["lab", "AI 策略"],
              ["market", "市场"],
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
            行情{" "}
            {status === "open"
              ? "已连接"
              : status === "polling"
                ? "轮询模式"
                : status === "connecting"
                  ? "连接中"
                  : "已断开"}
          </span>
          <span className="status">
            <span className={`dot ${ai.enabled ? "dot--on" : "dot--off"}`} />
            AI {ai.enabled ? (ai.model ?? "在线") : "未配置"}
          </span>
          {activeQuote?.as_of && (
            <span className="status dim">
              更新于 {new Date(activeQuote.as_of).toLocaleTimeString()}
            </span>
          )}
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
      {view === "market" && <MarketPage onRunStrategy={openLastTerminal} />}
      <StrategyLab hidden={view !== "lab"} aiEnabled={ai.enabled} onRun={runGeneratedStrategy} />
      {(["us", "cn"] as MarketId[]).map((market) => (
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

      <div className="disclaimer">
        本站仅供研究与教育用途，不构成投资建议。行情数据来自公开数据源，可能存在延迟或误差；回测结果不代表未来收益。
      </div>
    </div>
  );
}

function TerminalWorkspace({
  profile,
  hidden,
  symbols,
  quotes,
  active,
  ai,
  presetTarget,
  onSelect,
  onAdd,
  onRemove,
}: {
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
            <BacktestPanel symbol={active} marketId={profile.id} presetTarget={presetTarget} />
          </>
        ) : (
          <div className="panel panel--grow">
            <div className="empty">先在左侧添加一个标的</div>
          </div>
        )}
      </div>

      <div className="column">
        <AIPanel enabled={ai.enabled} model={ai.model} symbol={active || "市场"} />
      </div>
    </div>
  );
}
