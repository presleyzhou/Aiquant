import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useT, type MsgKey } from "../i18n";
import {
  api,
  type Checkout,
  type ListingCreate,
  type MarketItem,
  type MyListing,
  type PayMethod,
  type PaymentConfig,
  type Wallet,
} from "../api";
import {
  installedIds,
  isPurchased,
  purchases,
  queueBacktestPreset,
  recordPurchase,
  saveFactors,
  savedFactors,
  sellerSecret,
  setStripeAccount,
  stripeAccount,
  toggleInstall,
  type PurchaseRecord,
} from "../store";

const TYPE_META = {
  strategy: { labelKey: "mk.type.strategy" as MsgKey, color: "var(--amber)", rgb: "255, 176, 0" },
  skill: { labelKey: "mk.type.skill" as MsgKey, color: "var(--violet)", rgb: "167, 139, 250" },
  data: { labelKey: "mk.type.data" as MsgKey, color: "var(--cyan)", rgb: "62, 200, 224" },
  factor: { labelKey: "mk.type.factor" as MsgKey, color: "var(--accent)", rgb: "59, 224, 255" },
} as const;

const RISK_KEY = {
  low: "mk.risk.low",
  medium: "mk.risk.medium",
  high: "mk.risk.high",
} as const satisfies Record<string, MsgKey>;

const FILTERS = [
  { value: "", labelKey: "mk.filter.all" as MsgKey },
  { value: "strategy", labelKey: "mk.type.strategy" as MsgKey },
  { value: "factor", labelKey: "mk.type.factor" as MsgKey },
  { value: "skill", labelKey: "mk.type.skill" as MsgKey },
  { value: "data", labelKey: "mk.type.data" as MsgKey },
  { value: "community", labelKey: "mk.filter.community" as MsgKey },
] as const;

interface Props {
  /** Queue the preset, then let App switch back to the terminal view. */
  onRunStrategy: () => void;
}

const returnUrl = () => `${window.location.origin}${window.location.pathname}`;

export function MarketPage({ onRunStrategy }: Props) {
  const { t, lang } = useT();
  const [items, setItems] = useState<MarketItem[]>([]);
  const [filter, setFilter] = useState("");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<MarketItem | null>(null);
  const [paying, setPaying] = useState<MarketItem | null>(null);
  const [selling, setSelling] = useState(false);
  const [showMine, setShowMine] = useState(false);
  const [installed, setInstalled] = useState<string[]>(installedIds);
  const [owned, setOwned] = useState<Record<string, boolean>>(() =>
    Object.fromEntries(Object.keys(purchases()).map((id) => [id, true])),
  );
  const [payConfig, setPayConfig] = useState<PaymentConfig | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [persistence, setPersistence] = useState<string | null>(null);
  const [wallet, setWallet] = useState<Wallet | null>(null);
  const [topping, setTopping] = useState(false);
  const [showWallet, setShowWallet] = useState(false);

  const loadWallet = useCallback(() => {
    api.wallet(sellerSecret()).then(setWallet).catch(() => setWallet(null));
  }, []);

  /** Merge a paid community payload into the visible catalogue. */
  const unlock = useCallback((item: MarketItem, token: string) => {
    api
      .listingPayload(item.id, token)
      .then((res) =>
        setItems((prev) =>
          prev.map((it) => (it.id === item.id ? { ...it, integration: res.integration, locked: false } : it)),
        ),
      )
      .catch(() => undefined);
  }, []);

  const loadItems = useCallback(() => {
    api
      .marketItems()
      .then((res) => {
        const list = res.items ?? [];
        setItems(list);
        setPersistence((res as { persistence?: string }).persistence ?? null);
        // Paid community items bought earlier in this browser: fetch payloads.
        const bought = purchases();
        for (const it of list) {
          const rec = bought[it.id];
          if (it.locked && rec?.token) unlock(it, rec.token);
        }
      })
      .catch((err: Error) => setError(err.message));
  }, [unlock]);

  useEffect(() => {
    loadItems();
    loadWallet();
    api
      .paymentConfig()
      .then((c) => setPayConfig(c && c.methods ? c : null))
      .catch(() => setPayConfig(null));
  }, [loadItems, loadWallet]);

  // Return links from Stripe Checkout / Connect onboarding.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const order = params.get("order");
    const provider = params.get("provider");
    const item = params.get("item");
    const connect = params.get("connect");
    const topup = params.get("topup");
    if (order && provider && topup) {
      setNotice(t("pay.verifying"));
      api
        .orderStatus(provider, order, "")
        .then((st) => {
          if (st.status === "confirmed") {
            setNotice(t("wallet.topupDone", { a: topup }));
            loadWallet();
            setShowWallet(true);
          } else if (st.status === "pending") setNotice(t("pay.pendingReturn"));
          else setNotice(t("pay.expired"));
        })
        .catch((err: Error) => setNotice(`${t("pay.verifyFail")}: ${err.message}`));
    } else if (order && provider && item) {
      setNotice(t("pay.verifying"));
      api
        .orderStatus(provider, order, item)
        .then((st) => {
          if (st.status === "confirmed") {
            recordPurchase(item, {
              chargeId: order, provider, demo: st.demo, at: new Date().toISOString(), token: st.token, method: "card",
            });
            setOwned((prev) => ({ ...prev, [item]: true }));
            setNotice(t("pay.success"));
            if (st.token) {
              setItems((prev) => {
                const found = prev.find((it) => it.id === item);
                if (found?.locked) unlock(found, st.token!);
                return prev;
              });
            }
          } else if (st.status === "pending") setNotice(t("pay.pendingReturn"));
          else setNotice(t("pay.expired"));
        })
        .catch((err: Error) => setNotice(`${t("pay.verifyFail")}: ${err.message}`));
    }
    if (connect) {
      setStripeAccount(connect);
      setNotice(t("sell.connectDone", { id: connect }));
      setSelling(true);
    }
    if (params.get("cancelled")) setNotice(t("pay.cancelled"));
    if (params.toString()) window.history.replaceState(null, "", window.location.pathname);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return items.filter((item) => {
      if (filter === "community" && !item.community) return false;
      if (filter && filter !== "community" && item.type !== filter) return false;
      if (!q) return true;
      return (
        item.name.toLowerCase().includes(q) ||
        item.tagline.toLowerCase().includes(q) ||
        item.tags.some((tg) => tg.toLowerCase().includes(q))
      );
    });
  }, [items, filter, query]);

  const counts = useMemo(
    () => ({
      strategy: items.filter((i) => i.type === "strategy").length,
      factor: items.filter((i) => i.type === "factor").length,
      skill: items.filter((i) => i.type === "skill").length,
      data: items.filter((i) => i.type === "data").length,
      community: items.filter((i) => i.community).length,
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

  const addFactor = (item: MarketItem) => {
    const f = item.integration.factor;
    if (!f) return;
    saveFactors([
      {
        expression: f.expression, market: f.market, horizon: f.horizon,
        is_ic: f.is_ic ?? 0, is_icir: f.is_icir ?? 0, oos_ic: f.oos_ic ?? 0,
        hypothesis: f.hypothesis, savedAt: new Date().toISOString(),
      },
    ]);
    setNotice(t("mk.factorAdded", { e: f.expression }));
    setSelected(null);
  };

  const onPaid = (item: MarketItem, record: PurchaseRecord) => {
    recordPurchase(item.id, record);
    setOwned((prev) => ({ ...prev, [item.id]: true }));
    setPaying(null);
    if (item.locked && record.token) unlock(item, record.token);
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
          <span className="mk-stat" style={{ "--tint": TYPE_META.factor.rgb } as never}>
            <b>{counts.factor}</b> {t("mk.stat.factors")}
          </span>
          <span className="mk-stat" style={{ "--tint": TYPE_META.skill.rgb } as never}>
            <b>{counts.skill}</b> {t("mk.stat.skills")}
          </span>
          <span className="mk-stat" style={{ "--tint": TYPE_META.data.rgb } as never}>
            <b>{counts.data}</b> {t("mk.stat.data")}
          </span>
          <span className="mk-stat" style={{ "--tint": "255, 255, 255" } as never}>
            <b>{counts.community}</b> {t("mk.stat.community")}
          </span>
        </div>
        <div className="mk-hero__actions">
          <button className="mk-wallet" onClick={() => setShowWallet((v) => !v)} title={t("wallet.title")}>
            <span className="mk-wallet__label">{t("wallet.balance")}</span>
            <b>${(wallet?.balance_usd ?? 0).toFixed(2)}</b>
            {wallet && wallet.demo_usd > 0 && <span className="mk-wallet__demo">+${wallet.demo_usd.toFixed(2)} demo</span>}
          </button>
          <button className="btn btn--primary" onClick={() => setTopping(true)}>{t("wallet.topup")}</button>
          <button className="btn" onClick={() => setSelling(true)}>{t("sell.cta")}</button>
          <button className="btn" onClick={() => setShowMine((v) => !v)}>
            {showMine ? t("sell.hideMine") : t("sell.mine")}
          </button>
          {payConfig && (
            <span className="mk-paybadges" title={payConfig.note}>
              <span className={`mk-chip ${payConfig.methods.card ? "is-on" : ""}`}>{t("pay.method.card")}</span>
              <span className={`mk-chip ${payConfig.methods.crypto ? "is-on" : ""}`}>{t("pay.method.crypto")}</span>
              {payConfig.demo && <span className="mk-chip mk-chip--demo">{t("pay.demoFlag")}</span>}
            </span>
          )}
        </div>
      </section>

      {notice && (
        <div className="mk-notice" role="status">
          <span>{notice}</span>
          <button className="mk-close" onClick={() => setNotice(null)} aria-label={t("mk.close")}>✕</button>
        </div>
      )}

      {showWallet && (
        <WalletPanel wallet={wallet} onTopUp={() => setTopping(true)} onChanged={loadWallet} />
      )}

      {showMine && (
        <MyListingsPanel
          config={payConfig}
          onChanged={loadItems}
          onSell={() => setSelling(true)}
        />
      )}

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
      {persistence === "file" && counts.community > 0 && (
        <p className="dim mk-persist-note">{t("sell.persistFile")}</p>
      )}

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
          item={items.find((i) => i.id === selected.id) ?? selected}
          installed={installed.includes(selected.id)}
          owned={!selected.price || owned[selected.id] === true}
          ownedDemo={purchases()[selected.id]?.demo === true}
          onClose={() => setSelected(null)}
          onToggleInstall={() => handleToggleInstall(selected)}
          onRun={() => runStrategy(items.find((i) => i.id === selected.id) ?? selected)}
          onAddFactor={() => addFactor(items.find((i) => i.id === selected.id) ?? selected)}
          onBuy={() => setPaying(selected)}
        />
      )}

      {paying && (
        <PaymentModal
          item={paying}
          config={payConfig}
          wallet={wallet}
          onTopUp={() => {
            setPaying(null);
            setTopping(true);
          }}
          onWallet={setWallet}
          onClose={() => setPaying(null)}
          onPaid={(record) => onPaid(paying, record)}
        />
      )}

      {topping && (
        <TopUpModal
          config={payConfig}
          onClose={() => setTopping(false)}
          onDone={(w, msg) => {
            setTopping(false);
            if (w) setWallet(w);
            setNotice(msg);
            setShowWallet(true);
          }}
        />
      )}

      {selling && (
        <SellModal
          config={payConfig}
          onClose={() => setSelling(false)}
          onCreated={(item, persist) => {
            setSelling(false);
            setItems((prev) => [item, ...prev]);
            setNotice(persist === "file" ? `${t("sell.created")} ${t("sell.persistFile")}` : t("sell.created"));
            setShowMine(true);
          }}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------------- card */

function Card({ item, installed, onOpen }: { item: MarketItem; installed: boolean; onOpen: () => void }) {
  const { t } = useT();
  const meta = TYPE_META[item.type];
  return (
    <button className="mk-card" style={{ "--tint": meta.rgb } as never} onClick={onOpen}>
      <div className="mk-card__top">
        <span className="mk-card__icon">
          <TypeIcon type={item.type} />
        </span>
        <span className="mk-card__badges">
          {item.community && <span className="mk-badge mk-badge--community">{t("mk.community")}</span>}
          {installed && <span className="mk-badge mk-badge--installed">{t("mk.installed")}</span>}
          {item.price &&
            (isPurchased(item.id) ? (
              <span className="mk-badge mk-badge--installed">{t("mk.purchased")}</span>
            ) : (
              <span className="mk-badge mk-badge--price">${item.price.amount}</span>
            ))}
          {!item.price && item.community && <span className="mk-badge mk-badge--free">{t("mk.free")}</span>}
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
          {item.sales ? ` · ${t("mk.sold", { n: String(item.sales) })}` : ""}
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
  if (item.type === "factor" && item.integration.factor) {
    return <span className="mk-tag">{item.integration.factor.market === "crypto" ? "CRYPTO" : "US"}</span>;
  }
  return null;
}

/* ------------------------------------------------------------------ modal */

function DetailModal({
  item, installed, owned, ownedDemo, onClose, onToggleInstall, onRun, onAddFactor, onBuy,
}: {
  item: MarketItem;
  installed: boolean;
  owned: boolean;
  ownedDemo: boolean;
  onClose: () => void;
  onToggleInstall: () => void;
  onRun: () => void;
  onAddFactor: () => void;
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
  const factor = item.integration.factor;

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
          <button className="mk-close" onClick={onClose} aria-label={t("mk.close")}>✕</button>
        </div>

        <div className="mk-modal__body">
          <p className="mk-desc">{item.description}</p>

          {item.community && (
            <p className="dim" style={{ fontSize: 11.5, margin: "0 0 10px" }}>
              {t("mk.communityNote", {
                a: item.author,
                p: t(`sell.payout.${(item.payout_method ?? "none") as "none"}` as MsgKey),
              })}
            </p>
          )}

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
              <p className="dim" style={{ fontSize: 11.5, margin: "8px 0 0" }}>{t("mk.costNote")}</p>
            </div>
          )}

          {item.type === "factor" && factor && (
            <div className="mk-section">
              <div className="mk-section__title">{t("mk.factorExpr")}</div>
              <pre className="mk-code">{factor.expression}</pre>
              <div className="mk-params" style={{ marginTop: 8 }}>
                <span className="mk-param"><span className="dim">market</span> {factor.market}</span>
                <span className="mk-param"><span className="dim">horizon</span> {factor.horizon}</span>
                {factor.is_ic !== undefined && (
                  <span className="mk-param"><span className="dim">IS IC</span> {factor.is_ic.toFixed(3)}</span>
                )}
                {factor.oos_ic !== undefined && (
                  <span className="mk-param"><span className="dim">OOS IC</span> {factor.oos_ic.toFixed(3)}</span>
                )}
              </div>
              {factor.hypothesis && <p className="dim" style={{ fontSize: 11.5, margin: "8px 0 0" }}>{factor.hypothesis}</p>}
            </div>
          )}

          {item.locked && !owned && (
            <div className="mk-section">
              <p className="dim" style={{ fontSize: 12 }}>{t("mk.lockedNote")}</p>
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
                <span className={`mk-state mk-state--${item.status.state}`}>{item.status.label}</span>
              )}
              {item.integration.env_key && (
                <p className="dim" style={{ fontSize: 12, margin: "10px 0 0" }}>
                  {t("mk.envPrefix")} <code className="mk-inline-code">{item.integration.env_key}=…</code>{" "}
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
                {t(item.type === "strategy" ? "mk.unlock.strategy" : item.type === "factor" ? "mk.unlock.factor" : "mk.unlock.skill")}
              </span>
            </>
          ) : (
            <>
              {item.type === "strategy" && backtest && (
                <button className="btn btn--primary" onClick={onRun}>{t("mk.run")}</button>
              )}
              {item.type === "factor" && factor && (
                <button className="btn btn--primary" onClick={onAddFactor}>{t("mk.addFactor")}</button>
              )}
              {item.locked && (
                <span className="dim" style={{ fontSize: 11.5 }}>{t("mk.unlocking")}</span>
              )}
              {item.type !== "data" && item.type !== "factor" && (
                <button className="btn" onClick={onToggleInstall}>
                  {installed ? t("mk.remove") : item.type === "skill" ? t("mk.install") : t("mk.fav")}
                </button>
              )}
              {ownedDemo && (
                <span className="mk-badge mk-badge--demo" title={t("mk.demoTitle")}>{t("mk.demoBadge")}</span>
              )}
              {item.type === "data" && item.status?.state === "active" && (
                <span className="dim" style={{ fontSize: 12 }}>{t("mk.activeNote")}</span>
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
  item, config, wallet, onTopUp, onWallet, onClose, onPaid,
}: {
  item: MarketItem;
  config: PaymentConfig | null;
  wallet: Wallet | null;
  onTopUp: () => void;
  onWallet: (w: Wallet) => void;
  onClose: () => void;
  onPaid: (record: PurchaseRecord) => void;
}) {
  const { t } = useT();
  const [method, setMethod] = useState<PayMethod | null>(null);
  const [checkout, setCheckout] = useState<Checkout | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const pollRef = useRef<number | undefined>(undefined);
  const demo = !config || config.demo;
  const price = Number(item.price?.amount ?? 0);
  const realOk = (wallet?.balance_usd ?? 0) + 1e-9 >= price;
  const demoOk = (wallet?.demo_usd ?? 0) + 1e-9 >= price;
  const canWallet = realOk || demoOk;

  const payWithWallet = async () => {
    setBusy(true);
    setError(null);
    try {
      const st = await api.walletPurchase(sellerSecret(), item.id);
      if (st.wallet) onWallet(st.wallet);
      onPaid({ chargeId: st.order_id, provider: "wallet", demo: st.demo, at: new Date().toISOString(), token: st.token, method: "wallet" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const start = async (m: PayMethod) => {
    setMethod(m);
    setBusy(true);
    setError(null);
    try {
      const c = await api.createCheckout(item.id, m, returnUrl());
      setCheckout(c);
      if (!c.demo && m === "card" && c.hosted_url) {
        // Stripe Checkout: leave the site; the return link finishes the purchase.
        window.location.assign(c.hosted_url);
      }
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // Demo mode has one path — start it immediately.
  useEffect(() => {
    if (demo && !canWallet && !checkout && !busy && !error) void start("card");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [demo, canWallet]);

  // Crypto: poll the provider until confirmed/failed.
  useEffect(() => {
    if (!checkout || checkout.demo || checkout.method !== "crypto") return;
    const poll = async () => {
      try {
        const st = await api.orderStatus(checkout.provider, checkout.order_id, item.id);
        if (st.status === "confirmed") {
          window.clearInterval(pollRef.current);
          onPaid({
            chargeId: checkout.order_id, provider: checkout.provider, demo: false,
            at: new Date().toISOString(), token: st.token, method: "crypto",
          });
        } else if (st.status === "failed") setError(t("pay.expired"));
      } catch {
        /* transient — next tick retries */
      }
    };
    pollRef.current = window.setInterval(poll, 4000);
    return () => window.clearInterval(pollRef.current);
  }, [checkout, item.id, onPaid, t]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const confirmDemo = async () => {
    if (!checkout) return;
    setBusy(true);
    try {
      const st = await api.confirmDemo(checkout.order_id, item.id);
      onPaid({ chargeId: checkout.order_id, provider: "demo", demo: true, at: new Date().toISOString(), token: st.token, method: "demo" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

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
            <div className="mk-card__tagline">${item.price?.amount} {item.price?.currency}</div>
          </div>
          <button className="mk-close" onClick={onClose} aria-label={t("mk.close")}>✕</button>
        </div>

        <div className="mk-modal__body">
          {error && <div className="err">{error}</div>}

          {!checkout && (
            <div className="pay-wallet">
              <div className="pay-wallet__row">
                <span>
                  {t("wallet.balance")} <b>${(wallet?.balance_usd ?? 0).toFixed(2)}</b>
                  {wallet && wallet.demo_usd > 0 && <span className="dim"> · demo ${wallet.demo_usd.toFixed(2)}</span>}
                </span>
                {canWallet ? (
                  <button className="btn btn--primary" disabled={busy} onClick={payWithWallet}>
                    {realOk ? t("wallet.payWith", { a: price.toFixed(2) }) : t("wallet.payWithDemo", { a: price.toFixed(2) })}
                  </button>
                ) : (
                  <button className="btn" onClick={onTopUp}>{t("wallet.topupThenBuy")}</button>
                )}
              </div>
              {!demo && <p className="dim" style={{ fontSize: 11.5, margin: "6px 0 0" }}>{t("wallet.orDirect")}</p>}
            </div>
          )}

          {!demo && !checkout && (
            <div className="pay-methods">
              <p className="mk-desc" style={{ fontSize: 12.5 }}>{t("pay.choose")}</p>
              <div className="pay-methods__grid">
                {config?.methods.card && (
                  <button className="pay-method" disabled={busy} onClick={() => start("card")}>
                    <b>{t("pay.method.card")}</b>
                    <span className="dim">{t("pay.method.cardSub")}</span>
                  </button>
                )}
                {config?.methods.crypto && (
                  <button className="pay-method" disabled={busy} onClick={() => start("crypto")}>
                    <b>{t("pay.method.crypto")}</b>
                    <span className="dim">{t("pay.method.cryptoSub")}</span>
                  </button>
                )}
              </div>
              {busy && <div className="empty" style={{ padding: 12 }}>{t("pay.creating")}</div>}
            </div>
          )}

          {checkout && !checkout.demo && method === "card" && (
            <div className="pay-panel">
              <p className="mk-desc" style={{ fontSize: 12.5 }}>{t("pay.redirecting")}</p>
              <a className="btn btn--primary" href={checkout.hosted_url ?? "#"} style={{ display: "inline-block", textDecoration: "none", marginTop: 10 }}>
                {t("pay.goto")}
              </a>
            </div>
          )}

          {checkout && !checkout.demo && method === "crypto" && (
            <div className="pay-panel">
              <p className="mk-desc" style={{ fontSize: 12.5 }}>{t("pay.created", { id: checkout.order_id })}</p>
              <a
                className="btn btn--primary"
                href={checkout.hosted_url ?? "#"}
                target="_blank"
                rel="noreferrer"
                style={{ display: "inline-block", textDecoration: "none", marginTop: 10 }}
              >
                {t("pay.goto")}
              </a>
              <p className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>{t("pay.waiting")}</p>
            </div>
          )}

          {demo && !canWallet && !checkout && !error && <div className="empty">{t("pay.creating")}</div>}

          {checkout?.demo && (
            <div className="pay-panel pay-panel--demo">
              <div className="pay-demo-flag">{t("pay.demoFlag")}</div>
              <p className="mk-desc" style={{ fontSize: 12.5 }}>{config?.note ?? t("pay.demoNote")}</p>
              <p className="dim" style={{ fontSize: 11.5, margin: "8px 0 0" }}>{t("pay.demoHint")}</p>
              <button className="btn btn--primary" style={{ marginTop: 12 }} disabled={busy} onClick={confirmDemo}>
                {t("pay.demoConfirm")}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------------- sell */

const STRATEGIES = ["sma_cross", "ema_cross", "rsi_reversion", "buy_and_hold", "kronos_signal"] as const;
const ASSETS = ["USDC", "USDT", "BTC", "ETH", "SOL"];

function SellModal({
  config, onClose, onCreated,
}: {
  config: PaymentConfig | null;
  onClose: () => void;
  onCreated: (item: MarketItem, persistence: string) => void;
}) {
  const { t } = useT();
  const library = useMemo(() => savedFactors(), []);
  const [kind, setKind] = useState<"strategy" | "factor">(library.length ? "factor" : "strategy");
  const [libIdx, setLibIdx] = useState(0);
  const [expression, setExpression] = useState(library[0]?.expression ?? "");
  const [market, setMarket] = useState(library[0]?.market ?? "us");
  const [horizon, setHorizon] = useState(library[0]?.horizon ?? 10);
  const [strategy, setStrategy] = useState<(typeof STRATEGIES)[number]>("sma_cross");
  const [fast, setFast] = useState(20);
  const [slow, setSlow] = useState(50);
  const [rsiPeriod, setRsiPeriod] = useState(14);
  const [name, setName] = useState("");
  const [tagline, setTagline] = useState("");
  const [description, setDescription] = useState("");
  const [author, setAuthor] = useState("");
  const [tags, setTags] = useState("");
  const [price, setPrice] = useState("0");
  const [risk, setRisk] = useState<"low" | "medium" | "high">("medium");
  const [payoutMethod, setPayoutMethod] = useState<"crypto" | "stripe">("crypto");
  const [address, setAddress] = useState("");
  const [asset, setAsset] = useState("USDC");
  const acct = stripeAccount() ?? "";
  const [email, setEmail] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pickLibrary = (idx: number) => {
    setLibIdx(idx);
    const f = library[idx];
    if (!f) return;
    setExpression(f.expression);
    setMarket(f.market);
    setHorizon(f.horizon);
  };

  const priceNum = Number(price) || 0;

  const onboard = async () => {
    setBusy(true);
    setError(null);
    try {
      const res = await api.connectOnboard(email, returnUrl());
      setStripeAccount(res.account_id);
      window.location.assign(res.url);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    const lib = library[libIdx];
    const payload: Record<string, unknown> =
      kind === "factor"
        ? {
            expression, market, horizon,
            ...(lib && lib.expression === expression
              ? { is_ic: lib.is_ic, is_icir: lib.is_icir, oos_ic: lib.oos_ic, hypothesis: lib.hypothesis }
              : {}),
          }
        : strategy === "rsi_reversion"
          ? { strategy, rsi_period: rsiPeriod, rsi_oversold: 30, rsi_overbought: 70 }
          : strategy === "sma_cross" || strategy === "ema_cross"
            ? { strategy, fast, slow }
            : { strategy };
    const body: ListingCreate = {
      seller_secret: sellerSecret(),
      type: kind,
      name: name.trim(),
      tagline: tagline.trim(),
      description: description.trim(),
      author: author.trim(),
      tags: tags.split(/[,，]/).map((s) => s.trim()).filter(Boolean).slice(0, 6),
      price_usd: priceNum,
      risk: kind === "strategy" ? risk : null,
      payload,
      payout:
        priceNum <= 0
          ? { method: "none" }
          : payoutMethod === "crypto"
            ? { method: "crypto", address: address.trim(), asset }
            : { method: "stripe", stripe_account: acct.trim() },
    };
    try {
      const res = await api.createListing(body);
      onCreated(res.item, res.persistence);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mk-overlay" onClick={onClose}>
      <div
        className="mk-modal mk-modal--sell"
        style={{ "--tint": "59, 224, 255" } as never}
        onClick={(e) => e.stopPropagation()}
        role="dialog"
        aria-label={t("sell.title")}
      >
        <div className="mk-modal__head">
          <div style={{ minWidth: 0 }}>
            <div className="mk-modal__name">{t("sell.title")}</div>
            <div className="mk-card__tagline">{t("sell.sub", { fee: String(config?.platform_fee_pct ?? 10) })}</div>
          </div>
          <button className="mk-close" onClick={onClose} aria-label={t("mk.close")}>✕</button>
        </div>

        <form className="mk-modal__body mk-form" onSubmit={submit}>
          {error && <div className="err">{error}</div>}

          <div className="mk-form__row">
            <label className="mk-field">
              <span>{t("sell.kind")}</span>
              <select value={kind} onChange={(e) => setKind(e.target.value as "strategy" | "factor")}>
                <option value="strategy">{t("mk.type.strategy")}</option>
                <option value="factor">{t("mk.type.factor")}</option>
              </select>
            </label>
            <label className="mk-field">
              <span>{t("sell.price")}</span>
              <input type="number" min={0} max={999} step="0.5" value={price} onChange={(e) => setPrice(e.target.value)} />
            </label>
          </div>

          {kind === "factor" ? (
            <>
              {library.length > 0 && (
                <label className="mk-field">
                  <span>{t("sell.fromLibrary")}</span>
                  <select value={libIdx} onChange={(e) => pickLibrary(Number(e.target.value))}>
                    {library.map((f, i) => (
                      <option key={`${f.market}|${f.expression}`} value={i}>
                        {f.expression} · {f.market} · IC {f.is_ic.toFixed(3)}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <label className="mk-field">
                <span>{t("mk.factorExpr")}</span>
                <input required value={expression} onChange={(e) => setExpression(e.target.value)} placeholder="rank(delta(close, 20))" />
              </label>
              <div className="mk-form__row">
                <label className="mk-field">
                  <span>{t("sell.market")}</span>
                  <select value={market} onChange={(e) => setMarket(e.target.value)}>
                    <option value="us">US</option>
                    <option value="crypto">CRYPTO</option>
                  </select>
                </label>
                <label className="mk-field">
                  <span>{t("sell.horizon")}</span>
                  <input type="number" min={1} max={60} value={horizon} onChange={(e) => setHorizon(Number(e.target.value))} />
                </label>
              </div>
            </>
          ) : (
            <div className="mk-form__row">
              <label className="mk-field">
                <span>{t("sell.strategy")}</span>
                <select value={strategy} onChange={(e) => setStrategy(e.target.value as (typeof STRATEGIES)[number])}>
                  {STRATEGIES.map((s) => <option key={s} value={s}>{s}</option>)}
                </select>
              </label>
              {(strategy === "sma_cross" || strategy === "ema_cross") && (
                <>
                  <label className="mk-field"><span>fast</span><input type="number" min={1} max={400} value={fast} onChange={(e) => setFast(Number(e.target.value))} /></label>
                  <label className="mk-field"><span>slow</span><input type="number" min={2} max={400} value={slow} onChange={(e) => setSlow(Number(e.target.value))} /></label>
                </>
              )}
              {strategy === "rsi_reversion" && (
                <label className="mk-field"><span>rsi_period</span><input type="number" min={2} max={100} value={rsiPeriod} onChange={(e) => setRsiPeriod(Number(e.target.value))} /></label>
              )}
              <label className="mk-field">
                <span>{t("sell.risk")}</span>
                <select value={risk} onChange={(e) => setRisk(e.target.value as "low" | "medium" | "high")}>
                  <option value="low">{t("mk.risk.low")}</option>
                  <option value="medium">{t("mk.risk.medium")}</option>
                  <option value="high">{t("mk.risk.high")}</option>
                </select>
              </label>
            </div>
          )}

          <label className="mk-field">
            <span>{t("sell.name")}</span>
            <input required minLength={2} maxLength={60} value={name} onChange={(e) => setName(e.target.value)} />
          </label>
          <label className="mk-field">
            <span>{t("sell.tagline")}</span>
            <input maxLength={120} value={tagline} onChange={(e) => setTagline(e.target.value)} />
          </label>
          <label className="mk-field">
            <span>{t("sell.description")}</span>
            <textarea rows={3} maxLength={2000} value={description} onChange={(e) => setDescription(e.target.value)} />
          </label>
          <div className="mk-form__row">
            <label className="mk-field">
              <span>{t("sell.author")}</span>
              <input maxLength={40} value={author} onChange={(e) => setAuthor(e.target.value)} />
            </label>
            <label className="mk-field">
              <span>{t("sell.tags")}</span>
              <input value={tags} onChange={(e) => setTags(e.target.value)} placeholder={t("sell.tagsPh")} />
            </label>
          </div>

          {priceNum > 0 && (
            <div className="mk-section">
              <div className="mk-section__title">{t("sell.payoutTitle")}</div>
              <div className="mk-form__row">
                <label className="mk-radio">
                  <input type="radio" checked={payoutMethod === "crypto"} onChange={() => setPayoutMethod("crypto")} />
                  {t("sell.payout.crypto")}
                </label>
                <label className="mk-radio" title={config?.connect ? "" : t("sell.stripeOff")}>
                  <input type="radio" disabled={!config?.connect} checked={payoutMethod === "stripe"} onChange={() => setPayoutMethod("stripe")} />
                  {t("sell.payout.stripe")}
                </label>
              </div>
              {payoutMethod === "crypto" ? (
                <div className="mk-form__row">
                  <label className="mk-field" style={{ flex: 3 }}>
                    <span>{t("sell.address")}</span>
                    <input required minLength={20} value={address} onChange={(e) => setAddress(e.target.value)} placeholder="0x… / bc1…" />
                  </label>
                  <label className="mk-field">
                    <span>{t("sell.asset")}</span>
                    <select value={asset} onChange={(e) => setAsset(e.target.value)}>
                      {ASSETS.map((a) => <option key={a}>{a}</option>)}
                    </select>
                  </label>
                </div>
              ) : acct ? (
                <p className="dim" style={{ fontSize: 12 }}>{t("sell.connectReady", { id: acct })}</p>
              ) : (
                <div className="mk-form__row">
                  <label className="mk-field" style={{ flex: 2 }}>
                    <span>{t("sell.email")}</span>
                    <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} />
                  </label>
                  <button type="button" className="btn" disabled={busy} onClick={onboard} style={{ alignSelf: "flex-end" }}>
                    {t("sell.connectCta")}
                  </button>
                </div>
              )}
              <p className="dim" style={{ fontSize: 11.5, margin: "8px 0 0" }}>
                {payoutMethod === "crypto" ? t("sell.cryptoPayoutNote", { fee: String(config?.platform_fee_pct ?? 10) }) : t("sell.stripePayoutNote", { fee: String(config?.platform_fee_pct ?? 10) })}
              </p>
            </div>
          )}

          <div className="mk-modal__actions" style={{ padding: 0, border: 0 }}>
            <button className="btn btn--primary" type="submit" disabled={busy || (priceNum > 0 && payoutMethod === "stripe" && !acct)}>
              {busy ? t("sell.submitting") : t("sell.submit")}
            </button>
            <span className="dim" style={{ fontSize: 11.5 }}>{t("sell.terms")}</span>
          </div>
        </form>
      </div>
    </div>
  );
}

/* ------------------------------------------------------------ my listings */

function MyListingsPanel({
  config, onChanged, onSell,
}: {
  config: PaymentConfig | null;
  onChanged: () => void;
  onSell: () => void;
}) {
  const { t } = useT();
  const [rows, setRows] = useState<MyListing[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [persist, setPersist] = useState<string>("");

  const load = useCallback(() => {
    api
      .myListings(sellerSecret())
      .then((res) => {
        setRows(res.listings ?? []);
        setPersist(res.persistence);
      })
      .catch((err: Error) => setError(err.message));
  }, []);

  useEffect(load, [load]);

  const remove = async (id: string) => {
    if (!window.confirm(t("sell.removeConfirm"))) return;
    try {
      await api.removeListing(id, sellerSecret());
      load();
      onChanged();
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const gross = (rows ?? []).reduce((a, r) => a + r.gross_usd, 0);
  const net = (rows ?? []).reduce((a, r) => a + r.net_usd, 0);

  return (
    <section className="panel mk-mine">
      <div className="panel__head">
        <span className="panel__title">{t("sell.mineTitle")}</span>
        <span className="panel__meta">
          {t("sell.mineMeta", { n: String(rows?.length ?? 0), g: gross.toFixed(2), net: net.toFixed(2) })}
        </span>
      </div>
      {error && <div className="err">{error}</div>}
      {persist === "file" && <p className="dim mk-persist-note">{t("sell.persistFile")}</p>}
      {rows && rows.length === 0 && (
        <div className="empty" style={{ padding: 18 }}>
          {t("sell.mineEmpty")} <button className="ghost" onClick={onSell}>{t("sell.cta")}</button>
        </div>
      )}
      {rows && rows.length > 0 && (
        <div style={{ overflowX: "auto" }}>
          <table className="pp-compare mk-mine__table">
            <thead>
              <tr>
                <th>{t("sell.col.name")}</th>
                <th>{t("sell.col.price")}</th>
                <th>{t("sell.col.sales")}</th>
                <th>{t("sell.col.gross")}</th>
                <th>{t("sell.col.net")}</th>
                <th>{t("sell.col.payout")}</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.id}>
                  <td style={{ textAlign: "left" }}>
                    <TypeIcon type={r.type} /> {r.name}
                  </td>
                  <td>{r.price ? `$${r.price.amount}` : t("mk.free")}</td>
                  <td>{r.sales}{r.demo_sales ? <span className="dim"> (+{r.demo_sales} demo)</span> : null}</td>
                  <td>${r.gross_usd.toFixed(2)}</td>
                  <td className="up">${r.net_usd.toFixed(2)}</td>
                  <td className="dim" style={{ fontSize: 11 }}>
                    {r.payout.method === "crypto" ? `${r.payout.asset} · ${r.payout.address?.slice(0, 6)}…${r.payout.address?.slice(-4)}`
                      : r.payout.method === "stripe" ? r.payout.stripe_account : "—"}
                  </td>
                  <td>
                    <button className="watch-row__x" title={t("sell.remove")} onClick={() => remove(r.id)}>×</button>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      )}
      {config && !config.demo && (
        <p className="dim" style={{ fontSize: 11.5, margin: "8px 0 0" }}>{t("sell.settleNote")}</p>
      )}
    </section>
  );
}

/* ---------------------------------------------------------------- wallet */

const TOPUPS = [10, 25, 50, 100];

function TopUpModal({
  config, onClose, onDone,
}: {
  config: PaymentConfig | null;
  onClose: () => void;
  onDone: (wallet: Wallet | null, message: string) => void;
}) {
  const { t } = useT();
  const [amount, setAmount] = useState(25);
  const [custom, setCustom] = useState("");
  const [checkout, setCheckout] = useState<(Checkout & { kind?: string }) | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const pollRef = useRef<number | undefined>(undefined);
  const demo = !config || config.demo;
  const value = custom ? Number(custom) : amount;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const start = async (m: PayMethod) => {
    if (!(value >= 1 && value <= 2000)) {
      setError(t("wallet.amountRange"));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const c = await api.walletTopUp(sellerSecret(), value, m, returnUrl());
      setCheckout(c as unknown as Checkout);
      if (!c.demo && m === "card" && c.hosted_url) window.location.assign(c.hosted_url);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  // crypto: poll until confirmed
  useEffect(() => {
    if (!checkout || checkout.demo || checkout.method !== "crypto") return;
    const poll = async () => {
      try {
        const st = await api.orderStatus(checkout.provider, checkout.order_id, "");
        if (st.status === "confirmed") {
          window.clearInterval(pollRef.current);
          onDone(st.wallet ?? null, t("wallet.topupDone", { a: value.toFixed(2) }));
        } else if (st.status === "failed") setError(t("pay.expired"));
      } catch {
        /* retry next tick */
      }
    };
    pollRef.current = window.setInterval(poll, 4000);
    return () => window.clearInterval(pollRef.current);
  }, [checkout, onDone, t, value]);

  const confirmDemo = async () => {
    if (!checkout) return;
    setBusy(true);
    try {
      const st = await api.walletTopUpDemoConfirm(checkout.order_id, sellerSecret(), value);
      onDone(st.wallet, t("wallet.topupDemoDone", { a: value.toFixed(2) }));
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  };

  return (
    <div className="mk-overlay mk-overlay--pay" onClick={onClose}>
      <div className="mk-modal mk-modal--pay" style={{ "--tint": "59, 224, 255" } as never} onClick={(e) => e.stopPropagation()} role="dialog" aria-label={t("wallet.topupTitle")}>
        <div className="mk-modal__head">
          <div style={{ minWidth: 0 }}>
            <div className="mk-modal__name">{t("wallet.topupTitle")}</div>
            <div className="mk-card__tagline">{t("wallet.topupSub")}</div>
          </div>
          <button className="mk-close" onClick={onClose} aria-label={t("mk.close")}>✕</button>
        </div>
        <div className="mk-modal__body">
          {error && <div className="err">{error}</div>}
          {!checkout && (
            <>
              <div className="topup-amounts">
                {TOPUPS.map((a) => (
                  <button key={a} className={`chip${!custom && amount === a ? " is-on" : ""}`} onClick={() => { setAmount(a); setCustom(""); }}>
                    ${a}
                  </button>
                ))}
                <input className="input topup-custom" type="number" min={1} max={2000} placeholder={t("wallet.custom")} value={custom} onChange={(e) => setCustom(e.target.value)} aria-label={t("wallet.custom")} />
              </div>
              {demo ? (
                <div className="pay-panel pay-panel--demo" style={{ marginTop: 12 }}>
                  <div className="pay-demo-flag">{t("pay.demoFlag")}</div>
                  <p className="mk-desc" style={{ fontSize: 12.5 }}>{config?.note ?? t("pay.demoNote")}</p>
                  <p className="dim" style={{ fontSize: 11.5, margin: "8px 0 0" }}>{t("wallet.demoTopupNote")}</p>
                  <button className="btn btn--primary" style={{ marginTop: 12 }} disabled={busy} onClick={() => start("card")}>
                    {t("wallet.demoTopupCta", { a: value.toFixed(2) })}
                  </button>
                </div>
              ) : (
                <div className="pay-methods">
                  <p className="mk-desc" style={{ fontSize: 12.5, marginTop: 12 }}>{t("pay.choose")}</p>
                  <div className="pay-methods__grid">
                    {config?.methods.card && (
                      <button className="pay-method" disabled={busy} onClick={() => start("card")}>
                        <b>{t("pay.method.card")}</b>
                        <span className="dim">{t("pay.method.cardSub")}</span>
                      </button>
                    )}
                    {config?.methods.crypto && (
                      <button className="pay-method" disabled={busy} onClick={() => start("crypto")}>
                        <b>{t("pay.method.crypto")}</b>
                        <span className="dim">{t("pay.method.cryptoSub")}</span>
                      </button>
                    )}
                  </div>
                </div>
              )}
            </>
          )}
          {checkout?.demo && (
            <div className="pay-panel pay-panel--demo">
              <div className="pay-demo-flag">{t("pay.demoFlag")}</div>
              <p className="mk-desc" style={{ fontSize: 12.5 }}>{t("wallet.demoConfirmNote", { a: value.toFixed(2) })}</p>
              <button className="btn btn--primary" style={{ marginTop: 12 }} disabled={busy} onClick={confirmDemo}>
                {t("wallet.demoConfirm")}
              </button>
            </div>
          )}
          {checkout && !checkout.demo && checkout.method === "card" && (
            <div className="pay-panel">
              <p className="mk-desc" style={{ fontSize: 12.5 }}>{t("pay.redirecting")}</p>
              <a className="btn btn--primary" href={checkout.hosted_url ?? "#"} style={{ display: "inline-block", textDecoration: "none", marginTop: 10 }}>{t("pay.goto")}</a>
            </div>
          )}
          {checkout && !checkout.demo && checkout.method === "crypto" && (
            <div className="pay-panel">
              <p className="mk-desc" style={{ fontSize: 12.5 }}>{t("pay.created", { id: checkout.order_id })}</p>
              <a className="btn btn--primary" href={checkout.hosted_url ?? "#"} target="_blank" rel="noreferrer" style={{ display: "inline-block", textDecoration: "none", marginTop: 10 }}>{t("pay.goto")}</a>
              <p className="dim" style={{ fontSize: 11.5, marginTop: 10 }}>{t("pay.waiting")}</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function WalletPanel({ wallet, onTopUp, onChanged }: { wallet: Wallet | null; onTopUp: () => void; onChanged: () => void }) {
  const { t } = useT();
  const [amount, setAmount] = useState("");
  const [address, setAddress] = useState("");
  const [method, setMethod] = useState<"crypto" | "bank">("crypto");
  const [msg, setMsg] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const withdraw = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      const res = await api.walletWithdraw(sellerSecret(), Number(amount), method, address.trim());
      setMsg(t("wallet.withdrawDone", { id: res.id, a: res.amount.toFixed(2) }));
      setAmount("");
      onChanged();
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const KIND: Record<string, MsgKey> = {
    topup: "wallet.k.topup", purchase: "wallet.k.purchase", sale: "wallet.k.sale", withdraw: "wallet.k.withdraw",
  };

  return (
    <section className="panel mk-mine">
      <div className="panel__head">
        <span className="panel__title">{t("wallet.title")}</span>
        <span className="panel__meta">
          {t("wallet.meta", { b: (wallet?.balance_usd ?? 0).toFixed(2), d: (wallet?.demo_usd ?? 0).toFixed(2) })}
          <button className="ghost" style={{ marginLeft: 8 }} onClick={onTopUp}>{t("wallet.topup")}</button>
        </span>
      </div>
      <p className="dim" style={{ fontSize: 11.5, margin: "0 0 8px" }}>{t("wallet.note")}</p>
      {wallet && wallet.entries.length > 0 ? (
        <div style={{ overflowX: "auto" }}>
          <table className="pp-compare mk-mine__table">
            <thead>
              <tr><th style={{ textAlign: "left" }}>{t("wallet.col.when")}</th><th style={{ textAlign: "left" }}>{t("wallet.col.kind")}</th><th style={{ textAlign: "left" }}>{t("wallet.col.note")}</th><th>{t("wallet.col.amount")}</th></tr>
            </thead>
            <tbody>
              {wallet.entries.map((e) => (
                <tr key={e.id}>
                  <td style={{ textAlign: "left" }} className="dim">{new Date(e.at * 1000).toLocaleDateString()}</td>
                  <td style={{ textAlign: "left" }}>{t(KIND[e.kind] ?? "wallet.k.topup")}{e.demo ? <span className="mk-badge mk-badge--demo" style={{ marginLeft: 6 }}>demo</span> : null}</td>
                  <td style={{ textAlign: "left" }} className="dim">{e.note || e.ref}</td>
                  <td className={e.amount >= 0 ? "up" : "dn"}>{e.amount >= 0 ? "+" : ""}${e.amount.toFixed(2)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="empty" style={{ padding: 14 }}>{t("wallet.empty")}</div>
      )}
      <form className="mk-form__row" style={{ marginTop: 10, alignItems: "flex-end" }} onSubmit={withdraw}>
        <label className="mk-field"><span>{t("wallet.withdrawAmount")}</span><input type="number" min={1} step="0.01" required value={amount} onChange={(e) => setAmount(e.target.value)} /></label>
        <label className="mk-field"><span>{t("wallet.withdrawMethod")}</span>
          <select value={method} onChange={(e) => setMethod(e.target.value as "crypto" | "bank")}>
            <option value="crypto">{t("sell.payout.crypto")}</option>
            <option value="bank">{t("wallet.bank")}</option>
          </select>
        </label>
        <label className="mk-field" style={{ flex: 3 }}><span>{t("wallet.withdrawTo")}</span><input required minLength={6} value={address} onChange={(e) => setAddress(e.target.value)} placeholder={method === "crypto" ? "0x… / bc1…" : "IBAN / 账户"} /></label>
        <button className="btn" type="submit" disabled={busy || !wallet || wallet.balance_usd < 1}>{t("wallet.withdraw")}</button>
      </form>
      {msg && <p className="dim" style={{ fontSize: 12, margin: "8px 0 0" }}>{msg}</p>}
    </section>
  );
}

/* ------------------------------------------------------------------ icons */

function TypeIcon({ type }: { type: MarketItem["type"] }) {
  const common = {
    width: 18, height: 18, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor",
    strokeWidth: 2, strokeLinecap: "round" as const, strokeLinejoin: "round" as const,
  };
  if (type === "strategy") {
    return (
      <svg {...common}>
        <polyline points="3 17 9 11 13 15 21 7" />
        <polyline points="15 7 21 7 21 13" />
      </svg>
    );
  }
  if (type === "factor") {
    return (
      <svg {...common}>
        <path d="M4 20l6-6" />
        <path d="M14 4l6 6-8 8-6-6z" />
        <path d="M12 9l3 3" />
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
