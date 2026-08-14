import { useEffect, useRef, useState } from "react";
import {
  streamStrategy,
  type AIEvent,
  type StrategyForm,
  type StrategyProposal,
} from "../api";
import {
  deleteStrategy,
  savedStrategies,
  saveStrategy,
  type SavedStrategy,
} from "../store";

const OBJECTIVES = [
  { value: "auto", label: "自动判断", hint: "先分析标的性格再选风格（推荐）" },
  { value: "trend", label: "稳健趋势", hint: "宁少交易，不追噪音" },
  { value: "momentum", label: "激进动量", hint: "接受高换手与回撤" },
  { value: "reversion", label: "均值回归", hint: "高胜率短持仓" },
  { value: "low_drawdown", label: "低回撤优先", hint: "回撤是第一约束" },
] as const;

interface TimelineStep {
  kind: "analyze" | "backtest" | "propose" | "note";
  title: string;
  detail?: string;
  result?: string;
}

interface Props {
  hidden: boolean;
  aiEnabled: boolean;
  /** Run a generated strategy: App adds the symbol to the right workspace,
   * queues the preset and switches view. */
  onRun: (symbol: string, name: string, payload: Record<string, unknown>) => void;
}

export function StrategyLab({ hidden, aiEnabled, onRun }: Props) {
  const [symbol, setSymbol] = useState("AAPL");
  const [objective, setObjective] = useState("auto");
  const [validationPeriod, setValidationPeriod] = useState("5y");
  const [notes, setNotes] = useState("");

  const [running, setRunning] = useState(false);
  const [elapsed, setElapsed] = useState(0);
  const [steps, setSteps] = useState<TimelineStep[]>([]);
  const [thinking, setThinking] = useState("");
  const [commentary, setCommentary] = useState("");
  const [proposal, setProposal] = useState<StrategyProposal | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<SavedStrategy[]>(savedStrategies);
  const [justSaved, setJustSaved] = useState(false);

  const abortRef = useRef<AbortController | null>(null);
  const timelineRef = useRef<HTMLDivElement>(null);

  useEffect(() => () => abortRef.current?.abort(), []);

  useEffect(() => {
    if (!running) return;
    const timer = window.setInterval(() => setElapsed((s) => s + 1), 1000);
    return () => window.clearInterval(timer);
  }, [running]);

  useEffect(() => {
    timelineRef.current?.scrollTo({ top: timelineRef.current.scrollHeight });
  }, [steps, thinking]);

  const pushStep = (step: TimelineStep) => setSteps((prev) => [...prev, step]);

  const attachResult = (text: string) =>
    setSteps((prev) => {
      const next = [...prev];
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].result === undefined && next[i].kind !== "note") {
          next[i] = { ...next[i], result: text };
          break;
        }
      }
      return next;
    });

  const handleEvent = (event: AIEvent) => {
    switch (event.type) {
      case "thinking":
        setThinking((t) => (t + event.text).slice(-1200));
        break;
      case "text":
        setCommentary((c) => c + event.text);
        break;
      case "tool_use": {
        const input = event.input as Record<string, unknown>;
        if (event.name === "run_backtest") {
          const bits = [
            String(input.strategy ?? ""),
            input.fast != null ? `${input.fast}/${input.slow}` : "",
            input.rsi_period != null ? `RSI${input.rsi_period}` : "",
            String(input.period ?? ""),
          ].filter(Boolean);
          pushStep({ kind: "backtest", title: `回测 ${input.symbol}`, detail: bits.join(" · ") });
        } else if (event.name === "propose_strategy") {
          pushStep({ kind: "propose", title: "提交最终方案" });
          setProposal(input as unknown as StrategyProposal);
        } else if (event.name === "compute_indicator") {
          pushStep({
            kind: "analyze",
            title: `计算 ${String(input.indicator ?? "").toUpperCase()}`,
            detail: String(input.symbol ?? ""),
          });
        } else if (event.name === "get_price_history") {
          pushStep({
            kind: "analyze",
            title: "读取价格历史",
            detail: `${input.symbol} · ${input.period ?? "6mo"}`,
          });
        } else {
          pushStep({ kind: "analyze", title: event.name });
        }
        break;
      }
      case "tool_result": {
        const r = event.result as Record<string, unknown>;
        if (event.name === "run_backtest" && r?.stats) {
          const s = r.stats as Record<string, number>;
          attachResult(
            `收益 ${fmtPct(s.total_return_pct)} · 基准 ${fmtPct(s.buy_hold_return_pct)} · ` +
              `夏普 ${s.sharpe} · 回撤 ${fmtPct(s.max_drawdown_pct)} · ${s.trade_count} 笔`,
          );
        } else if (event.name === "propose_strategy") {
          if (r?.error) {
            attachResult(`参数校验失败：${r.error}`);
            setProposal(null); // rejected — Claude will fix and re-submit
          } else {
            attachResult("✓ 通过参数校验");
          }
        } else if (r?.error) {
          attachResult(`失败：${r.error}`);
        } else {
          attachResult("✓");
        }
        break;
      }
      case "refusal":
        setError(`请求被安全分类器拒绝：${event.message}`);
        break;
      case "error":
        setError(event.message);
        break;
      case "done":
        break;
    }
  };

  const generate = async () => {
    const cleaned = symbol.trim().toUpperCase();
    if (!cleaned || running) return;

    setRunning(true);
    setElapsed(0);
    setSteps([]);
    setThinking("");
    setCommentary("");
    setProposal(null);
    setError(null);
    setJustSaved(false);

    const controller = new AbortController();
    abortRef.current = controller;

    const form: StrategyForm = {
      symbol: cleaned,
      objective,
      validation_period: validationPeriod,
      notes,
    };

    try {
      await streamStrategy(form, handleEvent, controller.signal);
    } catch (err) {
      if ((err as Error).name !== "AbortError") setError((err as Error).message);
    } finally {
      setRunning(false);
      abortRef.current = null;
    }
  };

  const stop = () => abortRef.current?.abort();

  const handleSave = () => {
    if (!proposal) return;
    saveStrategy({
      name: proposal.name,
      symbol: proposal.symbol,
      strategy: proposal.strategy,
      params: proposal.params,
      rationale: proposal.rationale,
      risks: proposal.risks,
      beats_buy_hold: proposal.beats_buy_hold,
      in_sample: proposal.in_sample,
      validation: proposal.validation,
    });
    setSaved(savedStrategies());
    setJustSaved(true);
  };

  const runProposal = (p: {
    symbol: string;
    name: string;
    strategy: string;
    params: Record<string, unknown>;
  }) => onRun(p.symbol, p.name, { strategy: p.strategy, ...p.params });

  return (
    <div className="lab" style={hidden ? { display: "none" } : undefined}>
      <div className="lab__inner">
        <section className="lab-hero">
          <h1 className="lab-hero__title">AI 策略工坊</h1>
          <p className="lab-hero__sub">
            描述目标，Claude 会先判断标的性格，在样本内窗口用<b>真实回测引擎</b>
            搜索参数，再做样本外验证 —— 每一次回测都在下方时间线上可见，跑不赢买入持有会如实告诉你。
          </p>
        </section>

        {!aiEnabled ? (
          <div className="notice" style={{ maxWidth: 560 }}>
            AI 未启用。在项目根目录 <code>.env</code> 设置 <code>ANTHROPIC_API_KEY</code>{" "}
            并重启后端后，此栏目即可使用。
          </div>
        ) : (
          <>
            <div className="lab-form panel">
              <div className="control-grid" style={{ borderBottom: "none" }}>
                <label className="field">
                  <span className="field__label">标的代码</span>
                  <input
                    className="input"
                    value={symbol}
                    onChange={(e) => setSymbol(e.target.value)}
                    placeholder="AAPL / 600519.SS"
                    disabled={running}
                  />
                </label>
                <label className="field">
                  <span className="field__label">目标风格</span>
                  <select
                    className="select"
                    value={objective}
                    onChange={(e) => setObjective(e.target.value)}
                    disabled={running}
                  >
                    {OBJECTIVES.map((o) => (
                      <option key={o.value} value={o.value}>
                        {o.label} — {o.hint}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="field">
                  <span className="field__label">验证窗口</span>
                  <select
                    className="select"
                    value={validationPeriod}
                    onChange={(e) => setValidationPeriod(e.target.value)}
                    disabled={running}
                  >
                    <option value="5y">5 年（推荐）</option>
                    <option value="max">全部历史</option>
                    <option value="2y">2 年</option>
                  </select>
                </label>
                <label className="field" style={{ gridColumn: "span 2" }}>
                  <span className="field__label">补充要求（可选）</span>
                  <input
                    className="input"
                    value={notes}
                    onChange={(e) => setNotes(e.target.value)}
                    placeholder="如：最大回撤不超过 20%；交易别太频繁"
                    maxLength={200}
                    disabled={running}
                  />
                </label>
                <label className="field">
                  <span className="field__label">&nbsp;</span>
                  {running ? (
                    <button className="btn" onClick={stop}>
                      停止（{elapsed}s）
                    </button>
                  ) : (
                    <button className="btn btn--primary" onClick={generate}>
                      ⚡ 生成策略
                    </button>
                  )}
                </label>
              </div>
              <div className="lab-form__hint">
                单次生成会运行约 6–10 次真实回测（样本内 2y 搜索 + {validationPeriod}{" "}
                验证），耗时 1–4 分钟，消耗你账户的 API token。
              </div>
            </div>

            <div className="lab-grid">
              {/* ------------------------------------------------ process */}
              <div className="panel lab-panel">
                <div className="panel__head">
                  <span className="panel__title">设计过程</span>
                  <span className="panel__meta">
                    {running ? `进行中 · ${elapsed}s` : steps.length ? "已完成" : "待开始"}
                  </span>
                </div>
                <div className="lab-timeline" ref={timelineRef}>
                  {steps.length === 0 && !running && (
                    <div className="empty">点击「生成策略」，设计过程会实时显示在这里。</div>
                  )}
                  {steps.map((step, i) => (
                    <div key={i} className={`lab-step lab-step--${step.kind}`}>
                      <span className="lab-step__marker" />
                      <div className="lab-step__body">
                        <div className="lab-step__title">
                          {step.title}
                          {step.detail && <span className="dim"> · {step.detail}</span>}
                        </div>
                        {step.result && <div className="lab-step__result">{step.result}</div>}
                        {step.result === undefined && running && i === steps.length - 1 && (
                          <div className="lab-step__result dim">运行中…</div>
                        )}
                      </div>
                    </div>
                  ))}
                  {thinking && running && <div className="msg__thinking">{thinking}</div>}
                  {commentary && (
                    <div className="lab-commentary">
                      {commentary}
                      {running && <span className="dim"> ▊</span>}
                    </div>
                  )}
                  {error && <div className="err">{error}</div>}
                </div>
              </div>

              {/* ----------------------------------------------- proposal */}
              <div className="lab-side">
                {proposal ? (
                  <div className="panel lab-proposal">
                    <div className="panel__head">
                      <span className="panel__title">策略方案</span>
                      <span
                        className={`mk-badge ${proposal.beats_buy_hold ? "mk-badge--installed" : "mk-badge--warn"}`}
                      >
                        {proposal.beats_buy_hold ? "✓ 验证期跑赢基准" : "✗ 未跑赢买入持有"}
                      </span>
                    </div>
                    <div className="lab-proposal__body">
                      <div className="lab-proposal__name">{proposal.name}</div>
                      <div className="dim" style={{ fontSize: 12 }}>
                        {proposal.symbol} · {proposal.strategy}
                      </div>

                      <div className="mk-params" style={{ marginTop: 10 }}>
                        {Object.entries(proposal.params ?? {}).map(([k, v]) => (
                          <span key={k} className="mk-param">
                            <span className="dim">{k}</span> {String(v)}
                          </span>
                        ))}
                      </div>

                      {(proposal.in_sample || proposal.validation) && (
                        <table className="lab-stats" style={{ marginTop: 12 }}>
                          <thead>
                            <tr>
                              <th>窗口</th>
                              <th>收益</th>
                              <th>基准</th>
                              <th>夏普</th>
                              <th>回撤</th>
                            </tr>
                          </thead>
                          <tbody>
                            {proposal.in_sample && <StatRow label="样本内" s={proposal.in_sample} />}
                            {proposal.validation && (
                              <StatRow label="验证" s={proposal.validation} />
                            )}
                          </tbody>
                        </table>
                      )}

                      <p className="lab-proposal__rationale">{proposal.rationale}</p>

                      {proposal.risks?.length > 0 && (
                        <ul className="lab-risks">
                          {proposal.risks.map((risk, i) => (
                            <li key={i}>{risk}</li>
                          ))}
                        </ul>
                      )}

                      <div className="lab-proposal__actions">
                        <button
                          className="btn btn--primary"
                          onClick={() =>
                            runProposal({
                              symbol: proposal.symbol,
                              name: proposal.name,
                              strategy: proposal.strategy,
                              params: proposal.params,
                            })
                          }
                        >
                          ▶ 在回测中运行
                        </button>
                        <button className="btn" onClick={handleSave} disabled={justSaved}>
                          {justSaved ? "✓ 已保存" : "保存到我的策略"}
                        </button>
                      </div>
                    </div>
                  </div>
                ) : (
                  <div className="panel lab-proposal lab-proposal--empty">
                    <div className="panel__head">
                      <span className="panel__title">策略方案</span>
                    </div>
                    <div className="empty" style={{ padding: 24 }}>
                      {running ? "设计中，方案将在验证完成后出现…" : "生成完成后，结构化方案会显示在这里。"}
                    </div>
                  </div>
                )}

                {saved.length > 0 && (
                  <div className="panel">
                    <div className="panel__head">
                      <span className="panel__title">我的策略</span>
                      <span className="panel__meta">{saved.length} · 存于本浏览器</span>
                    </div>
                    <ul className="lab-saved">
                      {saved.map((s) => (
                        <li key={s.id} className="lab-saved__row">
                          <div style={{ minWidth: 0 }}>
                            <div className="lab-saved__name">{s.name}</div>
                            <div className="dim" style={{ fontSize: 11 }}>
                              {s.symbol} · {s.strategy}
                              {!s.beats_buy_hold && " · 未跑赢基准"}
                            </div>
                          </div>
                          <div className="lab-saved__actions">
                            <button className="btn" onClick={() => runProposal(s)}>
                              运行
                            </button>
                            <button
                              className="watch-row__x"
                              title="删除"
                              onClick={() => {
                                deleteStrategy(s.id);
                                setSaved(savedStrategies());
                              }}
                            >
                              ×
                            </button>
                          </div>
                        </li>
                      ))}
                    </ul>
                  </div>
                )}
              </div>
            </div>

            <p className="lab-disclaimer">
              生成的策略基于历史数据调参，存在过拟合风险；回测含手续费与滑点但不含税费与流动性冲击。
              本栏目为研究工具，不构成投资建议。
            </p>
          </>
        )}
      </div>
    </div>
  );
}

function StatRow({ label, s }: { label: string; s: Record<string, unknown> }) {
  const n = (key: string) => {
    const v = s[key];
    return typeof v === "number" ? v : Number(v ?? NaN);
  };
  return (
    <tr>
      <td>{label}</td>
      <td className={n("total_return_pct") >= n("buy_hold_return_pct") ? "up" : "dn"}>
        {fmtPct(n("total_return_pct"))}
      </td>
      <td className="dim">{fmtPct(n("buy_hold_return_pct"))}</td>
      <td>{Number.isFinite(n("sharpe")) ? n("sharpe").toFixed(2) : "—"}</td>
      <td className="dn">{fmtPct(n("max_drawdown_pct"))}</td>
    </tr>
  );
}

function fmtPct(v: unknown): string {
  const n = typeof v === "number" ? v : Number(v ?? NaN);
  if (!Number.isFinite(n)) return "—";
  return `${n > 0 ? "+" : ""}${n.toFixed(2)}%`;
}
