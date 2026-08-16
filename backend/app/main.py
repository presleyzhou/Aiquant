import logging

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.api import ai, analytics, kronos, market, marketplace, payments, ws
from app.config import get_settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)

settings = get_settings()

app = FastAPI(
    title="AI Quant Terminal",
    description=(
        "Market data, technical analytics, backtesting and Claude-driven analysis. "
        "Data layer reuses the MIT-licensed portions of fincept-terminal 2.0.8 "
        "(see backend/fincept_terminal/NOTICE.md)."
    ),
    version="0.1.0",
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=settings.cors_origin_list,
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(market.router)
app.include_router(analytics.router)
app.include_router(marketplace.router)
app.include_router(payments.router)
app.include_router(ai.router)
app.include_router(kronos.router)
app.include_router(ws.router)


@app.get("/api/health")
async def health():
    from app.services.llm import analyst

    return {
        "status": "ok",
        "ai_enabled": analyst.enabled,
        "model": settings.claude_model if analyst.enabled else None,
    }
