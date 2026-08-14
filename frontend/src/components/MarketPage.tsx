import { memo, useEffect, useMemo, useRef, useState } from "react";
import { api, type Charge, type MarketItem, type PaymentConfig } from "../api";
import {
  installedIds,
  purchases,
  queueBacktestPreset,
  recordPurchase,
  toggleInstall,
  type PurchaseRecord,
} from "../store";

const TYPE_META = {
  strategy: { label: "策略", color: "var(--amber)", rgb: "255, 176, 0" },
  skill: { label: "AI 技能", color: "var(--violet)", rgb: "167, 139, 250" },
  data: { label: "数据源", color: "var(--cyan)", rgb: "62, 200, 224" },
} as const;

const RISK_LABEL = { low: "低风险", medium: "中风险", high: "高风险" } as const;

const FILTERS = [
  { value: "", label: "全部" },
  { value: "strategy", label: "策略" },
  { value: "skill", label: "AI 技能" },
  { value: "data", label: "数据源" },
] as const;

interface Props {
  /** Queue the preset, then let App switch back to the terminal view. */
  onRunStrategy: () => void;
}

export const MarketPage = memo(function MarketPage({ onRunStrategy }: Props) {
  const [items, setItems] = useState<MarketItem[]>([]);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MarketItem | null>(null);
  const [paying, setPaying] = useState<MarketItem | null>(null);
  const [installed, setInstalled] = useState<string[]>(installedIds);
  // localStorage is read once here, not per card per render: with ~15 cards
  // that was a synchronous getItem+JSON.parse storm on every keystroke.
  const [bought, setBought] = useState<Record<string, PurchaseRecord>>(purchases);
  const [payConfig, setPayConfig] = useState<PaymentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .marketItems()
      .then((res) => setItems(res.items))
      .catch((err: Error) => setError(err.message));
    api
      .paymentConfig()
      .then(setPayConfig)
      .catch(() => setPayConfig(null));
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter && item.type !== filter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.tagline.toLowerCase().includes(q) ||
        item.tags.some((t) => t.toLowerCase().includes(q))
      );
    });
  }, [items, filter, query]);

  const counts = useMemo(
    () => ({
      strategy: items.filter((i) => i.type === "strategy").length,
      skill: items.filter((i) => i.type === "skill").length,
      data: items.filter((i) => i.type === "data").length,
    }),
    [items],
  );

  const handleToggleInstall = (item: MarketItem) => {
    toggleInstall(item);
    setInstalled(installedIds());
  };

  const runStrategy = (item: MarketItem) => {
    if (!item.integration.backtest) return;
    queueBacktestPreset({ name: item.name, payload: item.integration.backtest });
    setSelected(null);
    onRunStrategy();
  };

  return (
    <div className="market">
      <section className="mk-hero">
        <div className="mk-hero__glow" aria-hidden />
        <h1 className="mk-hero__title">
          市场 <span className="mk-hero__cursor">▮</span>
        </h1>
        <p className="mk-hero__sub">
          策略、AI 技能与数据源 —— 每一项都接在真实引擎上：策略一键进回测，技能进 AI
          面板，数据源显示当前进程的实时接入状态。
        </p>
        <div className="mk-hero__stats">
          <span className="mk-stat" style={{ "--tint": TYPE_META.strategy.rgb } as never}>
            <b>{counts.strategy}</b> 可运行策略
          </span>
          <span className="mk-stat" style={{ "--tint": TYPE_META.skill.rgb } as never}>
            <b>{counts.skill}</b> AI 技能
          </span>
          <span className="mk-stat" style={{ "--tint": TYPE_META.data.rgb } as never}>
            <b>{counts.data}</b> 数据源
          </span>
        </div>
      </section>

      <div className="mk-toolbar">
        <div className="mk-filters">
          {FILTERS.map((f) => (
            <button
              key={f.value}
              className={`chip${filter === f.value ? " is-on" : ""}`}
              onClick={() => setFilter(f.value)}
            >
              {f.label}
            </button>
          ))}
        </div>
        <input
          className="input mk-search"
          placeholder="搜索名称、简介或标签…"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label="搜索市场"
        />
      </div>

      {error && <div className="err">市场目录加载失败：{error}</div>}

      <div className="mk-grid">
        {visible.map((item) => (
          <Card
            key={item.id}
            item={item}
            installed={installed.includes(item.id)}
            purchased={item.id in bought}
            onOpen={() => setSelected(item)}
          />
        ))}
        {!error && visible.length === 0 && <div className="empty">没有匹配的条目</div>}
      </div>

      {selected && (
        <DetailModal
          item={selected}
          installed={installed.includes(selected.id)}
          owned={!selected.price || selected.id in bought}
          ownedDemo={bought[selected.id]?.demo === true}
          onClose={() => setSelected(null)}
          onToggleInstall={() => handleToggleInstall(selected)}
          onRun={() => runStrategy(selected)}
          onBuy={() => setPaying(selected)}
        />
      )}

      {paying && (
        <PaymentModal
          item={paying}
          config={payConfig}
          onClose={() => setPaying(null)}
          onPaid={(record) => {
            recordPurchase(paying.id, record);
            setBought((prev) => ({ ...prev, [paying.id]: record }));
            setPaying(null);
          }}
        />
      )}
    </div>
  );
});

/* ------------------------------------------------------------------- card */

function Card({
  item,
  installed,
  purchased,
  onOpen,
}: {
  item: MarketItem;
  installed: boolean;
  purchased: boolean;
  onOpen: () => void;
}) {
  const meta = TYPE_META[item.type];
  return (
    <button className="mk-card" style={{ "--tint": meta.rgb } as never} onClick={onOpen}>
      <div className="mk-card__top">
        <span className="mk-card__icon">
          <TypeIcon type={item.type} />
        </span>
        <span className="mk-card__badges">
          {installed && <span className="mk-badge mk-badge--installed">✓ 已安装</span>}
          {item.price &&
            (purchased ? (
              <span className="mk-badge mk-badge--installed">已购买</span>
            ) : (
              <span className="mk-badge mk-badge--price">${item.price.amount}</span>
            ))}
          <span className="mk-badge" style={{ color: meta.color }}>
            {meta.label}
          </span>
        </span>
      </div>

      <div className="mk-card__name">{item.name}</div>
      <div className="mk-card__tagline">{item.tagline}</div>

      <div className="mk-card__tags">
        {item.tags.map((tag) => (
          <span key={tag} className="mk-tag">
            {tag}
          </span>
        ))}
      </div>

      <div className="mk-card__foot">
        <span className="dim">
          {item.author} · v{item.version}
        </span>
        <FootBadge item={item} />
      </div>
    </button>
  );
}

function FootBadge({ item }: { item: MarketItem }) {
  if (item.type === "strategy" && item.risk) {
    return <span className={`mk-risk mk-risk--${item.risk}`}>{RISK_LABEL[item.risk]}</span>;
  }
  if (item.type === "data" && item.status) {
    return <span className={`mk-state mk-state--${item.status.state}`}>{item.status.label}</span>;
  }
  return null;
}

/* ------------------------------------------------------------------ modal */

function DetailModal({
  item,
  installed,
  owned,
  ownedDemo,
  onClose,
  onToggleInstall,
  onRun,
  onBuy,
}: {
  item: MarketItem;
  installed: boolean;
  /** true when the item is free or has been purchased in this browser. */
  owned: boolean;
  ownedDemo: boolean;
  onClose: () => void;
  onToggleInstall: () => void;
  onRun: () => void;
  onBuy: () => void;
}) {
  const meta = TYPE_META[item.type];

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const backtest = item.integration.backtest;

  return (
    <div className="mk-overlay" onClick={onClose}>
      <div
        className="mk-modal"
        style={{ "--tint": meta.rgb } as never}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={item.name}
      >
        <div className="mk-modal__head">
          <span className="mk-card__icon mk-card__icon--lg">
            <TypeIcon type={item.type} />
          </span>
          <div style={{ minWidth: 0 }}>
            <div className="mk-modal__name">{item.name}</div>
            <div className="mk-card__tagline">{item.tagline}</div>
          </div>
          <button className="mk-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="mk-modal__body">
          <p className="mk-desc">{item.description}</p>

          {item.type === "strategy" && backtest && (
            <div className="mk-section">
              <div className="mk-section__title">参数</div>
              <div className="mk-params">
                {Object.entries(backtest).map(([key, value]) => (
                  <span key={key} className="mk-param">
                    <span className="dim">{key}</span> {String(value)}
                  </span>
                ))}
              </div>
              <p className="dim" style={{ fontSize: 11.5, margin: "8px 0 0" }}>
                下一根 bar 开盘成交，双边计手续费与滑点；报告自带买入持有基准。
              </p>
            </div>
          )}

          {item.type === "skill" && item.integration.prompt_template && (
            <div className="mk-section">
              <div className="mk-section__title">提示词模板（{"{symbol}"} 自动替换为当前标的）</div>
              <pre className="mk-code">{item.integration.prompt_template}</pre>
            </div>
          )}

          {item.type === "data" && (
            <div className="mk-section">
              <div className="mk-section__title">接入状态</div>
              {item.status && (
                <span className={`mk-state mk-state--${item.status.state}`}>
                  {item.status.label}
                </span>
              )}
              {item.integration.env_key && (
                <p className="dim" style={{ fontSize: 12, margin: "10px 0 0" }}>
                  在 <code className="mk-inline-code">.env</code> 中设置{" "}
                  <code className="mk-inline-code">{item.integration.env_key}=…</code>{" "}
                  并重启后端即可启用。
                </p>
              )}
            </div>
          )}
        </div>

        <div className="mk-modal__actions">
          {!owned ? (
            <>
              <button className="btn btn--primary" onClick={onBuy}>
                以 ${item.price!.amount} {item.price!.currency} 购买 · 加密支付
              </button>
              <span className="dim" style={{ fontSize: 11.5 }}>
                购买后解锁{item.type === "strategy" ? "回测运行" : "安装"}
              </span>
            </>
          ) : (
            <>
              {item.type === "strategy" && (
                <button className="btn btn--primary" onClick={onRun}>
                  ▶ 在回测中运行
                </button>
              )}
              {item.type !== "data" && (
                <button className="btn" onClick={onToggleInstall}>
                  {installed ? "移除" : item.type === "skill" ? "安装到 AI 面板" : "收藏"}
                </button>
              )}
              {ownedDemo && (
                <span className="mk-badge mk-badge--demo" title="通过演示流程解锁，未发生真实支付">
                  演示购买
                </span>
              )}
              {item.type === "data" && item.status?.state === "active" && (
                <span className="dim" style={{ fontSize: 12 }}>
                  该数据源正在驱动本站行情，无需操作。
                </span>
              )}
            </>
          )}
        </div>
      </div>
    </div>
  );
}

/* ---------------------------------------------------------------- payment */

function PaymentModal({
  item,
  config,
  onClose,
  onPaid,
}: {
  item: MarketItem;
  config: PaymentConfig | null;
  onClose: () => void;
  onPaid: (record: {
    chargeId: string;
    provider: string;
    demo: boolean;
    at: string;
  }) => void;
}) {
  const [charge, setCharge] = useState<Charge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  // The parent passes `onPaid` as an inline arrow, i.e. a new identity every
  // render. Holding it in a ref keeps it out of the poll effect's deps — with
  // it in deps, any parent re-render tore down the 4s interval before it fired,
  // and a real payment could go unconfirmed indefinitely.
  const onPaidRef = useRef(onPaid);
  onPaidRef.current = onPaid;

  // Create the charge on open (and on explicit retry after expiry).
  useEffect(() => {
    let cancelled = false;
    setError(null);
    api
      .createCharge(item.id)
      .then((c) => !cancelled && setCharge(c))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [item.id, attempt]);

  // Real charges: poll the provider until confirmed/failed/expired.
  useEffect(() => {
    if (!charge || charge.demo || confirmed) return;
    const expiresAt = charge.expires_at ? Date.parse(charge.expires_at) : NaN;
    const poll = async () => {
      if (!Number.isNaN(expiresAt) && Date.now() > expiresAt) {
        window.clearInterval(timer);
        setError("支付窗口已过期，订单未完成。可重新发起支付。");
        return;
      }
      try {
        const status = await api.chargeStatus(charge.charge_id);
        if (status.status === "confirmed") {
          setConfirmed(true);
          onPaidRef.current({
            chargeId: charge.charge_id,
            provider: charge.provider,
            demo: false,
            at: new Date().toISOString(),
          });
        } else if (status.status === "failed") {
          setError("支付已过期或被取消，请重新发起。");
        }
      } catch {
        /* transient — next tick retries */
      }
    };
    const timer = window.setInterval(poll, 4000);
    return () => window.clearInterval(timer);
  }, [charge, confirmed]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="mk-overlay mk-overlay--pay" onClick={onClose}>
      <div
        className="mk-modal mk-modal--pay"
        style={{ "--tint": "255, 176, 0" } as never}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={`购买 ${item.name}`}
      >
        <div className="mk-modal__head">
          <div style={{ minWidth: 0 }}>
            <div className="mk-modal__name">购买 · {item.name}</div>
            <div className="mk-card__tagline">
              ${item.price?.amount} {item.price?.currency} · 加密货币支付
            </div>
          </div>
          <button className="mk-close" onClick={onClose} aria-label="关闭">
            ✕
          </button>
        </div>

        <div className="mk-modal__body">
          {error && (
            <div className="err">
              {error}{" "}
              <button
                className="btn"
                style={{ marginLeft: 8 }}
                onClick={() => {
                  setCharge(null);
                  setAttempt((n) => n + 1);
                }}
              >
                重新发起
              </button>
            </div>
          )}
          {!charge && !error && <div className="empty">正在创建订单…</div>}

          {charge && !charge.demo && !error && (
            <div className="pay-panel">
              <p className="mk-desc" style={{ fontSize: 12.5 }}>
                订单已创建（{charge.charge_id}）。在 Coinbase Commerce
                托管页面完成支付后，本页会自动确认并解锁——请保持此窗口打开。
              </p>
              <a
                className="btn btn--primary"
                href={charge.hosted_url ?? "#"}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-block", textDecoration: "none", marginTop: 10 }}
              >
                前往支付页面 ↗
              </a>
              <p className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>
                等待链上确认中…（每 4 秒查询一次订单状态）
              </p>
            </div>
          )}

          {charge?.demo && (
            <div className="pay-panel pay-panel--demo">
              <div className="pay-demo-flag">演示模式</div>
              <p className="mk-desc" style={{ fontSize: 12.5 }}>
                {config?.note ??
                  "未配置支付通道，当前为演示流程：不展示收款地址，不会发生任何真实转账。"}
              </p>
              <p className="dim" style={{ fontSize: 11.5, margin: "8px 0 0" }}>
                站长在 <code className="mk-inline-code">.env</code> 配置{" "}
                <code className="mk-inline-code">COINBASE_COMMERCE_API_KEY</code>{" "}
                后，此处会变为真实的托管加密支付页面。
              </p>
              <button
                className="btn btn--primary"
                style={{ marginTop: 12 }}
                onClick={() =>
                  onPaid({
                    chargeId: charge.charge_id,
                    provider: "demo",
                    demo: true,
                    at: new Date().toISOString(),
                  })
                }
              >
                模拟支付完成（演示解锁）
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------ icons */

function TypeIcon({ type }: { type: MarketItem["type"] }) {
  const common = {
    width: 18,
    height: 18,
    viewBox: "0 0 24 24",
    fill: "none",
    stroke: "currentColor",
    strokeWidth: 2,
    strokeLinecap: "round" as const,
    strokeLinejoin: "round" as const,
  };
  if (type === "strategy") {
    return (
      <svg {...common}>
        <polyline points="3 17 9 11 13 15 21 7" />
        <polyline points="15 7 21 7 21 13" />
      </svg>
    );
  }
  if (type === "skill") {
    return (
      <svg {...common}>
        <path d="M12 3l1.9 5.1L19 10l-5.1 1.9L12 17l-1.9-5.1L5 10l5.1-1.9z" />
        <path d="M19 15l.9 2.1L22 18l-2.1.9L19 21l-.9-2.1L16 18l2.1-.9z" />
      </svg>
    );
  }
  return (
    <svg {...common}>
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v6c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 11v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6" />
    </svg>
  );
}
