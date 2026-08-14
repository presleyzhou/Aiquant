import { useEffect, useRef, useState } from "react";
import { api, type BacktestResult } from "../api";
import { EVENTS, takeBacktestPresetFor } from "../store";
import { EquityChart } from "./EquityChart";

const STRATEGIES = [
  { value: "sma_cross", label: "SMA 交叉" },
  { value: "ema_cross", label: "EMA 交叉" },
  { value: "rsi_reversion", label: "RSI 均值回归" },
  { value: "buy_and_hold", label: "买入持有" },
];

const PERIODS = ["1y", "2y", "5y", "max"];

interface Props {
  symbol: string;
  /** Which workspace this panel lives in ("us" | "cn"). Presets that name a
   *  market are claimed by the matching panel. */
  marketId?: string;
  /** Fallback claim for presets without an explicit market (marketplace flow):
   *  true on the panel of the last-active terminal. */
  presetTarget?: boolean;
}

export function BacktestPanel({ symbol, marketId = "us", presetTarget = true }: Props) {
  const [strategy, setStrategy] = useState("sma_cross");
  const [period, setPeriod] = useState("2y");
  const [fast, setFast] = useState(20);
  const [slow, setSlow] = useState(50);
  const [rsiPeriod, setRsiPeriod] = useState(14);
  const [rsiOversold, setRsiOversold] = useState(30);
  const [rsiOverbought, setRsiOverbought] = useState(70);
  const [presetName, setPresetName] = useState<string | null>(null);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const symbolRef = useRef(symbol);
  symbolRef.current = symbol;
  const presetTargetRef = useRef(presetTarget);
  presetTargetRef.current = presetTarget;

  const isCross = strategy === "sma_cross" || strategy === "ema_cross";
  const isRsi = strategy === "rsi_reversion";

  const execute = async (body: Record<string, unknown>) => {
    setRunning(true);
    setError(null);
    try {
      setResult(await api.backtest(body));
    } catch (err) {
      setError((err as Error).message);
      setResult(null);
    } finally {
      setRunning(false);
    }
  };

  const run = () => {
    setPresetName(null);
    void execute({
      symbol,
      strategy,
      period,
      fast,
      slow,
      rsi_period: rsiPeriod,
      rsi_oversold: rsiOversold,
      rsi_overbought: rsiOverbought,
    });
  };

  // Marketplace presets: apply the payload to the form and run it immediately
  // against whichever symbol is active. Checked on mount and whenever the
  // marketplace fires the preset event (the panel stays mounted across views).
  useEffect(() => {
    const applyPending = () => {
      const preset = takeBacktestPresetFor(marketId, presetTargetRef.current);
      if (!preset) return;
      const p = preset.payload;
      if (typeof p.strategy === "string") setStrategy(p.strategy);
      if (typeof p.period === "string") setPeriod(p.period);
      if (typeof p.fast === "number") setFast(p.fast);
      if (typeof p.slow === "number") setSlow(p.slow);
      if (typeof p.rsi_period === "number") setRsiPeriod(p.rsi_period);
      if (typeof p.rsi_oversold === "number") setRsiOversold(p.rsi_oversold);
      if (typeof p.rsi_overbought === "number") setRsiOverbought(p.rsi_overbought);
      setPresetName(preset.name);
      void execute({ symbol: symbolRef.current, ...p });
    };
    applyPending();
    window.addEventListener(EVENTS.preset, applyPending);
    return () => window.removeEventListener(EVENTS.preset, applyPending);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const s = result?.stats;

  return (
    <div className="panel panel--results">
      <div className="panel__head">
        <span className="panel__title">
          策略回测
          {presetName && <span style={{ color: "var(--cyan)" }}> · {presetName}</span>}
        </span>
        <span className="panel__meta">{result ? `${result.symbol} · ${result.period}` : symbol}</span>
      </div>

      <div className="control-grid">
        <label className="field">
          <span className="field__label">策略</span>
          <select
            className="select"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
          >
            {STRATEGIES.map((x) => (
              <option key={x.value} value={x.value}>
                {x.label}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">区间</span>
          <select className="select" value={period} onChange={(e) => setPeriod(e.target.value)}>
            {PERIODS.map((p) => (
              <option key={p} value={p}>
                {p}
              </option>
            ))}
          </select>
        </label>

        {isCross && (
          <>
            <label className="field">
              <span className="field__label">快线</span>
              <input
                className="input"
                type="number"
                min={2}
                max={200}
                value={fast}
                onChange={(e) => setFast(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">慢线</span>
              <input
                className="input"
                type="number"
                min={3}
                max={400}
                value={slow}
                onChange={(e) => setSlow(Number(e.target.value))}
              />
            </label>
          </>
        )}

        {isRsi && (
          <>
            <label className="field">
              <span className="field__label">RSI 周期</span>
              <input
                className="input"
                type="number"
                min={2}
                max={100}
                value={rsiPeriod}
                onChange={(e) => setRsiPeriod(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">超卖</span>
              <input
                className="input"
                type="number"
                min={1}
                max={50}
                value={rsiOversold}
                onChange={(e) => setRsiOversold(Number(e.target.value))}
              />
            </label>
            <label className="field">
              <span className="field__label">超买</span>
              <input
                className="input"
                type="number"
                min={50}
                max={99}
                value={rsiOverbought}
                onChange={(e) => setRsiOverbought(Number(e.target.value))}
              />
            </label>
          </>
        )}

        <label className="field">
          <span className="field__label">&nbsp;</span>
          <button className="btn btn--primary" onClick={run} disabled={running}>
            {running ? "计算中…" : "运行回测"}
          </button>
        </label>
      </div>

      {error && <div className="err">{error}</div>}

      {!result && !error && (
        <div className="empty">选择策略后点“运行回测”。下一根 bar 开盘成交，含手续费与滑点。</div>
      )}

      {s && result && (
        <>
          <EquityChart
            equity={result.equity_curve}
            benchmark={result.benchmark_curve}
            drawdown={result.drawdown_curve}
          />

          <div className="stat-grid">
            <Stat label="总收益" value={pct(s.total_return_pct)} tone={s.total_return_pct} />
            <Stat
              label="超额 vs 买入持有"
              value={pct(s.excess_vs_buy_hold_pct)}
              tone={s.excess_vs_buy_hold_pct}
            />
            <Stat label="年化" value={pct(s.cagr_pct)} tone={s.cagr_pct} />
            <Stat label="夏普" value={s.sharpe.toFixed(2)} tone={s.sharpe} />
            <Stat label="索提诺" value={s.sortino.toFixed(2)} tone={s.sortino} />
            <Stat label="最大回撤" value={pct(s.max_drawdown_pct)} tone={-1} />
            <Stat label="胜率" value={`${s.win_rate_pct.toFixed(1)}%`} />
            <Stat label="盈亏比" value={s.profit_factor?.toFixed(2) ?? "—"} />
            <Stat label="交易次数" value={String(s.trade_count)} />
            <Stat label="买入持有" value={pct(s.buy_hold_return_pct)} tone={s.buy_hold_return_pct} />
          </div>

          {result.trades.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>入场</th>
                    <th>出场</th>
                    <th style={{ textAlign: "right" }}>盈亏</th>
                    <th style={{ textAlign: "right" }}>收益</th>
                  </tr>
                </thead>
                <tbody>
                  {[...result.trades].reverse().map((t, i) => (
                    <tr key={i}>
                      <td>{day(t.entry_time)}</td>
                      <td>{t.exit_time ? day(t.exit_time) : "持仓中"}</td>
                      <td
                        style={{ textAlign: "right" }}
                        className={(t.pnl ?? 0) >= 0 ? "up" : "dn"}
                      >
                        {t.pnl?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "—"}
                      </td>
                      <td
                        style={{ textAlign: "right" }}
                        className={(t.return_pct ?? 0) >= 0 ? "up" : "dn"}
                      >
                        {t.return_pct !== null ? `${t.return_pct.toFixed(2)}%` : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function Stat({ label, value, tone }: { label: string; value: string; tone?: number }) {
  const cls = tone === undefined ? "" : tone > 0 ? "up" : tone < 0 ? "dn" : "";
  return (
    <div className="stat">
      <div className="stat__label">{label}</div>
      <div className={`stat__value ${cls}`}>{value}</div>
    </div>
  );
}

const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
const day = (epoch: number) => new Date(epoch * 1000).toISOString().slice(0, 10);
