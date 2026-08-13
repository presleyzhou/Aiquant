import { useEffect, useMemo, useState } from "react";
import { api, type MarketItem } from "../api";
import { installedIds, queueBacktestPreset, toggleInstall } from "../store";

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

export function MarketPage({ onRunStrategy }: Props) {
  const [items, setItems] = useState<MarketItem[]>([]);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MarketItem | null>(null);
  const [installed, setInstalled] = useState<string[]>(installedIds);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    api
      .marketItems()
      .then((res) => setItems(res.items))
      .catch((err: Error) => setError(err.message));
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
            onOpen={() => setSelected(item)}
          />
        ))}
        {!error && visible.length === 0 && <div className="empty">没有匹配的条目</div>}
      </div>

      {selected && (
        <DetailModal
          item={selected}
          installed={installed.includes(selected.id)}
          onClose={() => setSelected(null)}
          onToggleInstall={() => handleToggleInstall(selected)}
          onRun={() => runStrategy(selected)}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- card */

function Card({
  item,
  installed,
  onOpen,
}: {
  item: MarketItem;
  installed: boolean;
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
  onClose,
  onToggleInstall,
  onRun,
}: {
  item: MarketItem;
  installed: boolean;
  onClose: () => void;
  onToggleInstall: () => void;
  onRun: () => void;
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
          {item.type === "data" && item.status?.state === "active" && (
            <span className="dim" style={{ fontSize: 12 }}>
              该数据源正在驱动本站行情，无需操作。
            </span>
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
