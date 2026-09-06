"""Accounts: who am I, cloud copy of the browser state, and claiming a
browser-held identity (wallet + listings) into a signed-in account."""

from __future__ import annotations

import asyncio
import json
import time

from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.services import auth, kvstore, listings, wallet
from app.services.ratelimit import limiter

router = APIRouter(prefix="/api/account", tags=["account"])

STATE_KEYS = {
    "aiquant.factors.zoo", "aiquant.factors.lessons", "aiquant.factors.trials", "aiquant.paper",
    "aiquant.alerts", "aiquant.purchases", "aiquant.mystrategies", "aiquant.installed",
    "aiquant.watchlist.us", "aiquant.watchlist.crypto", "aiquant.stripe_account",
}
MAX_STATE_BYTES = 400_000


@router.get("/config")
async def config():
    return {"enabled": auth.enabled(), "provider": "supabase" if auth.enabled() else None,
            "persistence": kvstore.mode(), "sync_keys": sorted(STATE_KEYS)}


@router.get("/me")
async def me(request: Request):
    user = await auth.current_user(request)
    if not user:
        return {"signed_in": False}
    h = auth.user_hash(user["id"])
    doc = kvstore.get(f"state:{h}") or {}
    return {"signed_in": True, "email": user.get("email"), "account": h[:12],
            "state_updated_at": doc.get("updated_at")}


@router.get("/state")
async def get_state(request: Request):
    user = await auth.current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="sign in required")
    doc = await asyncio.to_thread(kvstore.get, f"state:{auth.user_hash(user['id'])}")
    return doc or {"data": {}, "updated_at": None}


class StatePut(BaseModel):
    data: dict = Field(default_factory=dict)


@router.put("/state", dependencies=[Depends(limiter("account", "rl_account_per_hour", 3600))])
async def put_state(req: StatePut, request: Request):
    user = await auth.current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="sign in required")
    data = {k: v for k, v in req.data.items() if k in STATE_KEYS}
    raw = json.dumps(data, ensure_ascii=False)
    if len(raw.encode()) > MAX_STATE_BYTES:
        raise HTTPException(status_code=413, detail=f"state too large (> {MAX_STATE_BYTES // 1000} KB)")
    doc = {"data": data, "updated_at": int(time.time()), "email": user.get("email")}
    await asyncio.to_thread(kvstore.put, f"state:{auth.user_hash(user['id'])}", doc)
    return {"saved": len(data), "updated_at": doc["updated_at"], "bytes": len(raw.encode())}


class Claim(BaseModel):
    account_secret: str = Field(min_length=16, max_length=128)


@router.post("/claim")
async def claim(req: Claim, request: Request):
    """Fold this browser's wallet and listings into the signed-in account."""
    user = await auth.current_user(request)
    if not user:
        raise HTTPException(status_code=401, detail="sign in required")
    old, new = auth.secret_hash(req.account_secret), auth.user_hash(user["id"])
    w = await asyncio.to_thread(wallet.merge_into, old, new)
    n = await asyncio.to_thread(listings.reassign_seller, old, new)
    return {"wallet": w, "listings_moved": n}
