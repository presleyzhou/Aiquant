/** Supabase Auth wrapper, configured at RUNTIME from /api/account/config
 * (the backend already holds SUPABASE_URL and the public anon key), so no
 * VITE_* build variables are needed and the same bundle works on every
 * deployment. Until the config says `enabled`, every helper is a no-op. */
import type { Session, SupabaseClient } from "@supabase/supabase-js";

let client: SupabaseClient | null = null;
let session: Session | null = null;
let enabled = false;
let ready: Promise<boolean> | null = null;
const listeners = new Set<(s: Session | null) => void>();

export interface AuthConfig { enabled: boolean; supabase_url?: string | null; anon_key?: string | null }

/** Resolve once: fetch the config and build the client if configured. */
export function initAuth(): Promise<boolean> {
  if (ready) return ready;
  ready = fetch("/api/account/config")
    .then((r) => (r.ok ? (r.json() as Promise<AuthConfig>) : Promise.reject(new Error(String(r.status)))))
    .then(async (cfg) => {
      if (!cfg.enabled || !cfg.supabase_url || !cfg.anon_key) return false;
      // The SDK (~40 KB gzip) only ships to browsers whose deployment has auth on.
      const { createClient } = await import("@supabase/supabase-js");
      client = createClient(cfg.supabase_url, cfg.anon_key, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
      client.auth.getSession().then(({ data }) => setSession(data.session));
      client.auth.onAuthStateChange((_e, s) => setSession(s));
      enabled = true;
      return true;
    })
    .catch(() => false);
  return ready;
}

export function authEnabled(): boolean {
  return enabled;
}

function setSession(s: Session | null) {
  session = s;
  listeners.forEach((fn) => fn(s));
}

export function onAuth(fn: (s: Session | null) => void): () => void {
  listeners.add(fn);
  fn(session);
  return () => listeners.delete(fn);
}

export function currentSession(): Session | null {
  return session;
}

export function accessToken(): string | null {
  return session?.access_token ?? null;
}

/** Headers for identity-bearing API calls: bearer when signed in. */
export function authHeaders(): Record<string, string> {
  const tok = accessToken();
  return tok ? { Authorization: `Bearer ${tok}` } : {};
}

export async function signInWithEmail(email: string): Promise<void> {
  if (!client) throw new Error("auth not configured");
  const { error } = await client.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` } });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  await client?.auth.signOut();
}
