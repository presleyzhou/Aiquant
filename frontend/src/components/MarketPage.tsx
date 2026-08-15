import { useEffect, useMemo, useRef, useState } from "react";
import { useT, type MsgKey } from "../i18n";
import { api, type Charge, type MarketItem, type PaymentConfig } from "../api";
import {
  installedIds,
  isPurchased,
  purchases,
  queueBacktestPreset,
  recordPurchase,
  toggleInstall,
} from "../store";

const TYPE_META = {
  strategy: { labelKey: "mk.type.strategy" as MsgKey, color: "var(--amber)", rgb: "255, 176, 0" },
  skill: { labelKey: "mk.type.skill" as MsgKey, color: "var(--violet)", rgb: "167, 139, 250" },
  data: { labelKey: "mk.type.data" as MsgKey, color: "var(--cyan)", rgb: "62, 200, 224" },
} as const;

const RISK_KEY = {
  low: "mk.risk.low",
  medium: "mk.risk.medium",
  high: "mk.risk.high",
} as const satisfies Record<string, MsgKey>;

const FILTERS = [
  { value: "", labelKey: "mk.filter.all" as MsgKey },
  { value: "strategy", labelKey: "mk.type.strategy" as MsgKey },
  { value: "skill", labelKey: "mk.type.skill" as MsgKey },
  { value: "data", labelKey: "mk.type.data" as MsgKey },
] as const;

interface Props {
  /** Queue the preset, then let App switch back to the terminal view. */
  onRunStrategy: () => void;
}

export function MarketPage({ onRunStrategy }: Props) {
  const { t, lang } = useT();
  const [items, setItems] = useState<MarketItem[]>([]);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MarketItem | null>(null);
  const [paying, setPaying] = useState<MarketItem | null>(null);
  const [installed, setInstalled] = useState<string[]>(installedIds);
  const [owned, setOwned] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(Object.keys(purchases()).map((id) => [id, true])),
  );
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
          {t("mk.title")} <span className="mk-hero__cursor">▮</span>
        </h1>
        <p className="mk-hero__sub">
          {t("mk.sub")}
          {lang === "en" && <span className="dim"> {t("mk.contentLang")}</span>}
        </p>
        <div className="mk-hero__stats">
          <span className="mk-stat" style={{ "--tint": TYPE_META.strategy.rgb } as never}>
            <b>{counts.strategy}</b> {t("mk.stat.strategies")}
          </span>
          <span className="mk-stat" style={{ "--tint": TYPE_META.skill.rgb } as never}>
            <b>{counts.skill}</b> {t("mk.stat.skills")}
          </span>
          <span className="mk-stat" style={{ "--tint": TYPE_META.data.rgb } as never}>
            <b>{counts.data}</b> {t("mk.stat.data")}
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
              {t(f.labelKey)}
            </button>
          ))}
        </div>
        <input
          className="input mk-search"
          placeholder={t("mk.search.ph")}
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          aria-label={t("mk.search.ph")}
        />
      </div>

      {error && <div className="err">{t("mk.loadFail")}: {error}</div>}

      <div className="mk-grid">
        {visible.map((item) => (
          <Card
            key={item.id}
            item={item}
            installed={installed.includes(item.id)}
            onOpen={() => setSelected(item)}
          />
        ))}
        {!error && visible.length === 0 && <div className="empty">{t("mk.empty")}</div>}
      </div>

      {selected && (
        <DetailModal
          item={selected}
          installed={installed.includes(selected.id)}
          owned={!selected.price || owned[selected.id] === true}
          ownedDemo={purchases()[selected.id]?.demo === true}
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
            setOwned((prev) => ({ ...prev, [paying.id]: true }));
            setPaying(null);
          }}
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
  const { t } = useT();
  const meta = TYPE_META[item.type];
  return (
    <button className="mk-card" style={{ "--tint": meta.rgb } as never} onClick={onOpen}>
      <div className="mk-card__top">
        <span className="mk-card__icon">
          <TypeIcon type={item.type} />
        </span>
        <span className="mk-card__badges">
          {installed && <span className="mk-badge mk-badge--installed">{t("mk.installed")}</span>}
          {item.price &&
            (isPurchased(item.id) ? (
              <span className="mk-badge mk-badge--installed">{t("mk.purchased")}</span>
            ) : (
              <span className="mk-badge mk-badge--price">${item.price.amount}</span>
            ))}
          <span className="mk-badge" style={{ color: meta.color }}>
            {t(meta.labelKey)}
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
  const { t } = useT();
  if (item.type === "strategy" && item.risk) {
    return <span className={`mk-risk mk-risk--${item.risk}`}>{t(RISK_KEY[item.risk])}</span>;
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
  const { t } = useT();
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
          <button className="mk-close" onClick={onClose} aria-label={t("mk.close")}>
            ✕
          </button>
        </div>

        <div className="mk-modal__body">
          <p className="mk-desc">{item.description}</p>

          {item.type === "strategy" && backtest && (
            <div className="mk-section">
              <div className="mk-section__title">{t("mk.params")}</div>
              <div className="mk-params">
                {Object.entries(backtest).map(([key, value]) => (
                  <span key={key} className="mk-param">
                    <span className="dim">{key}</span> {String(value)}
                  </span>
                ))}
              </div>
              <p className="dim" style={{ fontSize: 11.5, margin: "8px 0 0" }}>
                {t("mk.costNote")}
              </p>
            </div>
          )}

          {item.type === "skill" && item.integration.prompt_template && (
            <div className="mk-section">
              <div className="mk-section__title">{t("mk.template")}</div>
              <pre className="mk-code">{item.integration.prompt_template}</pre>
            </div>
          )}

          {item.type === "data" && (
            <div className="mk-section">
              <div className="mk-section__title">{t("mk.status")}</div>
              {item.status && (
                <span className={`mk-state mk-state--${item.status.state}`}>
                  {item.status.label}
                </span>
              )}
              {item.integration.env_key && (
                <p className="dim" style={{ fontSize: 12, margin: "10px 0 0" }}>
                  {t("mk.envPrefix")}{" "}
                  <code className="mk-inline-code">{item.integration.env_key}=…</code>{" "}
                  {t("mk.envSuffix")}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="mk-modal__actions">
          {!owned ? (
            <>
              <button className="btn btn--primary" onClick={onBuy}>
                {t("mk.buy", { amt: item.price!.amount, ccy: item.price!.currency })}
              </button>
              <span className="dim" style={{ fontSize: 11.5 }}>
                {t(item.type === "strategy" ? "mk.unlock.strategy" : "mk.unlock.skill")}
              </span>
            </>
          ) : (
            <>
              {item.type === "strategy" && (
                <button className="btn btn--primary" onClick={onRun}>
                  {t("mk.run")}
                </button>
              )}
              {item.type !== "data" && (
                <button className="btn" onClick={onToggleInstall}>
                  {installed ? t("mk.remove") : item.type === "skill" ? t("mk.install") : t("mk.fav")}
                </button>
              )}
              {ownedDemo && (
                <span className="mk-badge mk-badge--demo" title={t("mk.demoTitle")}>
                  {t("mk.demoBadge")}
                </span>
              )}
              {item.type === "data" && item.status?.state === "active" && (
                <span className="dim" style={{ fontSize: 12 }}>
                  {t("mk.activeNote")}
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
  const { t } = useT();
  const [charge, setCharge] = useState<Charge | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmed, setConfirmed] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);

  // Create the charge on open.
  useEffect(() => {
    let cancelled = false;
    api
      .createCharge(item.id)
      .then((c) => !cancelled && setCharge(c))
      .catch((err: Error) => !cancelled && setError(err.message));
    return () => {
      cancelled = true;
    };
  }, [item.id]);

  // Real charges: poll the provider until confirmed/failed.
  useEffect(() => {
    if (!charge || charge.demo || confirmed) return;
    const poll = async () => {
      try {
        const status = await api.chargeStatus(charge.charge_id);
        if (status.status === "confirmed") {
          setConfirmed(true);
          onPaid({
            chargeId: charge.charge_id,
            provider: charge.provider,
            demo: false,
            at: new Date().toISOString(),
          });
        } else if (status.status === "failed") {
          setError(t("pay.expired"));
        }
      } catch {
        /* transient — next tick retries */
      }
    };
    pollRef.current = window.setInterval(poll, 4000);
    return () => window.clearInterval(pollRef.current);
  }, [charge, confirmed, onPaid]);

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
        aria-label={`${t("pay.title")} ${item.name}`}
      >
        <div className="mk-modal__head">
          <div style={{ minWidth: 0 }}>
            <div className="mk-modal__name">{t("pay.title")} · {item.name}</div>
            <div className="mk-card__tagline">
              ${item.price?.amount} {item.price?.currency} · {t("pay.crypto")}
            </div>
          </div>
          <button className="mk-close" onClick={onClose} aria-label={t("mk.close")}>
            ✕
          </button>
        </div>

        <div className="mk-modal__body">
          {error && <div className="err">{error}</div>}
          {!charge && !error && <div className="empty">{t("pay.creating")}</div>}

          {charge && !charge.demo && (
            <div className="pay-panel">
              <p className="mk-desc" style={{ fontSize: 12.5 }}>
                {t("pay.created", { id: charge.charge_id })}
              </p>
              <a
                className="btn btn--primary"
                href={charge.hosted_url ?? "#"}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-block", textDecoration: "none", marginTop: 10 }}
              >
                {t("pay.goto")}
              </a>
              <p className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>
                {t("pay.waiting")}
              </p>
            </div>
          )}

          {charge?.demo && (
            <div className="pay-panel pay-panel--demo">
              <div className="pay-demo-flag">{t("pay.demoFlag")}</div>
              <p className="mk-desc" style={{ fontSize: 12.5 }}>
                {config?.note ?? t("pay.demoNote")}
              </p>
              <p className="dim" style={{ fontSize: 11.5, margin: "8px 0 0" }}>
                {t("pay.demoHint")}
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
                {t("pay.demoConfirm")}
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
