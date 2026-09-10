import type { MsgKey } from "../i18n";

/** i18n key for a research market id ("us" | "crypto" | "crypto_1h"). */
export function marketKey(market: string): MsgKey {
  if (market === "crypto_1h") return "fl.market.crypto_1h";
  if (market === "crypto") return "fl.market.crypto";
  return "fl.market.us";
}

export const isHourly = (market: string) => market.endsWith("_1h");
