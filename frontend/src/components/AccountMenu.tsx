import { useEffect, useState } from "react";
import type { Session } from "@supabase/supabase-js";
import { api } from "../api";
import { authEnabled, onAuth, signInWithEmail, signOut, supabase } from "../auth";
import { useT } from "../i18n";
import { sellerSecret } from "../store";
import { startSync, stopSync } from "../sync";

/** Header account control: sign in with a magic link, see the sync state,
 * fold this browser's wallet/listings into the account, sign out. Hidden
 * entirely (renders nothing) when Supabase is not configured. */
export function AccountMenu() {
  const { t } = useT();
  const [session, setSession] = useState<Session | null>(null);
  const [open, setOpen] = useState(false);
  const [email, setEmail] = useState("");
  const [msg, setMsg] = useState<string | null>(null);
  const [sync, setSync] = useState<string>("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!authEnabled) return;
    supabase();
    return onAuth((s) => {
      setSession(s);
      if (s) void startSync(setSync);
      else stopSync();
    });
  }, []);

  if (!authEnabled) return null;

  const sendLink = async (e: React.FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setMsg(null);
    try {
      await signInWithEmail(email.trim());
      setMsg(t("acct.linkSent", { e: email.trim() }));
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  const claim = async () => {
    setBusy(true);
    try {
      const res = await api.accountClaim(sellerSecret());
      setMsg(t("acct.claimed", { b: res.wallet.balance_usd.toFixed(2), n: String(res.listings_moved) }));
    } catch (err) {
      setMsg((err as Error).message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="acct">
      <button className={`btn btn--mini acct__btn ${session ? "is-on" : ""}`} onClick={() => setOpen((v) => !v)} title={t("acct.title")}>
        {session ? `👤 ${session.user.email?.split("@")[0] ?? t("acct.signedIn")}` : t("acct.signIn")}
      </button>
      {open && (
        <div className="acct__pop">
          {!session ? (
            <form onSubmit={sendLink} className="acct__form">
              <div className="acct__head">{t("acct.signIn")}</div>
              <p className="dim">{t("acct.why")}</p>
              <input type="email" required placeholder="you@example.com" value={email} onChange={(e) => setEmail(e.target.value)} />
              <button className="btn btn--primary" type="submit" disabled={busy}>{busy ? "…" : t("acct.sendLink")}</button>
            </form>
          ) : (
            <div className="acct__form">
              <div className="acct__head">{session.user.email}</div>
              <p className="dim">{sync ? t("acct.sync", { s: sync }) : t("acct.syncing")}</p>
              <button className="btn" disabled={busy} onClick={claim} title={t("acct.claimTitle")}>{t("acct.claim")}</button>
              <button className="ghost" onClick={() => { stopSync(); void signOut(); setOpen(false); }}>{t("acct.signOut")}</button>
            </div>
          )}
          {msg && <p className="acct__msg">{msg}</p>}
        </div>
      )}
    </div>
  );
}
