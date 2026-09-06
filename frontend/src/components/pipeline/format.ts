import type { PipelineResult } from "../../api";

export const maxWeight = (r: PipelineResult) => Math.max(0.01, ...r.target_weights.weights.map((w) => w.weight_pct));
/** V5 ticket amounts: account currency, two decimals, thousands separators. */
export const money = (v: number) => v.toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
/** Reference prices: two decimals above 1, four significant digits below (sub-dollar crypto). */
export const price = (v: number) => (Math.abs(v) >= 1 ? money(v) : v.toPrecision(4));
export const tone = (v: number) => (v > 0 ? "up" : v < 0 ? "dn" : "");
export const pct = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(2)}%`;
export const pctOpt = (v: number | null) => (v === null ? "—" : pct(v));
export const num = (v: number) => v.toFixed(2);
export const numOpt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));
export const signed1 = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(1)}`;
export const signed1Opt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : signed1(v));
export const signed2Opt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v > 0 ? "+" : ""}${v.toFixed(2)}`);
export const signed3 = (v: number) => `${v > 0 ? "+" : ""}${v.toFixed(3)}`;
export const signed3Opt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : signed3(v));
/** Probabilities (PSR / DSR) print as 0.xx; a null means too short a track. */
export const prob = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(2));
/** ≥ 0.95 is the usual bar for PSR/DSR; 0.8–0.95 is borderline; below is luck territory. */
export const probTone = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v >= 0.95 ? "pl-tone--ok" : v >= 0.8 ? "pl-tone--warn" : "pl-tone--bad";
/** Harvey-Liu-Zhu: ≥ 3 clears the multiple-testing hurdle, 2–3 is borderline, < 2 is not a finding. */
export const tstatTone = (v: number | null | undefined) =>
  v === null || v === undefined ? "" : v >= 3 ? "pl-tone--ok" : v >= 2 ? "pl-tone--warn" : "pl-tone--bad";
/** MinTRL: fine once the track is at least as long as required; null means Sharpe ≤ 0 (no length suffices). */
export const mintrlTone = (need: number | null | undefined, have: number | undefined) =>
  need === undefined ? "" : need === null ? "pl-tone--bad" : have !== undefined && have >= need ? "pl-tone--ok" : "pl-tone--warn";
/** V3.1 p-value vs 1/N: green only when the scheme beats equal weight AND the gap is significant. */
export const pOpt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : v.toFixed(3));
export const pTone = (p: number | null | undefined, delta: number | undefined) =>
  p !== null && p !== undefined && p < 0.05 && (delta ?? 0) > 0 ? "pl-tone--ok" : "dim";
export const ratio = (v: number | null) => (v === null ? "—" : v.toFixed(2));
/** V4 rolling half-year hit rate vs 1/N: ≥ 60 is a real edge, 45–60 a coin toss, below that the benchmark wins. */
export const hitTone = (v: number | null) => (v === null ? "" : v >= 60 ? "pl-tone--ok" : v >= 45 ? "pl-tone--warn" : "pl-tone--bad");
/** V4 spike = chosen Sharpe − grid median: ≤ 0.2 plateau, 0.2–0.5 borderline, > 0.5 the server flags a parameter spike. */
export const spikeTone = (v: number | null) => (v === null ? "" : v <= 0.2 ? "pl-tone--ok" : v <= 0.5 ? "pl-tone--warn" : "pl-tone--bad");
/** Up-capture above 1 and down-capture below 1 are the good directions. */
export const captureTone = (v: number | null, up: boolean) => (v === null ? "" : (up ? v >= 1 : v <= 1) ? "up" : "dn");
/** V6 two-decimal percentages (impact drag, participation); null prints as a dash. */
export const pct2Opt = (v: number | null | undefined) => (v === null || v === undefined ? "—" : `${v.toFixed(2)}%`);
/** V6 data coverage: ≥ 95% clean, 80–95% patchy, below that the name barely contributes. */
export const covTone = (v: number) => (v >= 95 ? "pl-tone--ok" : v >= 80 ? "pl-tone--warn" : "pl-tone--bad");
/** V6 factor index labels ①②③…; falls back to plain numbers past ⑳. */
export const circled = (i: number) => (i < 20 ? String.fromCodePoint(0x2460 + i) : String(i + 1));
/** V6 AUM in K / M / B with up to three significant digits and no trailing zeros: 1M, 10M, 2.65B, 43.4M. */
export function fmtAum(v: number): string {
  const units: Array<[number, string]> = [[1e9, "B"], [1e6, "M"], [1e3, "K"]];
  for (const [u, suffix] of units) {
    if (Math.abs(v) >= u) return `${trimNum(v / u)}${suffix}`;
  }
  return trimNum(v);
}
export function trimNum(x: number): string {
  const s = Math.abs(x) >= 100 ? x.toFixed(0) : Math.abs(x) >= 10 ? x.toFixed(1) : x.toFixed(2);
  return s.includes(".") ? s.replace(/0+$/, "").replace(/\.$/, "") : s;
}
