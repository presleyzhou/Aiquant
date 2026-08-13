"""Marketplace catalog: strategies, AI skills, and data connectors.

Modeled after FinceptTerminal's connector/agent marketplace concept, but every
item here is wired to something that actually exists in this codebase:

- **strategy** items carry a `backtest` payload that is a valid body for
  `POST /api/analytics/backtest` — "install and run" really runs.
- **skill** items carry a `prompt_template` the AI panel injects into its
  suggestion list; `{symbol}` is substituted client-side.
- **data** items report a live `status` computed from the current process:
  which connector drives the site today, which vendored providers are
  importable, and which need an API key that is / isn't configured.

There is deliberately no fabricated social proof (install counts, star
ratings). A catalog this size curated by the site author should say so —
`author` and `tier` are editorial facts; fake popularity numbers are not.
"""

from __future__ import annotations

import importlib.util
from dataclasses import asdict, dataclass, field
from typing import Any, Literal

from app.config import get_settings

ItemType = Literal["strategy", "skill", "data"]


@dataclass(frozen=True)
class Item:
    id: str
    type: ItemType
    name: str
    tagline: str
    description: str
    author: str
    version: str
    tags: list[str] = field(default_factory=list)
    tier: str = "free"  # free | key_required | planned
    risk: str | None = None  # strategies only: low | medium | high
    integration: dict[str, Any] = field(default_factory=dict)
    # None = free. Priced items check out through /api/payments (crypto via
    # Coinbase Commerce when configured; labelled demo mode otherwise).
    price: dict[str, str] | None = None  # {"amount": "4.99", "currency": "USD"}


CATALOG: list[Item] = [
    # ------------------------------------------------------------- strategies
    Item(
        id="golden-cross",
        type="strategy",
        name="黄金交叉 50/200",
        tagline="最经典的长周期趋势跟随：SMA50 上穿 SMA200 做多",
        description=(
            "华尔街教科书级别的趋势策略。50 日均线上穿 200 日均线（黄金交叉）时全仓做多，"
            "下穿（死亡交叉）时平仓离场。信号极少、持仓周期以月计，适合作为长期趋势过滤器"
            "而非独立交易系统。回测窗口建议 5 年以上，否则可能一次信号都没有。"
        ),
        author="AIQUANT 内置",
        version="1.0",
        tags=["趋势跟随", "长周期", "低频"],
        risk="low",
        integration={
            "backtest": {"strategy": "sma_cross", "fast": 50, "slow": 200, "period": "5y"},
        },
    ),
    Item(
        id="swift-trend",
        type="strategy",
        name="快线趋势 EMA 12/26",
        tagline="MACD 同款参数的 EMA 交叉，反应更快、交易更频繁",
        description=(
            "用 MACD 的经典参数（12/26）做 EMA 交叉。指数均线对近期价格更敏感，"
            "入场比 SMA 交叉早、但假信号也更多——震荡市里会被反复止损。"
            "手续费和滑点已按双边计入，频繁交易的成本会真实反映在收益里。"
        ),
        author="AIQUANT 内置",
        version="1.0",
        tags=["趋势跟随", "中周期", "EMA"],
        risk="medium",
        integration={
            "backtest": {"strategy": "ema_cross", "fast": 12, "slow": 26, "period": "2y"},
        },
    ),
    Item(
        id="sma-pulse",
        type="strategy",
        name="双均线脉冲 20/50",
        tagline="20/50 日均线交叉，趋势与灵敏度的折中",
        description=(
            "介于黄金交叉和快线之间的折中参数：SMA20 上穿 SMA50 做多，下穿平仓。"
            "比 50/200 灵敏、比 12/26 稳健，是双均线族里最常被用作基准的一组参数。"
        ),
        author="AIQUANT 内置",
        version="1.0",
        tags=["趋势跟随", "中周期", "基准"],
        risk="medium",
        integration={
            "backtest": {"strategy": "sma_cross", "fast": 20, "slow": 50, "period": "2y"},
        },
    ),
    Item(
        id="connors-rsi2",
        type="strategy",
        name="Connors RSI(2) 超卖反弹",
        tagline="极短周期 RSI 均值回归：超卖抄底，回到中性即走",
        description=(
            "Larry Connors 推广的短线均值回归：RSI(2) 跌破 10 视为极端超卖入场，"
            "回升到 65 以上离场。持仓通常只有几天，胜率高但单笔盈利小，"
            "且在单边下跌趋势中接飞刀风险显著——务必与买入持有基准对比后再下结论。"
        ),
        author="AIQUANT 内置",
        version="1.0",
        tags=["均值回归", "短周期", "高胜率"],
        risk="high",
        integration={
            "backtest": {
                "strategy": "rsi_reversion",
                "period": "2y",
                "rsi_period": 2,
                "rsi_oversold": 10,
                "rsi_overbought": 65,
            },
        },
    ),
    Item(
        id="rsi-classic",
        type="strategy",
        name="RSI(14) 经典均值回归",
        tagline="教科书参数：RSI14 < 30 买入，> 70 卖出",
        description=(
            "Wilder 原版参数的 RSI 均值回归。30/70 阈值在强趋势股上触发极少，"
            "在震荡标的上表现更好。适合用来理解『指标参数与标的性格匹配』这件事。"
        ),
        author="AIQUANT 内置",
        version="1.0",
        tags=["均值回归", "经典", "低频"],
        risk="medium",
        integration={
            "backtest": {
                "strategy": "rsi_reversion",
                "period": "2y",
                "rsi_period": 14,
                "rsi_oversold": 30,
                "rsi_overbought": 70,
            },
        },
    ),
    Item(
        id="trend-sniper-pro",
        type="strategy",
        name="趋势狙击 Pro 10/40",
        tagline="更快的 EMA 组合 + 5 年长窗口验证，付费预设",
        description=(
            "EMA 10/40 的激进趋势组合：入场比 12/26 更早，配合 5 年回测窗口"
            "验证参数在完整牛熊周期中的表现。购买后与内置策略完全一样地运行——"
            "一键回测、含成本、对比买入持有基准。付费的是调参与验证工作，"
            "不是魔法：回测结果该难看时依然会难看。"
        ),
        author="AIQUANT Pro",
        version="1.0",
        tags=["趋势跟随", "Pro", "长窗口"],
        risk="medium",
        price={"amount": "4.99", "currency": "USD"},
        integration={
            "backtest": {"strategy": "ema_cross", "fast": 10, "slow": 40, "period": "5y"},
        },
    ),
    Item(
        id="deep-due-diligence",
        type="skill",
        name="机构级深度尽调",
        tagline="一次提问跑完行情、全套指标、双策略回测与相对强弱",
        description=(
            "把技术面速览、风险体检、策略对比和大盘相对强弱合并成一次完整尽调："
            "AI 会依次调取行情、RSI/MACD/布林带/ATR、双策略回测与 SPY 对比，"
            "最后输出一份结构化的多空论点清单。工具调用次数多、耗时较长，"
            "适合认真研究一只标的时使用。"
        ),
        author="AIQUANT Pro",
        version="1.0",
        tags=["AI 技能", "Pro", "深度研究"],
        price={"amount": "2.99", "currency": "USD"},
        integration={
            "prompt_template": (
                "对 {symbol} 做一次机构级深度尽调，按以下顺序使用工具并汇总："
                "1) 当前行情与近 1 年走势；2) RSI(14)、MACD、布林带、ATR(14) 全套指标；"
                "3) 分别回测 sma_cross(20/50) 与 rsi_reversion（2 年），对比买入持有；"
                "4) 与 SPY 的 6 个月相对强弱。最后给出：多头论点、空头论点、"
                "关键价位、以及这只标的更适合的交易风格——全部基于工具返回的真实数据。"
            ),
        },
    ),
    Item(
        id="buy-hold",
        type="strategy",
        name="买入持有基准",
        tagline="所有策略都要先赢过它",
        description=(
            "第一根 bar 开盘买入、持有到最后，同样计手续费和滑点。"
            "任何主动策略的回测报告里，它都是那条必须跨过的线——"
            "长期看大多数择时策略跨不过去，这正是它存在的意义。"
        ),
        author="AIQUANT 内置",
        version="1.0",
        tags=["基准", "被动"],
        risk="low",
        integration={"backtest": {"strategy": "buy_and_hold", "period": "5y"}},
    ),
    # ----------------------------------------------------------------- skills
    Item(
        id="tech-snapshot",
        type="skill",
        name="技术面速览",
        tagline="一句话让 AI 拉全套指标，给出趋势判断与关键位",
        description=(
            "安装后出现在 AI 面板的快捷提问里。AI 会实际调用行情与指标工具："
            "当前价、RSI(14)、MACD、SMA20/50 与布林带位置，然后基于真实数值"
            "给出趋势方向、支撑压力位和需要留意的背离。"
        ),
        author="AIQUANT 内置",
        version="1.0",
        tags=["AI 技能", "技术分析"],
        integration={
            "prompt_template": (
                "对 {symbol} 做一次技术面速览：取当前行情，计算 RSI(14)、MACD、"
                "SMA20 与 SMA50、布林带，然后基于这些真实数值给出趋势判断、"
                "关键支撑/压力位，以及当前最值得注意的信号或背离。"
            ),
        },
    ),
    Item(
        id="risk-audit",
        type="skill",
        name="风险体检",
        tagline="波动率、最大回撤、当前位置——先看风险再谈收益",
        description=(
            "让 AI 从风险侧审视一个标的：ATR 衡量日内波动、买入持有回测取历史最大回撤、"
            "布林带定位当前价格处于常态区间的哪个位置。适合在建仓前跑一遍。"
        ),
        author="AIQUANT 内置",
        version="1.0",
        tags=["AI 技能", "风险管理"],
        integration={
            "prompt_template": (
                "对 {symbol} 做一次风险体检：计算 ATR(14) 评估波动水平，"
                "用 buy_and_hold 策略回测 2 年取历史最大回撤和年化波动率，"
                "再看当前价格在布林带中的位置。综合这些真实数据评估现在的风险状况。"
            ),
        },
    ),
    Item(
        id="strategy-lab",
        type="skill",
        name="策略对比实验",
        tagline="趋势 vs 均值回归，让数据说话哪个更适合这只标的",
        description=(
            "AI 会对同一标的分别回测 SMA 交叉与 RSI 均值回归，对比夏普、最大回撤、"
            "胜率与买入持有基准，然后解释为什么这只标的的『性格』更适合某种风格——"
            "而不是泛泛而谈。"
        ),
        author="AIQUANT 内置",
        version="1.0",
        tags=["AI 技能", "回测", "研究"],
        integration={
            "prompt_template": (
                "对 {symbol} 做策略风格对比：分别用 sma_cross（20/50）和 "
                "rsi_reversion 回测 2 年，对比总收益、夏普、最大回撤、胜率，"
                "并与买入持有基准比较。基于结果分析这只标的更适合趋势跟随还是均值回归，"
                "并说明数据依据。"
            ),
        },
    ),
    Item(
        id="relative-strength",
        type="skill",
        name="相对强弱对比",
        tagline="和 SPY 比一比，跑赢大盘还是只是水涨船高",
        description=(
            "把标的与 SPY 的同期走势放在一起：谁更强、强多少、什么时候开始分化。"
            "很多『好看』的个股走势只是贝塔——这个技能帮你分辨阿尔法和水位。"
        ),
        author="AIQUANT 内置",
        version="1.0",
        tags=["AI 技能", "相对强弱"],
        integration={
            "prompt_template": (
                "对比 {symbol} 与 SPY：分别取 6 个月价格历史，计算同期涨跌幅，"
                "分析 {symbol} 相对大盘是超额收益还是同步波动，"
                "并指出两者走势开始分化的时间点和可能含义。"
            ),
        },
    ),
    # ------------------------------------------------------------------- data
    Item(
        id="yfinance",
        type="data",
        name="Yahoo Finance",
        tagline="当前站点行情、K 线与回测数据的默认来源",
        description=(
            "免费、无需 API key，覆盖全球股票、ETF、外汇与加密货币。"
            "数据有 15 分钟左右延迟，非交易时段返回上一交易日收盘。"
            "当前站点的报价、K 线、指标与回测全部由它驱动。"
        ),
        author="yfinance",
        version="—",
        tags=["行情", "免费", "默认"],
        integration={"connector": "yfinance"},
    ),
    Item(
        id="alpha-vantage",
        type="data",
        name="Alpha Vantage",
        tagline="已内嵌完整 provider（2500+ 行），配 key 即可启用",
        description=(
            "来自 fincept-terminal 的完整 Alpha Vantage 异步封装已内嵌在后端"
            "（fincept_terminal/DatabaseConnector/.../alpha_vantage_provider.py）。"
            "在 .env 设置 ALPHA_VANTAGE_KEY 后即可作为备用行情源接入。"
            "免费档每天 25 次请求。"
        ),
        author="fincept-terminal (MIT)",
        version="2.0.8",
        tags=["行情", "基本面", "需要 key"],
        tier="key_required",
        integration={"connector": "alpha_vantage", "env_key": "ALPHA_VANTAGE_KEY"},
    ),
    Item(
        id="imf-data",
        type="data",
        name="IMF 宏观数据",
        tagline="国际货币基金组织宏观经济数据，provider 已内嵌",
        description=(
            "IMF 的国际收支、汇率、GDP 等宏观序列。异步 provider 已随 fincept-terminal "
            "数据层内嵌并可导入，无需 API key。尚未接入前端 UI——欢迎作为下一步扩展。"
        ),
        author="fincept-terminal (MIT)",
        version="2.0.8",
        tags=["宏观", "免费"],
        integration={"connector": "imf"},
    ),
    Item(
        id="oecd-data",
        type="data",
        name="OECD 经济指标",
        tagline="经合组织成员国经济指标，provider 已内嵌",
        description=(
            "OECD 的通胀、利率、就业等指标序列。异步 provider 已内嵌并可导入，"
            "无需 API key。尚未接入前端 UI。"
        ),
        author="fincept-terminal (MIT)",
        version="2.0.8",
        tags=["宏观", "免费"],
        integration={"connector": "oecd"},
    ),
    Item(
        id="fincept-premium",
        type="data",
        name="Fincept Premium API",
        tagline="上游商业数据服务，本站未接入",
        description=(
            "fincept-terminal 上游的付费数据服务（实时外汇/加密/新闻）。"
            "本站未接入，列在这里仅作为数据层可扩展方向的说明。"
        ),
        author="Fincept Corporation",
        version="—",
        tags=["行情", "商业"],
        tier="planned",
        integration={"connector": "fincept_api"},
    ),
]

_BY_ID = {item.id: item for item in CATALOG}


def _module_available(dotted: str) -> bool:
    try:
        return importlib.util.find_spec(dotted) is not None
    except (ImportError, ModuleNotFoundError, ValueError):
        return False


def connector_status(connector: str) -> dict[str, str]:
    """Live status for a data connector, computed from the running process."""
    settings = get_settings()

    if connector == "yfinance":
        return {"state": "active", "label": "使用中 · 驱动当前站点行情"}

    if connector == "alpha_vantage":
        vendored = _module_available(
            "fincept_terminal.DatabaseConnector.DataSources.alpha_vantage_data.alpha_vantage_provider"
        )
        if not vendored:
            return {"state": "unavailable", "label": "provider 缺失"}
        if settings.alpha_vantage_key:
            return {"state": "ready", "label": "key 已配置 · 可接入"}
        return {"state": "key_required", "label": "需要 ALPHA_VANTAGE_KEY"}

    if connector in {"imf", "oecd"}:
        dotted = (
            "fincept_terminal.DatabaseConnector.DataSources.imf_data.imf_provider"
            if connector == "imf"
            else "fincept_terminal.DatabaseConnector.DataSources.oced_data.oced_provider"
        )
        if _module_available(dotted):
            return {"state": "available", "label": "已内嵌 · 未接入 UI"}
        return {"state": "unavailable", "label": "provider 缺失"}

    if connector == "fincept_api":
        return {"state": "planned", "label": "未接入"}

    return {"state": "unknown", "label": "未知"}


def list_items(item_type: str | None = None, query: str | None = None) -> list[dict]:
    items = CATALOG
    if item_type:
        items = [i for i in items if i.type == item_type]
    if query:
        q = query.strip().lower()
        items = [
            i
            for i in items
            if q in i.name.lower()
            or q in i.tagline.lower()
            or q in i.description.lower()
            or any(q in t.lower() for t in i.tags)
        ]
    return [_serialize(i) for i in items]


def get_item(item_id: str) -> dict | None:
    item = _BY_ID.get(item_id)
    return _serialize(item) if item else None


def _serialize(item: Item) -> dict:
    data = asdict(item)
    if item.type == "data":
        data["status"] = connector_status(item.integration.get("connector", ""))
    return data
