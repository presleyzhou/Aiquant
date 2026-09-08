import type { FactorCheck } from "../api";
import type { SavedFactor } from "../store";

export const fmt = (v?: number) => (v === undefined || v === null || Number.isNaN(v) ? "—" : (v >= 0 ? "+" : "") + v.toFixed(3));

/** Sign-aligned decay verdict: recent IC in the direction the factor was
 * accepted with, below the loose bar = suspected decay. */
export const decayState = (f: SavedFactor, h: FactorCheck): "ok" | "decayed" => {
  const aligned = h.recent_ic * Math.sign(f.is_ic || 1);
  return aligned < 0.01 ? "decayed" : "ok";
};

/** Cross-market transfer: same-sign and non-trivial on the other market. */
export const transferState = (f: SavedFactor, h: FactorCheck): "ok" | "fail" => {
  const aligned = h.is_ic * Math.sign(f.is_ic || 1);
  const alignedOos = h.oos_ic * Math.sign(f.is_ic || 1);
  return aligned > 0.01 && alignedOos > 0 ? "ok" : "fail";
};
