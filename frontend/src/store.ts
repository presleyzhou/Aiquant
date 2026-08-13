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

// ------------------------------------------------------------------- presets

export interface BacktestPreset {
  name: string;
  payload: Record<string, unknown>;
}

export function queueBacktestPreset(preset: BacktestPreset): void {
  localStorage.setItem(PRESET_KEY, JSON.stringify(preset));
  window.dispatchEvent(new CustomEvent(EVENTS.preset));
}

/** Read-and-clear, so a stale preset never re-fires on a later mount. */
export function takeBacktestPreset(): BacktestPreset | null {
  const preset = read<BacktestPreset | null>(PRESET_KEY, null);
  localStorage.removeItem(PRESET_KEY);
  return preset;
}
