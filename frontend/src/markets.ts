/** Market profiles: the US terminal and the crypto terminal share every
 * component; only the defaults, storage keys, and colour convention differ.
 * `upIsRed` survives for any future market with the mainland-China红涨绿跌
 * convention; both current workspaces use green-up.
 */

export type MarketId = "us" | "crypto";

export interface MarketProfile {
  id: MarketId;
  label: string;
  storageKey: string;
  defaults: string[];
  /** Display names for well-known symbols (A-share codes are opaque). */
  names: Record<string, string>;
  /** true = 红涨绿跌 (Chinese convention). */
  upIsRed: boolean;
  placeholder: string;
  hint: string;
}

export const MARKETS: Record<MarketId, MarketProfile> = {
  us: {
    id: "us",
    label: "美股",
    storageKey: "aiquant.watchlist",
    defaults: ["AAPL", "MSFT", "NVDA", "SPY", "TSLA", "BTC-USD"],
    names: {
      AAPL: "苹果",
      MSFT: "微软",
      NVDA: "英伟达",
      SPY: "标普500 ETF",
      TSLA: "特斯拉",
      "BTC-USD": "比特币",
      QQQ: "纳指100 ETF",
      GOOG: "谷歌",
      AMZN: "亚马逊",
      META: "Meta",
    },
    upIsRed: false,
    placeholder: "代码，如 TSLA",
    hint: "",
  },
  crypto: {
    id: "crypto",
    label: "数字货币",
    storageKey: "aiquant.watchlist.crypto",
    defaults: [
      "BTC-USD",
      "ETH-USD",
      "SOL-USD",
      "BNB-USD",
      "XRP-USD",
      "DOGE-USD",
      "ADA-USD",
    ],
    names: {
      "BTC-USD": "比特币",
      "ETH-USD": "以太坊",
      "SOL-USD": "索拉纳",
      "BNB-USD": "币安币",
      "XRP-USD": "瑞波币",
      "DOGE-USD": "狗狗币",
      "ADA-USD": "艾达币",
      "AVAX-USD": "雪崩",
      "DOT-USD": "波卡",
      "LTC-USD": "莱特币",
      "LINK-USD": "Chainlink",
      "TRX-USD": "波场",
      "SHIB-USD": "柴犬币",
      "TON-USD": "Toncoin",
      "NEAR-USD": "NEAR",
    },
    upIsRed: false,
    placeholder: "代码，如 ETH-USD",
    hint: "Yahoo 行情，7×24 小时交易，波动远大于股票",
  },
};

/** CSS custom properties implementing the market's colour convention. */
export function marketColorVars(profile: MarketProfile): Record<string, string> {
  return profile.upIsRed
    ? { "--rise": "var(--red)", "--fall": "var(--green)" }
    : { "--rise": "var(--green)", "--fall": "var(--red)" };
}

/** Candle/volume palette for lightweight-charts, matching the convention. */
export function candlePalette(profile: MarketProfile) {
  return profile.upIsRed
    ? { up: "#ff4d4d", down: "#33d17a", upVol: "rgba(255,77,77,0.28)", downVol: "rgba(51,209,122,0.28)" }
    : { up: "#33d17a", down: "#ff4d4d", upVol: "rgba(51,209,122,0.28)", downVol: "rgba(255,77,77,0.28)" };
}

export function displayName(profile: MarketProfile, symbol: string): string | undefined {
  return profile.names[symbol];
}
