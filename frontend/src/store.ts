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
  /** Explicit target workspace ("us" | "cn"). Absent = whichever terminal the
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
