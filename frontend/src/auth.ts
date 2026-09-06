/** Supabase Auth wrapper. Absent VITE_SUPABASE_URL / VITE_SUPABASE_ANON_KEY the
 * app keeps its browser-held identities and every helper here is a no-op. */
import { createClient, type Session, type SupabaseClient } from "@supabase/supabase-js";

const URL_ = import.meta.env.VITE_SUPABASE_URL as string | undefined;
const KEY = import.meta.env.VITE_SUPABASE_ANON_KEY as string | undefined;

export const authEnabled = Boolean(URL_ && KEY);
let client: SupabaseClient | null = null;
let session: Session | null = null;
const listeners = new Set<(s: Session | null) => void>();

export function supabase(): SupabaseClient | null {
  if (!authEnabled) return null;
  if (!client) {
    client = createClient(URL_!, KEY!, { auth: { persistSession: true, autoRefreshToken: true, detectSessionInUrl: true } });
    client.auth.getSession().then(({ data }) => setSession(data.session));
    client.auth.onAuthStateChange((_e, s) => setSession(s));
  }
  return client;
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
  const c = supabase();
  if (!c) throw new Error("auth not configured");
  const { error } = await c.auth.signInWithOtp({ email, options: { emailRedirectTo: `${window.location.origin}${window.location.pathname}` } });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  await supabase()?.auth.signOut();
}
