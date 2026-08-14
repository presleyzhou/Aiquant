/** Market profiles: the US terminal and the A-share terminal share every
 * component; only the defaults, storage keys, and colour convention differ.
 *
 * Colour convention matters: mainland China charts draw gains in red and
 * losses in green — the exact opposite of US convention. Each workspace sets
 * `--rise`/`--fall` CSS variables so the same `.up`/`.dn` classes (and the
 * candle palette) render correctly inside either tab.
 */

export type MarketId = "us" | "cn";

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
  cn: {
    id: "cn",
    label: "A股",
    storageKey: "aiquant.watchlist.cn",
    defaults: [
      "000001.SS",
      "600519.SS",
      "300750.SZ",
      "002594.SZ",
      "601318.SS",
      "000858.SZ",
      "600036.SS",
    ],
    names: {
      "000001.SS": "上证指数",
      "399001.SZ": "深证成指",
      "600519.SS": "贵州茅台",
      "300750.SZ": "宁德时代",
      "002594.SZ": "比亚迪",
      "601318.SS": "中国平安",
      "000858.SZ": "五粮液",
      "600036.SS": "招商银行",
      "601899.SS": "紫金矿业",
      "600900.SS": "长江电力",
      "000333.SZ": "美的集团",
      "002415.SZ": "海康威视",
      "600030.SS": "中信证券",
      "601888.SS": "中国中免",
      "603259.SS": "药明康德",
    },
    upIsRed: true,
    placeholder: "代码，如 600519.SS",
    hint: "沪市 .SS / 深市 .SZ，数据来自 Yahoo（延时约 15 分钟）",
  },
};

/** CSS custom properties implementing the market's colour convention. */
export function marketColorVars(profile: MarketProfile): Record<string, string> {
  return profile.upIsRed
    ? { "--rise": "var(--red)", "--fall": "var(--green)" }
    : { "--rise": "var(--green)", "--fall": "var(--red)" };
}

// Module-level constants, not fresh objects per call: the palette is a prop of
// a memoized ChartPanel, so its identity must be stable across renders.
const RED_UP_PALETTE = {
  up: "#ff4d4d",
  down: "#33d17a",
  upVol: "rgba(255,77,77,0.28)",
  downVol: "rgba(51,209,122,0.28)",
} as const;
const GREEN_UP_PALETTE = {
  up: "#33d17a",
  down: "#ff4d4d",
  upVol: "rgba(51,209,122,0.28)",
  downVol: "rgba(255,77,77,0.28)",
} as const;

/** Candle/volume palette for lightweight-charts, matching the convention. */
export function candlePalette(profile: MarketProfile) {
  return profile.upIsRed ? RED_UP_PALETTE : GREEN_UP_PALETTE;
}

export function displayName(profile: MarketProfile, symbol: string): string | undefined {
  return profile.names[symbol];
}
