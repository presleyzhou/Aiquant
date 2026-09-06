"""Operator endpoints (X-Admin-Token): withdrawals, ledger, store health and
the scheduled re-check of listed / synced factors. No UI state lives here —
everything reads and writes the same KV documents the product uses."""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.services import auth, kvstore, listings, wallet
from app.services.factor_mine import (
    UNIVERSES,
    analyze_factor_blocking,
    check_factor_blocking,
)

log = logging.getLogger(__name__)
router = APIRouter(prefix="/api/admin", tags=["admin"], dependencies=[Depends(auth.require_admin)])


@router.get("/overview")
async def overview():
    def build():
        listings_all = kvstore.list_prefix("listing")
        orders = kvstore.list_prefix("order")
        withdrawals = kvstore.list_prefix("withdraw")
        wallets = kvstore.list_prefix("wallet")
        states = kvstore.list_prefix("state")
        confirmed = [o for o in orders if o.get("status") == "confirmed" and not o.get("demo")]
        return {
            "persistence": kvstore.mode(),
            "counts": {
                "listings": len(listings_all), "active_listings": sum(1 for r in listings_all if r.get("status") == "active"),
                "orders": len(orders), "real_orders": len(confirmed), "wallets": len(wallets), "accounts_synced": len(states),
                "withdrawals_pending": sum(1 for w in withdrawals if w.get("status") == "pending"),
            },
            "gross_usd": round(sum(float(o.get("amount") or 0) for o in confirmed), 2),
            "wallet_liabilities_usd": round(sum(float(w.get("balance_usd") or 0) for w in wallets), 2),
            "health_runs": kvstore.get("health:meta") or {},
        }
    return await asyncio.to_thread(build)


@router.get("/withdrawals")
async def withdrawals(status: str | None = None):
    rows = await asyncio.to_thread(kvstore.list_prefix, "withdraw")
    if status:
        rows = [r for r in rows if r.get("status") == status]
    rows.sort(key=lambda r: -r.get("at", 0))
    return {"withdrawals": rows[:200]}


class WithdrawalUpdate(BaseModel):
    status: str = Field(pattern="^(pending|paid|rejected)$")
    note: str = Field("", max_length=300)


@router.post("/withdrawals/{wid}")
async def update_withdrawal(wid: str, req: WithdrawalUpdate):
    row = await asyncio.to_thread(kvstore.get, f"withdraw:{wid}")
    if not row:
        raise HTTPException(status_code=404, detail="withdrawal not found")
    if req.status == "rejected" and row.get("status") != "rejected":
        # give the money back
        await asyncio.to_thread(wallet.credit, row["account"], float(row["amount"]), demo=False, ref=f"refund:{wid}", kind="topup", note="withdrawal rejected")
    row.update({"status": req.status, "note": req.note, "settled_at": int(time.time()) if req.status != "pending" else None})
    await asyncio.to_thread(kvstore.put, f"withdraw:{wid}", row)
    return row


@router.get("/orders")
async def orders(limit: int = 200):
    rows = await asyncio.to_thread(kvstore.list_prefix, "order")
    rows.sort(key=lambda r: -r.get("at", 0))
    return {"orders": rows[: max(1, min(limit, 500))]}


@router.get("/listings")
async def all_listings():
    rows = await asyncio.to_thread(kvstore.list_prefix, "listing")
    return {"listings": [listings.serialize(r, unlocked=False) | {"status": r.get("status"), "seller": r.get("seller", "")[:12]} for r in rows]}


# --------------------------------------------------------- scheduled recheck

def _health_key(market: str, expression: str) -> str:
    import hashlib
    return "health:" + hashlib.sha1(f"{market}|{expression}".encode()).hexdigest()[:20]


def _recheck_blocking(max_factors: int) -> dict:
    """Re-evaluate every factor that is listed on the marketplace or sits in a
    synced account's library: health check + report-card grades → KV."""
    targets: dict[tuple[str, str, int], str] = {}
    for row in kvstore.list_prefix("listing"):
        if row.get("type") == "factor" and row.get("status") == "active":
            pl = row.get("payload") or {}
            if pl.get("expression"):
                targets[(pl.get("market", "us"), pl["expression"], int(pl.get("horizon", 10)))] = "listing"
    for doc in kvstore.list_prefix("state"):
        for f in (doc.get("data") or {}).get("aiquant.factors.zoo", []) or []:
            if isinstance(f, dict) and f.get("expression"):
                key = (str(f.get("market", "us")), str(f["expression"]), int(f.get("horizon", 10) or 10))
                targets.setdefault(key, "account")
    done, failed = 0, 0
    for (market, expr, horizon), source in list(targets.items())[:max_factors]:
        if market not in UNIVERSES:
            continue
        try:
            chk = check_factor_blocking(expr, market, horizon)
            rep = analyze_factor_blocking(expr, market, horizon)
            kvstore.put(_health_key(market, expr), {
                "market": market, "expression": expr, "horizon": horizon, "source": source,
                "checked_at": int(time.time()), "as_of": rep["as_of"],
                "is_ic": chk["is_ic"], "oos_ic": chk["oos_ic"], "recent_ic": chk["recent_ic"],
                "grades": rep["grades"], "best_horizon": rep["best_horizon"],
                "spread_after_cost_ann_pct": rep["spread_after_cost_ann_pct"],
                "decayed": abs(chk["recent_ic"]) < 0.005 or (chk["recent_ic"] * chk["is_ic"] < 0),
            })
            done += 1
        except Exception as exc:
            log.warning("recheck failed for %s: %s", expr, exc)
            failed += 1
    meta = {"last_run": int(time.time()), "targets": len(targets), "done": done, "failed": failed}
    kvstore.put("health:meta", meta)
    return meta


@router.post("/recheck")
async def recheck(max_factors: int = 60):
    return await asyncio.to_thread(_recheck_blocking, max(1, min(max_factors, 200)))
