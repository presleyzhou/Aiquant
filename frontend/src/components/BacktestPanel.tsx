import { useEffect, useRef, useState } from "react";
import { api, type BacktestResult } from "../api";
import { useT } from "../i18n";
import { EVENTS, takeBacktestPresetFor } from "../store";
import { buildBacktestShare } from "../share";
import { ShareButton } from "./ShareButton";
import { EquityChart } from "./EquityChart";

const STRATEGY_KEYS = [
  ["sma_cross", "bt.strat.sma"],
  ["ema_cross", "bt.strat.ema"],
  ["rsi_reversion", "bt.strat.rsi"],
  ["kronos_signal", "bt.strat.kronos"],
  ["buy_and_hold", "bt.strat.bh"],
] as const;

const PERIODS = ["1y", "2y", "5y", "max"];

interface Props {
  symbol: string;
  /** Which workspace this panel lives in ("us" | "crypto"). Presets that name a
   *  market are claimed by the matching panel. */
  marketId?: string;
  /** Fallback claim for presets without an explicit market (marketplace flow):
   *  true on the panel of the last-active terminal. */
  presetTarget?: boolean;
}

export function BacktestPanel({ symbol, marketId = "us", presetTarget = true }: Props) {
  const { t } = useT();
  const [strategy, setStrategy] = useState("sma_cross");
  const [period, setPeriod] = useState("2y");
  const [fast, setFast] = useState(20);
  const [slow, setSlow] = useState(50);
  const [rsiPeriod, setRsiPeriod] = useState(14);
  const [rsiOversold, setRsiOversold] = useState(30);
  const [rsiOverbought, setRsiOverbought] = useState(70);
  const [kronosHorizon, setKronosHorizon] = useState(14);
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
  const isKronos = strategy === "kronos_signal";

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
      kronos_horizon: kronosHorizon,
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
      if (typeof p.kronos_horizon === "number") setKronosHorizon(p.kronos_horizon);
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
          {t("bt.title")}
          {presetName && <span style={{ color: "var(--cyan)" }}> · {presetName}</span>}
        </span>
        <span className="panel__meta">
          {result && (
            <ShareButton
              url={() =>
                buildBacktestShare(marketId, result.symbol, {
                  strategy,
                  period,
                  fast,
                  slow,
                  rsi_period: rsiPeriod,
                  rsi_oversold: rsiOversold,
                  rsi_overbought: rsiOverbought,
                  kronos_horizon: kronosHorizon,
                })
              }
            />
          )}
          {result ? `${result.symbol} · ${result.period}` : symbol}
        </span>
      </div>

      <div className="control-grid">
        <label className="field">
          <span className="field__label">{t("bt.strategy")}</span>
          <select
            className="select"
            value={strategy}
            onChange={(e) => setStrategy(e.target.value)}
          >
            {STRATEGY_KEYS.map(([value, key]) => (
              <option key={value} value={value}>
                {t(key)}
              </option>
            ))}
          </select>
        </label>

        <label className="field">
          <span className="field__label">{t("bt.window")}</span>
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
              <span className="field__label">{t("bt.fast")}</span>
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
              <span className="field__label">{t("bt.slow")}</span>
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

        {isKronos && (
          <label className="field">
            <span className="field__label">{t("bt.kronosHorizon")}</span>
            <input
              className="input"
              type="number"
              min={5}
              max={60}
              value={kronosHorizon}
              onChange={(e) => setKronosHorizon(Number(e.target.value))}
            />
          </label>
        )}

        {isRsi && (
          <>
            <label className="field">
              <span className="field__label">{t("bt.rsiPeriod")}</span>
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
              <span className="field__label">{t("bt.oversold")}</span>
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
              <span className="field__label">{t("bt.overbought")}</span>
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
            {running ? t("bt.running") : t("bt.run")}
          </button>
        </label>
      </div>

      {error && <div className="err">{error}</div>}

      {!result && !error && (
        <div className="empty">{t("bt.hint")}</div>
      )}

      {s && result && (
        <>
          <EquityChart
            equity={result.equity_curve}
            benchmark={result.benchmark_curve}
            drawdown={result.drawdown_curve}
          />

          <div className="stat-grid">
            <Stat label={t("bt.totalReturn")} value={pct(s.total_return_pct)} tone={s.total_return_pct} />
            <Stat
              label={t("bt.excess")}
              value={pct(s.excess_vs_buy_hold_pct)}
              tone={s.excess_vs_buy_hold_pct}
            />
            <Stat label={t("bt.cagr")} value={pct(s.cagr_pct)} tone={s.cagr_pct} />
            <Stat label={t("bt.sharpe")} value={s.sharpe.toFixed(2)} tone={s.sharpe} />
            <Stat label={t("bt.sortino")} value={s.sortino.toFixed(2)} tone={s.sortino} />
            <Stat label={t("bt.maxdd")} value={pct(s.max_drawdown_pct)} tone={-1} />
            <Stat label={t("bt.winrate")} value={`${s.win_rate_pct.toFixed(1)}%`} />
            <Stat label={t("bt.pf")} value={s.profit_factor?.toFixed(2) ?? "—"} />
            <Stat label={t("bt.trades")} value={String(s.trade_count)} />
            <Stat label={t("bt.bh")} value={pct(s.buy_hold_return_pct)} tone={s.buy_hold_return_pct} />
          </div>

          {result.trades.length > 0 && (
            <div className="table-scroll">
              <table>
                <thead>
                  <tr>
                    <th>{t("bt.entry")}</th>
                    <th>{t("bt.exit")}</th>
                    <th style={{ textAlign: "right" }}>{t("bt.pnl")}</th>
                    <th style={{ textAlign: "right" }}>{t("bt.return")}</th>
                  </tr>
                </thead>
                <tbody>
                  {[...result.trades].reverse().map((trade, i) => (
                    <tr key={i}>
                      <td>{day(trade.entry_time)}</td>
                      <td>{trade.exit_time ? day(trade.exit_time) : t("bt.open")}</td>
                      <td
                        style={{ textAlign: "right" }}
                        className={(trade.pnl ?? 0) >= 0 ? "up" : "dn"}
                      >
                        {trade.pnl?.toLocaleString(undefined, { maximumFractionDigits: 0 }) ?? "—"}
                      </td>
                      <td
                        style={{ textAlign: "right" }}
                        className={(trade.return_pct ?? 0) >= 0 ? "up" : "dn"}
                      >
                        {trade.return_pct !== null ? `${trade.return_pct.toFixed(2)}%` : "—"}
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
