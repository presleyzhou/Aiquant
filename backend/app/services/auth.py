"""Account identity: Supabase-authenticated user id, or a browser-held secret.

Every identity-bearing endpoint asks `resolve_account()` for a stable hash.
With a valid `Authorization: Bearer <supabase access token>` the hash comes
from the user id (so it survives devices and cache clears); otherwise the
legacy browser secret is hashed as before. Tokens are verified by asking the
Supabase Auth API — algorithm-agnostic (HS256 or ES256 projects) and needs
nothing but httpx — and cached briefly.
"""

from __future__ import annotations

import hashlib
import hmac
import logging
import time

import httpx
from fastapi import HTTPException, Request

from app.config import get_settings

log = logging.getLogger(__name__)
_CACHE: dict[str, tuple[float, dict | None]] = {}
_TTL = 300.0


def enabled() -> bool:
    s = get_settings()
    return bool(s.supabase_url and s.supabase_anon_key)


def user_hash(user_id: str) -> str:
    return hashlib.sha256(f"uid:{user_id}".encode()).hexdigest()


def secret_hash(secret: str) -> str:
    return hashlib.sha256(secret.encode()).hexdigest()


async def verify(token: str) -> dict | None:
    """→ {"id", "email"} for a valid Supabase access token, else None."""
    if not enabled() or not token:
        return None
    key = hashlib.sha256(token.encode()).hexdigest()
    hit = _CACHE.get(key)
    if hit and time.time() - hit[0] < _TTL:
        return hit[1]
    s = get_settings()
    try:
        async with httpx.AsyncClient(timeout=8) as client:
            resp = await client.get(
                f"{s.supabase_url.rstrip('/')}/auth/v1/user",
                headers={"apikey": s.supabase_anon_key, "Authorization": f"Bearer {token}"},
            )
        user = None
        if resp.status_code == 200:
            body = resp.json()
            if body.get("id"):
                user = {"id": body["id"], "email": body.get("email")}
    except httpx.HTTPError as exc:
        log.warning("supabase verify failed: %s", exc)
        user = None
    if len(_CACHE) > 2000:
        _CACHE.clear()
    _CACHE[key] = (time.time(), user)
    return user


def bearer(request: Request) -> str | None:
    auth = request.headers.get("authorization", "")
    return auth[7:].strip() if auth.lower().startswith("bearer ") else None


async def current_user(request: Request) -> dict | None:
    tok = bearer(request)
    return await verify(tok) if tok else None


async def resolve_account(request: Request, secret: str | None) -> tuple[str, dict]:
    """(account hash, identity info). Logged-in user wins; else browser secret."""
    user = await current_user(request)
    if user:
        return user_hash(user["id"]), {"kind": "user", "email": user.get("email")}
    if secret and 16 <= len(secret) <= 128:
        return secret_hash(secret), {"kind": "browser"}
    raise HTTPException(status_code=401, detail="sign in or provide an account secret")


def require_admin(request: Request) -> None:
    s = get_settings()
    tok = request.headers.get("x-admin-token") or bearer(request) or ""
    if not s.admin_token or not hmac.compare_digest(tok, s.admin_token):
        raise HTTPException(status_code=403, detail="admin token required")
