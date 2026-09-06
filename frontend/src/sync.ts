/** Cloud copy of the browser state for signed-in users.
 *
 * Merge rules are additive and key-aware so two devices never wipe each other:
 * factors by market|expression, paper deployments / alerts by id, purchases by
 * item id, lessons as a de-duplicated union, trials as the max. After the
 * first merge the browser pushes a snapshot whenever its state changes
 * (polled every few seconds, debounced) — no store code has to know. */
import { api } from "./api";
import { accessToken } from "./auth";

const KEYS = [
  "aiquant.factors.zoo", "aiquant.factors.lessons", "aiquant.factors.trials", "aiquant.paper", "aiquant.alerts",
  "aiquant.purchases", "aiquant.mystrategies", "aiquant.installed", "aiquant.watchlist.us", "aiquant.watchlist.crypto",
  "aiquant.stripe_account",
];

const read = (k: string): unknown => {
  const raw = localStorage.getItem(k);
  if (raw === null) return undefined;
  try { return JSON.parse(raw); } catch { return raw; }
};
const write = (k: string, v: unknown) => localStorage.setItem(k, typeof v === "string" ? v : JSON.stringify(v));

function snapshot(): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k of KEYS) { const v = read(k); if (v !== undefined) out[k] = v; }
  return out;
}

function unionBy<T>(a: T[] | undefined, b: T[] | undefined, key: (x: T) => string): T[] {
  const seen = new Map<string, T>();
  for (const x of [...(b ?? []), ...(a ?? [])]) { const k = key(x); if (!seen.has(k)) seen.set(k, x); }
  return [...seen.values()];
}

export function mergeState(local: Record<string, unknown>, remote: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...remote, ...local };
  type F = { market: string; expression: string };
  type Id = { id: string };
  out["aiquant.factors.zoo"] = unionBy(local["aiquant.factors.zoo"] as F[], remote["aiquant.factors.zoo"] as F[], (f) => `${f.market}|${f.expression}`).slice(0, 60);
  out["aiquant.paper"] = unionBy(local["aiquant.paper"] as Id[], remote["aiquant.paper"] as Id[], (p) => p.id).slice(0, 24);
  out["aiquant.alerts"] = unionBy(local["aiquant.alerts"] as Id[], remote["aiquant.alerts"] as Id[], (a) => a.id);
  out["aiquant.mystrategies"] = unionBy(local["aiquant.mystrategies"] as Id[], remote["aiquant.mystrategies"] as Id[], (s) => s.id ?? JSON.stringify(s));
  out["aiquant.factors.lessons"] = [...new Set([...((remote["aiquant.factors.lessons"] as string[]) ?? []), ...((local["aiquant.factors.lessons"] as string[]) ?? [])])].slice(-40);
  out["aiquant.factors.trials"] = Math.max(Number(local["aiquant.factors.trials"] ?? 0), Number(remote["aiquant.factors.trials"] ?? 0));
  out["aiquant.purchases"] = { ...((remote["aiquant.purchases"] as object) ?? {}), ...((local["aiquant.purchases"] as object) ?? {}) };
  for (const k of ["aiquant.installed", "aiquant.watchlist.us", "aiquant.watchlist.crypto"]) {
    const l = local[k] as unknown[] | undefined, r = remote[k] as unknown[] | undefined;
    if (Array.isArray(l) || Array.isArray(r)) out[k] = [...new Set([...(r ?? []), ...(l ?? [])].map((x) => JSON.stringify(x)))].map((x) => JSON.parse(x));
  }
  return out;
}

let timer: number | undefined;
let lastPushed = "";

/** Pull remote, merge with local, write back both ways, then start watching. */
export async function startSync(onStatus?: (s: string) => void): Promise<void> {
  if (!accessToken()) return;
  try {
    const remote = await api.accountState();
    const merged = mergeState(snapshot(), remote.data ?? {});
    for (const [k, v] of Object.entries(merged)) write(k, v);
    lastPushed = JSON.stringify(merged);
    await api.accountPutState(merged);
    onStatus?.("synced");
  } catch (err) {
    onStatus?.(`sync failed: ${(err as Error).message}`);
  }
  window.clearInterval(timer);
  timer = window.setInterval(async () => {
    if (!accessToken()) return;
    const snap = snapshot();
    const raw = JSON.stringify(snap);
    if (raw === lastPushed) return;
    try { await api.accountPutState(snap); lastPushed = raw; onStatus?.("synced"); } catch (err) { onStatus?.(`sync failed: ${(err as Error).message}`); }
  }, 8000);
}

export function stopSync(): void {
  window.clearInterval(timer);
  timer = undefined;
}
