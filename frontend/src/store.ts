/** Tiny cross-panel state shared through localStorage + window events.
 *
 * The marketplace lives in a different view than the terminal panels it acts
 * on, and the two are never mounted at the same time — so prop drilling and
 * context don't reach. localStorage carries the durable state (installed
 * items survive reloads); CustomEvents notify live panels of changes.
 */

import type { MarketItem } from "./api";

const INSTALLED_KEY = "aiquant.installed";
const PRESET_KEY = "aiquant.pending_preset";

export const EVENTS = {
  installed: "aiquant:installed-changed",
  preset: "aiquant:preset",
} as const;

function read<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

// ------------------------------------------------------------------ installs

export function installedIds(): string[] {
  return read<string[]>(INSTALLED_KEY, []);
}

export function isInstalled(id: string): boolean {
  return installedIds().includes(id);
}

export function toggleInstall(item: MarketItem): boolean {
  const ids = installedIds();
  const next = ids.includes(item.id) ? ids.filter((x) => x !== item.id) : [...ids, item.id];
  localStorage.setItem(INSTALLED_KEY, JSON.stringify(next));
  // Skills are denormalised so the AI panel doesn't need to refetch the catalog.
  if (item.type === "skill") {
    const skills = installedSkills().filter((s) => s.id !== item.id);
    if (next.includes(item.id) && item.integration.prompt_template) {
      skills.push({ id: item.id, name: item.name, template: item.integration.prompt_template });
    }
    localStorage.setItem("aiquant.skills", JSON.stringify(skills));
  }
  window.dispatchEvent(new CustomEvent(EVENTS.installed));
  return next.includes(item.id);
}

export interface InstalledSkill {
  id: string;
  name: string;
  template: string;
}

export function installedSkills(): InstalledSkill[] {
  return read<InstalledSkill[]>("aiquant.skills", []);
}

// ----------------------------------------------------------------- purchases

/** Client-side entitlements. Deliberate scope cut: real per-account
 * entitlements need auth + a database; until then a purchase unlocks the item
 * in this browser, and demo purchases are permanently badged as such. */
export interface PurchaseRecord {
  chargeId: string;
  provider: string;
  demo: boolean;
  at: string;
}

const PURCHASES_KEY = "aiquant.purchases";

export function purchases(): Record<string, PurchaseRecord> {
  return read<Record<string, PurchaseRecord>>(PURCHASES_KEY, {});
}

export function isPurchased(itemId: string): boolean {
  return itemId in purchases();
}

export function recordPurchase(itemId: string, record: PurchaseRecord): void {
  const all = purchases();
  all[itemId] = record;
  localStorage.setItem(PURCHASES_KEY, JSON.stringify(all));
  window.dispatchEvent(new CustomEvent(EVENTS.installed));
}

// ------------------------------------------------------------------- presets

export interface BacktestPreset {
  name: string;
  payload: Record<string, unknown>;
  /** Explicit target workspace ("us" | "crypto"). Absent = whichever terminal the
   * user last had open (marketplace flow). */
  market?: string;
}

export function queueBacktestPreset(preset: BacktestPreset): void {
  localStorage.setItem(PRESET_KEY, JSON.stringify(preset));
  window.dispatchEvent(new CustomEvent(EVENTS.preset));
}

/** Claim the pending preset for one workspace's panel.
 *
 * Two BacktestPanels are mounted (US + A-share) and both hear the preset
 * event; the claim is read-and-clear, so exactly one may take it. A preset
 * with an explicit `market` goes to that workspace; one without goes to the
 * fallback target (the last-active terminal).
 */
export function takeBacktestPresetFor(
  marketId: string,
  isFallbackTarget: boolean,
): BacktestPreset | null {
  const preset = read<BacktestPreset | null>(PRESET_KEY, null);
  if (!preset) return null;
  const mine = preset.market ? preset.market === marketId : isFallbackTarget;
  if (!mine) return null;
  localStorage.removeItem(PRESET_KEY);
  return preset;
}

// ------------------------------------------------------------ my strategies

/** AI-generated strategies the user chose to keep. Browser-local, same
 * deliberate scope cut as purchases. */
export interface SavedStrategy {
  id: string;
  name: string;
  symbol: string;
  strategy: string;
  params: Record<string, unknown>;
  rationale: string;
  risks: string[];
  beats_buy_hold: boolean;
  in_sample?: Record<string, unknown>;
  validation?: Record<string, unknown>;
  walk_forward?: Record<string, unknown>;
  savedAt: string;
}

const STRATEGIES_KEY = "aiquant.mystrategies";

export function savedStrategies(): SavedStrategy[] {
  return read<SavedStrategy[]>(STRATEGIES_KEY, []);
}

export function saveStrategy(strategy: Omit<SavedStrategy, "id" | "savedAt">): SavedStrategy {
  const record: SavedStrategy = {
    ...strategy,
    id: `strat_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    savedAt: new Date().toISOString(),
  };
  localStorage.setItem(STRATEGIES_KEY, JSON.stringify([record, ...savedStrategies()]));
  return record;
}

export function deleteStrategy(id: string): void {
  localStorage.setItem(
    STRATEGIES_KEY,
    JSON.stringify(savedStrategies().filter((s) => s.id !== id)),
  );
}

/* ------------------------------------------------- factor mining memory ---
 * Cross-session memory for the loop-engineered factor miner (AlphaMemo-style):
 * accepted factors are never resubmitted and feed the redundancy prompt;
 * lessons are the compressed per-session directives. Both live per-browser. */

const FACTORS_KEY = "aiquant.factors.zoo";
const LESSONS_KEY = "aiquant.factors.lessons";

export interface SavedFactor {
  expression: string;
  hypothesis?: string;
  market: string;
  horizon: number;
  is_ic: number;
  is_icir: number;
  oos_ic: number;
  savedAt: string;
}

export function savedFactors(): SavedFactor[] {
  return read<SavedFactor[]>(FACTORS_KEY, []);
}

export function saveFactors(factors: SavedFactor[]): SavedFactor[] {
  const existing = savedFactors();
  const known = new Set(existing.map((f) => `${f.market}|${f.expression}`));
  const fresh = factors.filter((f) => !known.has(`${f.market}|${f.expression}`));
  const merged = [...fresh, ...existing].slice(0, 40);
  localStorage.setItem(FACTORS_KEY, JSON.stringify(merged));
  return merged;
}

export function deleteFactor(market: string, expression: string): SavedFactor[] {
  const kept = savedFactors().filter(
    (f) => !(f.market === market && f.expression === expression),
  );
  localStorage.setItem(FACTORS_KEY, JSON.stringify(kept));
  return kept;
}

export function factorLessons(): string[] {
  return read<string[]>(LESSONS_KEY, []);
}

export function saveFactorLessons(lessons: string[]): string[] {
  // newest last; dedup keeps the latest occurrence; cap matches the API limit
  const merged = [...factorLessons(), ...lessons];
  const out: string[] = [];
  for (const lesson of merged.reverse()) {
    if (!out.includes(lesson)) out.push(lesson);
  }
  const final = out.reverse().slice(-12);
  localStorage.setItem(LESSONS_KEY, JSON.stringify(final));
  return final;
}

/* ---------------------------------------------------------- price alerts ---
 * Frontend-only rule engine over the live quote stream (Binance for crypto,
 * Yahoo for stocks). One-shot: a triggered alert disarms until re-armed. */

const ALERTS_KEY = "aiquant.alerts";

export interface PriceAlert {
  id: string;
  symbol: string;
  dir: "above" | "below";
  price: number;
  createdAt: string;
  triggeredAt?: string;
}

export function savedAlerts(): PriceAlert[] {
  return read<PriceAlert[]>(ALERTS_KEY, []);
}

export function saveAlert(symbol: string, dir: "above" | "below", price: number): PriceAlert[] {
  const alert: PriceAlert = {
    id: `al_${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`,
    symbol: symbol.toUpperCase(),
    dir,
    price,
    createdAt: new Date().toISOString(),
  };
  const next = [alert, ...savedAlerts()].slice(0, 30);
  localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
  return next;
}

export function deleteAlert(id: string): PriceAlert[] {
  const next = savedAlerts().filter((a) => a.id !== id);
  localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
  return next;
}

export function rearmAlert(id: string): PriceAlert[] {
  const next = savedAlerts().map((a) => (a.id === id ? { ...a, triggeredAt: undefined } : a));
  localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
  return next;
}

export function markTriggered(id: string): PriceAlert[] {
  const next = savedAlerts().map((a) =>
    a.id === id ? { ...a, triggeredAt: new Date().toISOString() } : a,
  );
  localStorage.setItem(ALERTS_KEY, JSON.stringify(next));
  return next;
}
