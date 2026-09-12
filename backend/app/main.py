import logging
import math

from fastapi import FastAPI, Request
from fastapi.encoders import jsonable_encoder
from fastapi.exceptions import RequestValidationError
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse

from app.api import (
    account,
    admin,
    ai,
    analytics,
    factors,
    kronos,
    market,
    marketplace,
    paper,
    payments,
    pipeline,
    wallet,
    ws,
)
from app.config import get_settings

logging.basicConfig(
    level=logging.INFO,
    format="%(asctime)s %(levelname)-7s %(name)s: %(message)s",
)

settings = get_settings()

# Error monitoring — a no-op unless SENTRY_DSN is configured. The FastAPI
# integration is picked up automatically by sentry_sdk.init.
if settings.sentry_dsn:
    try:
        import sentry_sdk

        sentry_sdk.init(dsn=settings.sentry_dsn, traces_sample_rate=0.05)
        logging.getLogger("aiquant").info("Sentry enabled")
    except Exception as exc:  # never let monitoring break the app
        logging.getLogger("aiquant").warning("Sentry init failed: %s", exc)

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
app.include_router(wallet.router)
app.include_router(account.router)
app.include_router(admin.router)
app.include_router(ai.router)
app.include_router(kronos.router)
app.include_router(factors.router)
app.include_router(paper.router)
app.include_router(pipeline.router)
app.include_router(ws.router)


# A request carrying NaN/inf (Python's json accepts them) fails validation,
# but the default 422 body echoes the offending input and then cannot be
# serialised — a 500 in production. Sanitise non-finite floats first.
def _finite(obj):
    if isinstance(obj, float) and not math.isfinite(obj):
        return str(obj)
    if isinstance(obj, dict):
        return {k: _finite(v) for k, v in obj.items()}
    if isinstance(obj, (list, tuple)):
        return [_finite(v) for v in obj]
    return obj


@app.exception_handler(RequestValidationError)
async def _validation_error(_request: Request, exc: RequestValidationError) -> JSONResponse:
    return JSONResponse(status_code=422, content={"detail": _finite(jsonable_encoder(exc.errors()))})


def _build_version() -> str:
    """Short commit SHA of the running code. Vercel exposes it as an env var;
    the Kronos Space clones the repo with git, so its .git/HEAD is readable;
    anywhere else falls back to a dated constant. The admin integrations page
    compares this value across the two deployments to spot a stale Space."""
    import os
    from pathlib import Path

    for var in ("APP_BUILD", "VERCEL_GIT_COMMIT_SHA", "SOURCE_COMMIT", "GIT_COMMIT"):
        v = os.environ.get(var, "").strip()
        if v:
            return v[:7]
    try:
        git_dir = Path(__file__).resolve().parents[2] / ".git"
        head = (git_dir / "HEAD").read_text().strip()
        if head.startswith("ref: "):
            ref = git_dir / head[5:]
            if ref.exists():
                return ref.read_text().strip()[:7]
            packed = git_dir / "packed-refs"
            if packed.exists():
                for line in packed.read_text().splitlines():
                    if line.endswith(" " + head[5:]):
                        return line.split(" ", 1)[0][:7]
        else:
            return head[:7]
    except OSError:
        pass
    return "2026.09.12"


APP_VERSION = _build_version()
APP_FEATURES = ["kronos_hourly", "factor_report", "wallet", "accounts", "admin", "panel_coverage", "integrations",
                "hourly_factors", "regimes", "families", "risk_controls", "disputes", "audit", "admin_tiers", "entitlement_verify"]


@app.get("/api/version")
async def version() -> dict:
    """Build fingerprint — the Kronos remote check compares it to its own."""
    return {"version": APP_VERSION, "features": APP_FEATURES}


@app.get("/api/health")
async def health():
    from app.services import kvstore
    from app.services.llm import analyst

    return {
        "status": "ok",
        "version": APP_VERSION,
        "persistence": kvstore.mode(),
        "ai_enabled": analyst.enabled,
        "model": settings.claude_model if analyst.enabled else None,
    }
