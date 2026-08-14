import json
import logging

from fastapi import APIRouter
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


@router.post("/strategy")
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


@router.post("/analyze")
async def analyze(req: AnalyzeRequest):
    """Stream analysis as newline-delimited JSON events.

    Event types: `thinking`, `text`, `tool_use`, `tool_result`, `refusal`,
    `error`, `done`. NDJSON rather than SSE so the browser can read it with a
    plain `fetch` + `ReadableStream` and no EventSource reconnect semantics.
    """
    convo = [{"role": m.role, "content": m.content} for m in req.messages]

    async def generate():
        try:
            async for event in analyst.stream(convo):
                yield json.dumps(event, default=str) + "\n"
        except Exception as exc:
            log.exception("analysis stream failed")
            yield json.dumps({"type": "error", "message": str(exc)}) + "\n"

    return StreamingResponse(
        generate(),
        media_type="application/x-ndjson",
        headers={"Cache-Control": "no-cache", "X-Accel-Buffering": "no"},
    )
