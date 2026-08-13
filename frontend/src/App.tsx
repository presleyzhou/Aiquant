import { useEffect, useMemo, useState } from "react";
import { api } from "./api";
import { AIPanel } from "./components/AIPanel";
import { BacktestPanel } from "./components/BacktestPanel";
import { ChartPanel } from "./components/ChartPanel";
import { MarketPage } from "./components/MarketPage";
import { Watchlist } from "./components/Watchlist";
import { useQuoteStream } from "./hooks/useQuoteStream";

const DEFAULT_WATCHLIST = ["AAPL", "MSFT", "NVDA", "SPY", "TSLA", "BTC-USD"];
const STORAGE_KEY = "aiquant.watchlist";

export default function App() {
  const [symbols, setSymbols] = useState<string[]>(() => {
    try {
      const saved = localStorage.getItem(STORAGE_KEY);
      const parsed = saved ? JSON.parse(saved) : null;
      if (Array.isArray(parsed) && parsed.length) return parsed;
    } catch {
      /* corrupt storage — fall through to the default list */
    }
    return DEFAULT_WATCHLIST;
  });
  const [active, setActive] = useState(symbols[0] ?? "AAPL");
  const [view, setView] = useState<"terminal" | "market">("terminal");
  const [ai, setAi] = useState<{ enabled: boolean; model: string | null }>({
    enabled: false,
    model: null,
  });

  const { quotes, status } = useQuoteStream(symbols);

  useEffect(() => {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(symbols));
  }, [symbols]);

  useEffect(() => {
    api
      .aiStatus()
      .then((s) => setAi({ enabled: s.enabled, model: s.model }))
      .catch(() => setAi({ enabled: false, model: null }));
  }, []);

  const add = (symbol: string) => {
    setSymbols((prev) => (prev.includes(symbol) ? prev : [...prev, symbol]));
    setActive(symbol);
  };

  const remove = (symbol: string) => {
    setSymbols((prev) => {
      const next = prev.filter((s) => s !== symbol);
      // Keep a valid selection when the active symbol is the one removed.
      if (symbol === active) setActive(next[0] ?? "");
      return next;
    });
  };

  const activeQuote = quotes[active];
  const tape = useMemo(() => symbols.slice(0, 12), [symbols]);

  return (
    <div className="app">
      <header className="header">
        <div className="brand">
          <span className="brand__mark">AIQUANT</span>
          <span className="brand__sub">TERMINAL</span>
        </div>
        <nav className="nav-tabs" aria-label="页面切换">
          <button
            className={`nav-tab${view === "terminal" ? " is-on" : ""}`}
            onClick={() => setView("terminal")}
          >
            终端
          </button>
          <button
            className={`nav-tab${view === "market" ? " is-on" : ""}`}
            onClick={() => setView("market")}
          >
            市场
          </button>
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

      <div className="ticker">
        {tape.map((symbol) => {
          const q = quotes[symbol];
          const pct = q?.change_pct;
          const tone = pct === undefined ? "flat" : pct > 0 ? "up" : pct < 0 ? "dn" : "flat";
          return (
            <button
              key={symbol}
              className={`ticker__item${symbol === active ? " is-active" : ""}`}
              onClick={() => setActive(symbol)}
            >
              <span className="ticker__sym">{symbol}</span>
              <span className="ticker__px">{q?.price?.toFixed(2) ?? "—"}</span>
              <span className={tone}>
                {pct === undefined ? "" : `${pct > 0 ? "+" : ""}${pct.toFixed(2)}%`}
              </span>
            </button>
          );
        })}
      </div>

      {/* The market page conditionally mounts, but the workspace only hides:
          unmounting it would wipe the AI conversation and chart state every
          time the user browses the marketplace. */}
      {view === "market" && <MarketPage onRunStrategy={() => setView("terminal")} />}
      <div className="workspace" style={view === "market" ? { display: "none" } : undefined}>
          <div className="column">
            <Watchlist
              symbols={symbols}
              quotes={quotes}
              active={active}
              onSelect={setActive}
              onAdd={add}
              onRemove={remove}
            />
          </div>

          <div className="column">
            {active ? (
              <>
                <ChartPanel symbol={active} />
                <BacktestPanel symbol={active} />
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

      <div className="disclaimer">
        本站仅供研究与教育用途，不构成投资建议。行情数据来自公开数据源，可能存在延迟或误差；回测结果不代表未来收益。
      </div>
    </div>
  );
}
