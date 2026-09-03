import asyncio
import json
import logging

from fastapi import APIRouter, Depends, HTTPException, Request

from app.services.ratelimit import limiter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services.llm import STRATEGY_SYSTEM_PROMPT, STRATEGY_TOOLS, analyst

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/ai", tags=["ai"])


class Message(BaseModel):
    role: str = Field(..., pattern="^(user|assistant)$")
    content: str


class AnalyzeRequest(BaseModel):
    messages: list[Message] = Field(..., min_length=1, max_length=40)


@router.get("/status")
async def status():
    from app.config import get_settings

    settings = get_settings()
    return {
        "enabled": analyst.enabled,
        "model": settings.claude_model if analyst.enabled else None,
        "effort": settings.claude_effort if analyst.enabled else None,
        "light_model": settings.claude_model_light if analyst.enabled else None,
        "usage_today": __import__("app.services.usage", fromlist=["today"]).today(),
        "limits": {
            "chat_per_hour": settings.rl_chat_per_hour,
            "strategy_per_day": settings.rl_strategy_per_day,
            "mining_per_day": settings.rl_mining_per_day,
            "evolve_per_day": settings.rl_evolve_per_day,
        },
    }


OBJECTIVE_LABELS = {
    "auto": "自动判断——先分析标的性格，再选择最匹配的策略风格",
    "trend": "稳健趋势跟随——宁少交易，不追噪音",
    "momentum": "激进动量——接受更高换手与回撤，追求进攻性",
    "reversion": "高胜率均值回归——短持仓、小盈利、控制接飞刀风险",
    "low_drawdown": "低回撤优先——最大回撤是第一约束，收益其次",
}


class StrategyRequest(BaseModel):
    symbol: str = Field(..., min_length=1, max_length=20)
    objective: str = Field("auto", pattern="^(auto|trend|momentum|reversion|low_drawdown)$")
    validation_period: str = Field("5y", pattern="^(2y|5y|max)$")
    notes: str = Field("", max_length=500)


def build_strategy_prompt(req: StrategyRequest) -> str:
    lines = [
        f"为 {req.symbol.upper().strip()} 设计一个策略。",
        f"目标风格：{OBJECTIVE_LABELS[req.objective]}。",
        f"样本内搜索窗口用 2y，样本外验证窗口用 {req.validation_period}。",
    ]
    if req.notes.strip():
        lines.append(f"补充要求：{req.notes.strip()}")
    return "\n".join(lines)


@router.post(
    "/strategy",
    dependencies=[Depends(limiter("strategy", "rl_strategy_per_day", 86_400, global_attr="rl_global_ai_per_day"))],
)
async def generate_strategy(req: StrategyRequest):
    """Stream a strategy-design session as NDJSON.

    Same event vocabulary as /analyze; the final proposal is delivered as the
    `propose_strategy` tool_use event (its input IS the structured proposal —
    parameter-validated server-side before it is accepted).
    """
    convo = [{"role": "user", "content": build_strategy_prompt(req)}]

    async def generate():
        try:
            async for event in analyst.stream(
                convo,
                system=STRATEGY_SYSTEM_PROMPT,
                tools=STRATEGY_TOOLS,
                max_iterations=12,
            ):
                yield json.dumps(event, default=str) + "\n"
        except Exception as exc:
            log.exception("strategy stream failed")
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


@router.post(
    "/analyze",
    dependencies=[Depends(limiter("chat", "rl_chat_per_hour", 3_600, global_attr="rl_global_ai_per_day"))],
)
async def analyze(req: AnalyzeRequest):
    """Stream analysis as newline-delimited JSON events.

    Event types: `thinking`, `text`, `tool_use`, `tool_result`, `refusal`,
    `error`, `done`. NDJSON rather than SSE so the browser can read it with a
    plain `fetch` + `ReadableStream` and no EventSource reconnect semantics.
    """
    convo = [{"role": m.role, "content": m.content} for m in req.messages]

    async def generate():
        try:
            from app.config import get_settings

            async for event in analyst.stream(
                convo, max_tokens=get_settings().claude_chat_max_tokens
            ):
                yield json.dumps(event, default=str) + "\n"
        except Exception as exc:
            log.exception("analysis stream failed")
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )


class NewsSummaryRequest(BaseModel):
    symbol: str = Field(min_length=1, max_length=20)


NEWS_SUMMARY_TOOL = {
    "name": "submit_sentiment",
    "description": "Deliver the news sentiment read. The only output channel.",
    "input_schema": {
        "type": "object",
        "properties": {
            "stance": {"type": "string", "enum": ["bullish", "bearish", "neutral", "mixed"]},
            "summary": {
                "type": "string",
                "description": "恰好三句中文：市场在关注什么、多空双方论点、对短期情绪的净判断。",
            },
        },
        "required": ["stance", "summary"],
    },
}


@router.post("/news-summary")
async def news_summary(req: NewsSummaryRequest, request: Request):
    """Three-sentence Claude sentiment read over the symbol's headlines.

    Token-spending endpoint, so it is the platform's first rate-limited one:
    cache first (free), then 10/day per IP and 200/day per instance globally.
    """
    from app.config import get_settings
    from app.services import disk_cache, ratelimit
    from app.services.symbol_news import fetch_symbol_news

    if not analyst.enabled:
        raise HTTPException(status_code=503, detail="AI is not configured")

    symbol = req.symbol.upper().strip()
    cache_key = f"newssum-{symbol}"
    cached = disk_cache.load(cache_key, ttl_seconds=1800)
    if isinstance(cached, dict):
        return {**cached, "cached": True}

    ip = (request.client.host if request.client else "unknown") or "unknown"
    if not ratelimit.allow(f"newssum:{ip}", limit=10, window_seconds=86_400):
        raise HTTPException(status_code=429, detail="news-summary limit reached for today (10/day)")
    if not ratelimit.allow("newssum:GLOBAL", limit=200, window_seconds=86_400):
        raise HTTPException(status_code=429, detail="site-wide news-summary budget exhausted for today")

    articles = await asyncio.to_thread(fetch_symbol_news, symbol, 10)
    if not articles:
        raise HTTPException(status_code=404, detail=f"no recent news found for {symbol}")

    headlines = "\n".join(f"- {a['title']} ({a['publisher']})" for a in articles)
    settings = get_settings()
    response = await analyst.client.messages.create(
        model=settings.claude_model_light,
        max_tokens=500,
        system=(
            "你是量化终端的新闻情绪分析器。只依据给出的标题判断，不得虚构标题之外的事实；"
            "标题信息不足时 stance 用 neutral 并如实说明。通过 submit_sentiment 工具输出。"
        ),
        messages=[{"role": "user", "content": f"标的 {symbol} 最近的新闻标题：\n{headlines}"}],
        tools=[NEWS_SUMMARY_TOOL],
        tool_choice={"type": "tool", "name": "submit_sentiment"},
    )
    from app.services import usage as usage_meter

    usage_meter.record(
        settings.claude_model_light,
        getattr(response.usage, "input_tokens", 0),
        getattr(response.usage, "output_tokens", 0),
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_sentiment":
            result = {
                "symbol": symbol,
                "stance": str(block.input.get("stance", "neutral")),
                "summary": str(block.input.get("summary", ""))[:600],
                "article_count": len(articles),
            }
            disk_cache.store(cache_key, result)
            return {**result, "cached": False}
    raise HTTPException(status_code=502, detail="model did not return a sentiment")
