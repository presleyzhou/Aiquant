"""Symbol search: local CN/US name dictionary + Yahoo remote lookup.

Yahoo's search endpoint cannot match Chinese company names at all (verified:
「茅台」/「宁德时代」return zero results even with zh-CN params), while numeric
A-share codes and English names work fine. So fuzzy Chinese search is served
from a curated local dictionary — name substring, pinyin initials (gzmt →
贵州茅台) and code prefix all match instantly — and Yahoo covers everything
the dictionary doesn't (full US/HK/crypto universe, misspellings, ISINs).
"""

from __future__ import annotations

import re
from functools import lru_cache

# (symbol, 中文名, pinyin initials) — the liquid names a Chinese-speaking user
# will actually type. Not a listing feed; extend freely.
CN_STOCKS: list[tuple[str, str, str]] = [
    # 指数
    ("000001.SS", "上证指数", "szzs"),
    ("399001.SZ", "深证成指", "szcz"),
    ("399006.SZ", "创业板指", "cybz"),
    ("000300.SS", "沪深300", "hs300"),
    # 白酒食品
    ("600519.SS", "贵州茅台", "gzmt"),
    ("000858.SZ", "五粮液", "wly"),
    ("000568.SZ", "泸州老窖", "lzlj"),
    ("600809.SS", "山西汾酒", "sxfj"),
    ("002304.SZ", "洋河股份", "yhgf"),
    ("600887.SS", "伊利股份", "ylgf"),
    ("603288.SS", "海天味业", "htwy"),
    ("002714.SZ", "牧原股份", "mygf"),
    # 新能源/汽车
    ("300750.SZ", "宁德时代", "ndsd"),
    ("002594.SZ", "比亚迪", "byd"),
    ("601012.SS", "隆基绿能", "ljln"),
    ("600438.SS", "通威股份", "twgf"),
    ("300274.SZ", "阳光电源", "ygdy"),
    ("601633.SS", "长城汽车", "ccqc"),
    ("600104.SS", "上汽集团", "sqjt"),
    ("601127.SS", "赛力斯", "sls"),
    ("002050.SZ", "三花智控", "shzk"),
    # 科技电子
    ("688981.SS", "中芯国际", "zxgj"),
    ("002415.SZ", "海康威视", "hkws"),
    ("002475.SZ", "立讯精密", "lxjm"),
    ("000725.SZ", "京东方A", "jdf"),
    ("603501.SS", "韦尔股份", "wegf"),
    ("603986.SS", "兆易创新", "zycx"),
    ("300124.SZ", "汇川技术", "hcjs"),
    ("002230.SZ", "科大讯飞", "kdxf"),
    ("601138.SS", "工业富联", "gyfl"),
    ("000063.SZ", "中兴通讯", "zxtx"),
    ("600570.SS", "恒生电子", "hsdz"),
    ("600588.SS", "用友网络", "yywl"),
    # 医药
    ("603259.SS", "药明康德", "ymkd"),
    ("600276.SS", "恒瑞医药", "hryy"),
    ("300760.SZ", "迈瑞医疗", "mryl"),
    ("600436.SS", "片仔癀", "pzh"),
    ("300015.SZ", "爱尔眼科", "aeyk"),
    ("300122.SZ", "智飞生物", "zfsw"),
    # 金融
    ("601318.SS", "中国平安", "zgpa"),
    ("600036.SS", "招商银行", "zsyh"),
    ("601398.SS", "工商银行", "gsyh"),
    ("601939.SS", "建设银行", "jsyh"),
    ("601988.SS", "中国银行", "zgyh"),
    ("601288.SS", "农业银行", "nyyh"),
    ("601166.SS", "兴业银行", "xyyh"),
    ("000001.SZ", "平安银行", "payh"),
    ("600030.SS", "中信证券", "zxzq"),
    ("300059.SZ", "东方财富", "dfcf"),
    ("601628.SS", "中国人寿", "zgrs"),
    ("601601.SS", "中国太保", "zgtb"),
    # 能源材料
    ("601899.SS", "紫金矿业", "zjky"),
    ("601088.SS", "中国神华", "zgsh"),
    ("601225.SS", "陕西煤业", "sxmy"),
    ("600309.SS", "万华化学", "whhx"),
    ("600111.SS", "北方稀土", "bfxt"),
    ("601857.SS", "中国石油", "zgsy"),
    ("600028.SS", "中国石化", "zgshh"),
    ("600900.SS", "长江电力", "cjdl"),
    ("600406.SS", "国电南瑞", "gdnr"),
    # 消费家电
    ("000333.SZ", "美的集团", "mdjt"),
    ("000651.SZ", "格力电器", "gldq"),
    ("600690.SS", "海尔智家", "hezj"),
    ("601888.SS", "中国中免", "zgzm"),
    # 基建交运军工
    ("601668.SS", "中国建筑", "zgjz"),
    ("000002.SZ", "万科A", "wka"),
    ("600048.SS", "保利发展", "blfz"),
    ("601919.SS", "中远海控", "zyhk"),
    ("601816.SS", "京沪高铁", "jhgt"),
    ("600031.SS", "三一重工", "syzg"),
    ("002352.SZ", "顺丰控股", "sfkg"),
    ("600760.SS", "中航沈飞", "zhsf"),
    ("600893.SS", "航发动力", "hfdl"),
]

# US / crypto names a Chinese speaker types in Chinese.
US_ALIASES: list[tuple[str, str, str]] = [
    ("AAPL", "苹果", "pg"),
    ("MSFT", "微软", "wr"),
    ("NVDA", "英伟达", "ywd"),
    ("TSLA", "特斯拉", "tsl"),
    ("GOOG", "谷歌", "gg"),
    ("AMZN", "亚马逊", "ymx"),
    ("META", "Meta", "meta"),
    ("NFLX", "奈飞", "nf"),
    ("AMD", "超威半导体", "amd"),
    ("INTC", "英特尔", "yte"),
    ("TSM", "台积电", "tjd"),
    ("BABA", "阿里巴巴", "albb"),
    ("JD", "京东", "jd"),
    ("PDD", "拼多多", "pdd"),
    ("BIDU", "百度", "bd"),
    ("NIO", "蔚来", "wl"),
    ("XPEV", "小鹏汽车", "xpqc"),
    ("LI", "理想汽车", "lxqc"),
    ("SPY", "标普500 ETF", "bp500"),
    ("QQQ", "纳指100 ETF", "nz100"),
    ("BTC-USD", "比特币", "btb"),
    ("ETH-USD", "以太坊", "ytf"),
]

_CJK = re.compile(r"[一-鿿]")


def _exchange(symbol: str) -> str:
    if symbol.endswith(".SS"):
        return "上交所"
    if symbol.endswith(".SZ"):
        return "深交所"
    if symbol.endswith("-USD"):
        return "Crypto"
    return "US"


def search_local(query: str, limit: int = 8) -> list[dict]:
    """Instant matches from the curated dictionary.

    Matching, in priority order: exact symbol/code → code/symbol prefix →
    Chinese-name substring → pinyin-initials prefix.
    """
    q = query.strip()
    if not q:
        return []
    q_upper = q.upper()
    q_lower = q.lower()

    scored: list[tuple[int, dict]] = []
    for symbol, name, abbr in [*CN_STOCKS, *US_ALIASES]:
        code = symbol.split(".")[0]
        score = None
        if q_upper == symbol or q_upper == code:
            score = 0
        elif symbol.startswith(q_upper) or code.startswith(q_upper):
            score = 1
        elif q in name:
            score = 2 if name.startswith(q) else 3
        elif abbr.startswith(q_lower):
            score = 4
        if score is not None:
            scored.append(
                (score, {"symbol": symbol, "name": name, "exchange": _exchange(symbol), "source": "local"})
            )

    scored.sort(key=lambda pair: pair[0])
    return [item for _, item in scored[:limit]]


def has_cjk(text: str) -> bool:
    return bool(_CJK.search(text))


def normalize_yahoo_quotes(quotes: list[dict], limit: int = 8) -> list[dict]:
    """Flatten Yahoo search results to our shape, dropping junk types."""
    keep_types = {"EQUITY", "ETF", "INDEX", "CRYPTOCURRENCY", "MUTUALFUND", "CURRENCY"}
    out = []
    for quote in quotes:
        if quote.get("quoteType") not in keep_types:
            continue
        symbol = quote.get("symbol")
        name = quote.get("shortname") or quote.get("longname") or ""
        if not symbol:
            continue
        out.append(
            {
                "symbol": symbol,
                "name": name,
                "exchange": quote.get("exchDisp") or quote.get("exchange") or "",
                "source": "yahoo",
            }
        )
        if len(out) >= limit:
            break
    return out


@lru_cache(maxsize=256)
def _remote_search_blocking(query: str, limit: int) -> tuple[dict, ...]:
    """Yahoo lookup — cached per process; callers tolerate total failure."""
    import yfinance as yf

    result = yf.Search(query, max_results=limit, news_count=0)
    return tuple(normalize_yahoo_quotes(result.quotes, limit))


def search_remote(query: str, limit: int = 8) -> list[dict]:
    # Yahoo returns nothing for CJK queries — don't pay the round trip.
    if has_cjk(query):
        return []
    try:
        return list(_remote_search_blocking(query.strip(), limit))
    except Exception:
        return []


def merge_results(local: list[dict], remote: list[dict], limit: int = 8) -> list[dict]:
    seen: set[str] = set()
    merged: list[dict] = []
    for item in [*local, *remote]:
        if item["symbol"] in seen:
            continue
        seen.add(item["symbol"])
        merged.append(item)
        if len(merged) >= limit:
            break
    return merged
