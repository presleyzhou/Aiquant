import { useCallback, useEffect, useState } from "react";
import { api, type AdminOpsRun, type AdminOverview, type AdminWithdrawal, type MarketItem } from "../api";
import { useT } from "../i18n";
import { fallbackTone } from "./pipeline/format";

const TOKEN_KEY = "aiquant.admin.token";

/** Minimal operator console (reached via ?admin=1). Everything here is the
 * same KV the product writes; the token never leaves sessionStorage. */
export function AdminPage() {
  const { t } = useT();
  const [token, setToken] = useState<string>(() => sessionStorage.getItem(TOKEN_KEY) ?? "");
  const [draft, setDraft] = useState("");
  const [overview, setOverview] = useState<AdminOverview | null>(null);
  const [withdrawals, setWithdrawals] = useState<AdminWithdrawal[]>([]);
  const [orders, setOrders] = useState<Array<Record<string, unknown>>>([]);
  const [listings, setListings] = useState<Array<MarketItem & { status: string; seller: string }>>([]);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = useCallback(async (tok: string) => {
    setError(null);
    try {
      const [ov, wd, od, ls] = await Promise.all([api.admin.overview(tok), api.admin.withdrawals(tok), api.admin.orders(tok), api.admin.listings(tok)]);
      setOverview(ov); setWithdrawals(wd.withdrawals); setOrders(od.orders); setListings(ls.listings);
      sessionStorage.setItem(TOKEN_KEY, tok);
      setToken(tok);
    } catch (err) {
      setError((err as Error).message);
      setOverview(null);
    }
  }, []);

  useEffect(() => { if (token) void load(token); }, [token, load]);

  const settle = async (id: string, status: "paid" | "rejected") => {
    const note = window.prompt(t("adm.noteHint")) ?? "";
    setBusy(true);
    try { await api.admin.updateWithdrawal(token, id, status, note); await load(token); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const recheck = async () => {
    setBusy(true);
    try { const r = await api.admin.recheck(token); setError(t("adm.recheckDone", { n: String(r.done), f: String(r.failed) })); await load(token); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const runOps = async () => {
    setBusy(true);
    try { await api.admin.ops(token); await load(token); } catch (err) { setError((err as Error).message); } finally { setBusy(false); }
  };
  const when = (ts?: number | null) => (ts ? new Date(ts * 1000).toLocaleString() : "—");
  /** `{}` before the first run → null. */
  const opsLast: AdminOpsRun | null =
    overview?.ops_last && typeof (overview.ops_last as AdminOpsRun).started_at === "number" ? (overview.ops_last as AdminOpsRun) : null;
  const providers = overview?.provider_health;
  const providerRows = providers ? Object.entries(providers.markets) : [];

  if (!overview) {
    return (
      <div className="lab"><div className="lab__inner">
        <section className="lab-hero"><h1 className="lab-hero__title">{t("adm.title")}</h1><p className="lab-hero__sub">{t("adm.sub")}</p></section>
        <form className="mk-form__row" style={{ maxWidth: 520 }} onSubmit={(e) => { e.preventDefault(); void load(draft.trim()); }}>
          <label className="mk-field" style={{ flex: 3 }}><span>ADMIN_TOKEN</span><input type="password" value={draft} onChange={(e) => setDraft(e.target.value)} required /></label>
          <button className="btn btn--primary" type="submit" style={{ alignSelf: "flex-end" }}>{t("adm.enter")}</button>
        </form>
        {error && <div className="err" style={{ marginTop: 10 }}>{error}</div>}
      </div></div>
    );
  }

  const c = overview.counts;
  return (
    <div className="lab"><div className="lab__inner">
      <section className="lab-hero">
        <h1 className="lab-hero__title">{t("adm.title")}</h1>
        <p className="lab-hero__sub">{t("adm.persist", { p: overview.persistence })}{overview.persistence === "file" ? ` — ${t("sell.persistFile")}` : ""}</p>
      </section>
      {error && <div className="mk-notice"><span>{error}</span><button className="mk-close" onClick={() => setError(null)}>✕</button></div>}
      <div className="stat-grid" style={{ marginBottom: 14 }}>
        {[["adm.c.listings", `${c.active_listings} / ${c.listings}`], ["adm.c.orders", `${c.real_orders} / ${c.orders}`], ["adm.c.gross", `$${overview.gross_usd.toFixed(2)}`], ["adm.c.liab", `$${overview.wallet_liabilities_usd.toFixed(2)}`], ["adm.c.accounts", String(c.accounts_synced)], ["adm.c.pending", String(c.withdrawals_pending)]].map(([k, v]) => (
          <div className="stat" key={k}><div className="stat__label">{t(k as "adm.c.listings")}</div><div className="stat__value">{v}</div></div>
        ))}
      </div>
      <section className="panel mk-mine">
        <div className="panel__head"><span className="panel__title">{t("adm.recheck")}</span>
          <span className="panel__meta">{t("adm.lastRun", { d: when(overview.health_runs.last_run), n: String(overview.health_runs.done ?? 0), f: String(overview.health_runs.failed ?? 0) })}
            <button className="ghost" style={{ marginLeft: 8 }} disabled={busy} onClick={recheck}>{busy ? "…" : t("adm.recheckNow")}</button></span></div>
      </section>
      <section className="panel mk-mine" data-testid="adm-ops">
        <div className="panel__head"><span className="panel__title">{t("adm.ops")}</span>
          <span className="panel__meta">
            {opsLast && (
              <>
                <span data-testid="adm-ops-when">{when(opsLast.started_at)} · {t("adm.ops.total", { s: opsLast.seconds.toFixed(1) })}</span>
                <span className={`pl-badge ${opsLast.ok ? "pl-badge--ok" : "pl-badge--warn"}`} style={{ marginLeft: 8 }} data-testid="adm-ops-ok">
                  {opsLast.ok ? t("adm.ops.ok") : t("adm.ops.failed")}
                </span>
              </>
            )}
            <button className="ghost" style={{ marginLeft: 8 }} disabled={busy} onClick={runOps} data-testid="adm-ops-run">{busy ? "…" : t("adm.ops.runNow")}</button>
          </span></div>
        {!opsLast ? <div className="empty" style={{ padding: 14 }} data-testid="adm-ops-empty">{t("adm.ops.never")}</div> : (
          <div style={{ overflowX: "auto" }}><table className="pp-compare mk-mine__table" data-testid="adm-ops-steps"><thead><tr><th>{t("adm.ops.step")}</th><th>{t("adm.w.status")}</th><th>{t("adm.ops.seconds")}</th><th>{t("adm.ops.error")}</th></tr></thead><tbody>
            {opsLast.steps.map((st) => (
              <tr key={st.step} data-step={st.step}>
                <td style={{ textAlign: "left" }}>{t(`adm.ops.step.${st.step}` as "adm.ops.step.warm") === `adm.ops.step.${st.step}` ? st.step : t(`adm.ops.step.${st.step}` as "adm.ops.step.warm")}</td>
                <td className={st.ok ? "up" : "dn"}>{st.ok ? t("adm.ops.ok") : t("adm.ops.failed")}</td>
                <td>{st.seconds.toFixed(1)}s</td>
                <td className="dim" style={{ textAlign: "left", fontSize: 11 }}>{st.error ?? "—"}</td>
              </tr>
            ))}
            <tr><td colSpan={4} className="dim" style={{ textAlign: "left" }} data-testid="adm-ops-remaining">{t("adm.ops.remaining", { n: String(opsLast.monitor_remaining) })}</td></tr>
          </tbody></table></div>
        )}
      </section>
      <section className="panel mk-mine" data-testid="adm-providers">
        <div className="panel__head"><span className="panel__title">{t("adm.prov", { d: String(providers?.days ?? "—") })}</span>
          <span className="panel__meta">{providers ? when(providers.generated_at) : ""}</span></div>
        {providerRows.length === 0 ? <div className="empty" style={{ padding: 14 }} data-testid="adm-providers-empty">{t("adm.prov.none")}</div> : (
          <div style={{ overflowX: "auto" }}><table className="pp-compare mk-mine__table" data-testid="adm-providers-table"><thead><tr><th>{t("fl.market")}</th><th>{t("adm.prov.calls")}</th><th>{t("adm.prov.fallback")}</th><th>{t("adm.prov.avg")}</th><th>{t("adm.prov.served")}</th></tr></thead><tbody>
            {providerRows.map(([market, m]) => (
              <tr key={market} data-market={market}>
                <td style={{ textAlign: "left" }}><b>{market}</b></td>
                <td>{m.calls}</td>
                <td className={fallbackTone(m.fallback_rate_pct)} data-testid={`adm-prov-fallback-${market}`}>{m.fallback_rate_pct.toFixed(1)}%</td>
                <td>{m.avg_seconds.toFixed(2)}s</td>
                <td className="dim" style={{ textAlign: "left", fontSize: 11 }}>
                  {Object.entries(m.served).sort((a, b) => b[1] - a[1]).map(([p, n]) => `${p} ${n}`).join(" · ") || "—"}
                </td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </section>
      <section className="panel mk-mine">
        <div className="panel__head"><span className="panel__title">{t("adm.withdrawals")}</span><span className="panel__meta">{withdrawals.length}</span></div>
        {withdrawals.length === 0 ? <div className="empty" style={{ padding: 14 }}>{t("adm.none")}</div> : (
          <div style={{ overflowX: "auto" }}><table className="pp-compare mk-mine__table"><thead><tr><th>{t("adm.w.when")}</th><th>{t("adm.w.amount")}</th><th>{t("adm.w.to")}</th><th>{t("adm.w.status")}</th><th /></tr></thead><tbody>
            {withdrawals.map((w) => (
              <tr key={w.id}>
                <td className="dim" style={{ textAlign: "left" }}>{when(w.at)}<br /><span style={{ fontSize: 10 }}>{w.id} · {w.account.slice(0, 10)}</span></td>
                <td>${w.amount.toFixed(2)}</td>
                <td style={{ textAlign: "left", fontSize: 11 }}>{w.method} · {w.address}</td>
                <td className={w.status === "paid" ? "up" : w.status === "rejected" ? "dn" : ""}>{w.status}{w.note ? ` · ${w.note}` : ""}</td>
                <td>{w.status === "pending" && (<><button className="btn btn--mini" disabled={busy} onClick={() => settle(w.id, "paid")}>{t("adm.markPaid")}</button> <button className="btn btn--mini" disabled={busy} onClick={() => settle(w.id, "rejected")}>{t("adm.reject")}</button></>)}</td>
              </tr>
            ))}
          </tbody></table></div>
        )}
      </section>
      <section className="panel mk-mine">
        <div className="panel__head"><span className="panel__title">{t("adm.orders")}</span><span className="panel__meta">{orders.length}</span></div>
        <div style={{ overflowX: "auto" }}><table className="pp-compare mk-mine__table"><thead><tr><th>{t("adm.w.when")}</th><th>{t("adm.o.kind")}</th><th>{t("adm.o.item")}</th><th>{t("adm.w.amount")}</th><th>{t("adm.o.provider")}</th></tr></thead><tbody>
          {orders.slice(0, 100).map((o) => (
            <tr key={String(o.order_id)}>
              <td className="dim" style={{ textAlign: "left" }}>{when(Number(o.at))}</td>
              <td style={{ textAlign: "left" }}>{String(o.kind ?? "item")}{o.demo ? " (demo)" : ""}</td>
              <td style={{ textAlign: "left", fontSize: 11 }}>{String(o.item_id ?? o.account ?? "")}</td>
              <td>${Number(o.amount ?? 0).toFixed(2)}</td>
              <td className="dim">{String(o.provider)}</td>
            </tr>
          ))}
        </tbody></table></div>
      </section>
      <section className="panel mk-mine">
        <div className="panel__head"><span className="panel__title">{t("adm.listings")}</span><span className="panel__meta">{listings.length}</span></div>
        <div style={{ overflowX: "auto" }}><table className="pp-compare mk-mine__table"><thead><tr><th>{t("sell.col.name")}</th><th>{t("mk.type.strategy")}/{t("mk.type.factor")}</th><th>{t("sell.col.price")}</th><th>{t("sell.col.sales")}</th><th>{t("adm.l.seller")}</th><th>{t("adm.w.status")}</th></tr></thead><tbody>
          {listings.map((l) => (
            <tr key={l.id}>
              <td style={{ textAlign: "left" }}>{l.name}</td><td>{l.type}</td><td>{l.price ? `$${l.price.amount}` : t("mk.free")}</td><td>{l.sales ?? 0}</td><td className="dim">{l.seller}</td><td>{l.status}</td>
            </tr>
          ))}
        </tbody></table></div>
      </section>
      <p><button className="ghost" onClick={() => { sessionStorage.removeItem(TOKEN_KEY); setToken(""); setOverview(null); }}>{t("adm.logout")}</button></p>
    </div></div>
  );
}
