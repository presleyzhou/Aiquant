import json
import logging

from fastapi import APIRouter
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from app.services.llm import analyst

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
