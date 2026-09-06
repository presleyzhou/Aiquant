"""End-to-end quant pipeline: signal → portfolio construction → backtest →
risk/attribution → target weights. Deterministic, no LLM, no rate limit."""

from __future__ import annotations

import asyncio
import json
import logging
import math

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.services import factor_dsl
from app.services.pipeline import config as pipeline_config
from app.services.pipeline import orders_blocking, run_pipeline_blocking
from app.services.ratelimit import limiter

log = logging.getLogger("aiquant.pipeline")

router = APIRouter(prefix="/api/pipeline", tags=["pipeline"])


class PipelineFactor(BaseModel):
    expression: str = Field(min_length=1, max_length=240)
    invert: bool = False
    horizon: int = Field(10, ge=1, le=30)


class PipelineRequest(BaseModel):
    market: str = Field("us", pattern="^(us|crypto)$")
    symbols: list[str] = Field(default_factory=list, max_length=40, description="custom universe (8–40 tickers); empty = built-in")
    history: str = Field("3y", pattern="^(3y|5y)$")
    factors: list[PipelineFactor] = Field(min_length=1, max_length=8)
    signal_weighting: str = Field("ic_expanding", pattern="^(ic_expanding|ic|equal)$")
    scheme: str = Field("inverse_vol", pattern="^(equal|score|inverse_vol|min_variance|risk_parity|hrp|mean_variance)$")
    top_n: int = Field(8, ge=2, le=20)
    rebalance: int = Field(10, ge=1, le=30)
    max_weight: float = Field(0.25, ge=0.05, le=1.0, allow_inf_nan=False)
    cost_bps: float = Field(7.0, ge=0, le=50, allow_inf_nan=False)
    target_vol_pct: float | None = Field(None, ge=0, le=40, allow_inf_nan=False, description="annualised %; null or 0 = off")
    vol_lookback: int = Field(60, ge=20, le=120)
    hold_buffer: int = Field(4, ge=0, le=20, description="a held name stays while ranked within top_n + buffer")
    trade_rate: float = Field(1.0, ge=0.1, le=1.0, allow_inf_nan=False, description="fraction of the distance to the target traded per rebalance")
    shrink_to_equal: float = Field(0.0, ge=0.0, le=1.0, allow_inf_nan=False, description="blend optimised weights toward 1/N (DeMiguel et al. 2009)")
    prior_trials: int = Field(0, ge=0, le=10_000, description="configurations already tried by this user; inflates the DSR's N")
    compare: bool = True


@router.get("/config")
async def get_config() -> dict:
    return pipeline_config()


@router.post("/run", dependencies=[Depends(limiter("pipeline", "rl_pipeline_per_hour", 3600))])
async def run(req: PipelineRequest) -> dict:
    try:
        return await asyncio.to_thread(run_pipeline_blocking, req.model_dump())
    except factor_dsl.FactorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


class OrdersRequest(BaseModel):
    spec: PipelineRequest
    nav: float = Field(gt=0, le=1e12, allow_inf_nan=False, description="portfolio value incl. cash, account currency")
    current: dict[str, float] = Field(default_factory=dict, description="{symbol: shares} currently held")
    min_trade_pct: float = Field(0.25, ge=0, le=5, allow_inf_nan=False, description="suppress trades below this % of NAV")


@router.post("/orders", dependencies=[Depends(limiter("pipeline", "rl_pipeline_per_hour", 3600))])
async def orders(req: OrdersRequest) -> dict:
    """Rebalance ticket from the current book to the latest target weights."""
    if len(req.current) > 200:
        raise HTTPException(status_code=400, detail="at most 200 current positions")
    for sym, q in req.current.items():
        if len(sym) > 32 or math.isnan(q) or not (0 <= q <= 1e12):
            raise HTTPException(status_code=400, detail=f"invalid holding {sym[:32]!r}: shares must be 0–1e12")
    try:
        return await asyncio.to_thread(
            orders_blocking, req.spec.model_dump(), req.nav, req.current, req.min_trade_pct
        )
    except factor_dsl.FactorError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except LookupError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


# ------------------------------------------------------------ AI memo


class MemoRequest(BaseModel):
    """The compact, numbers-only summary of a run. The client sends exactly
    what it displays; the model is not allowed to invent anything else."""

    spec: dict
    universe: dict
    signal: dict
    portfolio: dict
    stats: dict
    in_sample: dict
    holdout: dict
    overfitting: dict
    risk: dict
    warnings: list[str] = Field(default_factory=list, max_length=12)
    lang: str = Field("zh", pattern="^(zh|en)$")


MEMO_TOOL = {
    "name": "submit_memo",
    "description": "Deliver the investment-committee memo for this pipeline run.",
    "input_schema": {
        "type": "object",
        "properties": {
            "verdict": {"type": "string", "enum": ["deploy", "paper_first", "iterate", "reject"]},
            "headline": {"type": "string", "description": "One sentence: what this pipeline is and whether the evidence supports it."},
            "strengths": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
            "concerns": {"type": "array", "items": {"type": "string"}, "maxItems": 4},
            "next_steps": {"type": "array", "items": {"type": "string"}, "maxItems": 4,
                           "description": "Concrete parameter or factor changes to test next, each tied to a number in the input."},
            "honesty_note": {"type": "string", "description": "One sentence on what the statistics can NOT tell us at this sample length."},
        },
        "required": ["verdict", "headline", "strengths", "concerns", "next_steps", "honesty_note"],
    },
}

_MEMO_SYSTEM = {
    "zh": (
        "你是量化投资委员会的独立审阅人。你只能依据输入里给出的数字作判断，不得编造任何未提供的数据或回测结果；"
        "引用数字时保留原值。评判框架：留出期是否确认样本内（夏普、超额）；概率夏普 PSR / 缩水夏普 DSR 是否 ≥ 0.95、"
        "t 值是否过 3（Harvey-Liu-Zhu 门槛）、最短记录长度是否已满足；换手与盈亏平衡成本是否留有余量；"
        "分位数收益是否单调、IC 是否随期限衰减；不同市场状态下是否稳定；行业配置与选股各贡献多少；"
        "集中度与上限触发。结论只能是 deploy / paper_first / iterate / reject 之一，并给出可执行的下一步。"
        "全部用简体中文，通过 submit_memo 输出。"
    ),
    "en": (
        "You are the independent reviewer on a quantitative investment committee. Judge ONLY from the numbers "
        "provided; never invent data or results, and quote figures as given. Framework: does the holdout confirm "
        "the in-sample Sharpe and excess return; are PSR / DSR ≥ 0.95, is the t-stat above the Harvey-Liu-Zhu "
        "hurdle of 3, is the minimum track record length met; do turnover and breakeven cost leave a margin; are "
        "quantile returns monotone and how fast does IC decay; is performance stable across regimes; how much comes "
        "from sector allocation vs selection; concentration and cap binding. The verdict must be one of "
        "deploy / paper_first / iterate / reject with actionable next steps. Answer in English via submit_memo."
    ),
}


@router.post(
    "/memo",
    dependencies=[Depends(limiter("memo", "rl_memo_per_day", 86_400, global_attr="rl_global_ai_per_day"))],
)
async def memo(req: MemoRequest) -> dict:
    """Investment-committee memo on a finished run. The light model reads the
    same summary the page shows and must return a structured verdict through
    a forced tool call — the numbers stay ours, the judgement is its."""
    from app.config import get_settings
    from app.services import usage
    from app.services.llm import analyst

    if not analyst.enabled:
        raise HTTPException(status_code=503, detail="AI is not configured")
    settings = get_settings()
    payload = req.model_dump(exclude={"lang"})
    response = await analyst.client.messages.create(
        model=settings.claude_model_light,
        max_tokens=1200,
        system=_MEMO_SYSTEM[req.lang],
        messages=[{"role": "user", "content": json.dumps(payload, ensure_ascii=False, default=str)[:12_000]}],
        tools=[MEMO_TOOL],
        tool_choice={"type": "tool", "name": "submit_memo"},
    )
    usage.record(
        settings.claude_model_light,
        getattr(response.usage, "input_tokens", 0),
        getattr(response.usage, "output_tokens", 0),
    )
    for block in response.content:
        if block.type == "tool_use" and block.name == "submit_memo":
            data = block.input
            clip = lambda xs, n=4: [str(x)[:300] for x in (xs or [])][:n]  # noqa: E731
            return {
                "verdict": str(data.get("verdict", "iterate")),
                "headline": str(data.get("headline", ""))[:400],
                "strengths": clip(data.get("strengths")),
                "concerns": clip(data.get("concerns")),
                "next_steps": clip(data.get("next_steps")),
                "honesty_note": str(data.get("honesty_note", ""))[:300],
                "model": settings.claude_model_light,
            }
    raise HTTPException(status_code=502, detail="model did not return a memo")
