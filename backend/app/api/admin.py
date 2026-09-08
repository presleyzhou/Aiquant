"""Operator endpoints (X-Admin-Token): withdrawals, ledger, store health and
the scheduled re-check of listed / synced factors. No UI state lives here —
everything reads and writes the same KV documents the product uses."""

from __future__ import annotations

import asyncio
import logging
import time

from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.services import auth, kvstore, listings, provider_health, wallet
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
            "ops_last": kvstore.get("ops:last") or {},
            "provider_health": provider_health.summary(7),
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


def _recheck_blocking(max_factors: int, deadline: float | None = None) -> dict:
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
    done, failed, cut = 0, 0, 0
    for (market, expr, horizon), source in list(targets.items())[:max_factors]:
        if market not in UNIVERSES:
            continue
        if deadline is not None and time.time() > deadline:
            cut += 1
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
    meta = {"last_run": int(time.time()), "targets": len(targets), "done": done, "failed": failed, "cut_for_time": cut}
    if max_factors > 1:   # a one-factor drain pass must not overwrite the real run's summary
        kvstore.put("health:meta", meta)
    return meta


@router.post("/recheck")
async def recheck(max_factors: int = 60):
    return await asyncio.to_thread(_recheck_blocking, max(1, min(max_factors, 200)))


@router.post("/warm")
async def warm(markets: str = "us,crypto"):
    """Pre-load the built-in daily panels so the shared KV layer is populated
    before users arrive (run by the scheduled workflows). Reports provider,
    size and timing per market."""
    from app.services import panel_cache, panel_providers
    from app.services.factor_mine import _load_panel_blocking

    out: dict[str, dict] = {}
    for market in [m.strip() for m in markets.split(",") if m.strip()]:
        if market not in UNIVERSES:
            out[market] = {"error": "unknown market"}
            continue
        t0 = time.time()
        try:
            panel = await asyncio.to_thread(_load_panel_blocking, market)
            out[market] = {
                "symbols": int(panel["close"].shape[1]), "bars": int(len(panel["close"])),
                "provider": panel_providers.provider_of(panel), "seconds": round(time.time() - t0, 2),
                "shared": panel_cache.enabled(),
            }
        except Exception as exc:
            out[market] = {"error": str(exc)[:200], "seconds": round(time.time() - t0, 2)}
    return {"warmed": out, "kv": kvstore.mode()}


OPS_BUDGET_SECONDS = 250


@router.post("/ops")
async def ops(max_factors: int = 60, monitor_limit: int = 10, recheck: bool = True):
    """The single daily operations pass: warm the shared panels → recheck
    listed / synced factors → run the deployment monitor. Each step is timed
    and isolated (one failing step does not stop the others); the report is
    stored as ops:last (+ a 14-run history) and shown in the admin console.
    Returns `monitor.remaining` so the scheduler knows whether to call again."""
    from app.services import monitor

    started = time.time()
    steps: list[dict] = []

    async def step(name: str, fn):
        t0 = time.time()
        row = {"step": name, "ok": True}
        try:
            row["result"] = await fn()
        except Exception as exc:
            row["ok"] = False
            row["error"] = str(exc)[:300]
            log.warning("ops step %s failed: %s", name, exc)
        row["seconds"] = round(time.time() - t0, 2)
        steps.append(row)
        return row

    async def do_warm():
        return (await warm())["warmed"]

    async def do_recheck():
        if not recheck:
            return {"skipped": "drain pass"}
        if time.time() - started > OPS_BUDGET_SECONDS * 0.6:
            return {"skipped": "time budget"}
        # hard stop: leave at least 40% of the budget for the monitor step
        return await asyncio.to_thread(_recheck_blocking, max(1, min(max_factors, 200)), started + OPS_BUDGET_SECONDS * 0.6)

    async def do_monitor():
        left = OPS_BUDGET_SECONDS - (time.time() - started)
        if left < OPS_BUDGET_SECONDS * 0.15:
            return {"skipped": "time budget", "remaining": -1}
        return await monitor.run_all(force=False, limit=max(1, min(monitor_limit, 100)), budget_seconds=left - 10)

    await step("warm", do_warm)
    await step("recheck", do_recheck)
    # an interim report so a killed function still leaves a trace
    await asyncio.to_thread(kvstore.put, "ops:last", {"started_at": int(started), "finished_at": None, "seconds": None,
                                                        "steps": steps, "ok": None, "monitor_remaining": -1})
    mon = await step("monitor", do_monitor)
    report = {
        "started_at": int(started), "finished_at": int(time.time()),
        "seconds": round(time.time() - started, 2), "steps": steps,
        "ok": all(r["ok"] for r in steps),
    }
    remaining = int((mon.get("result") or {}).get("remaining") or 0) if mon["ok"] else -1
    report["monitor_remaining"] = remaining
    history = kvstore.get("ops:history") or {"runs": []}
    history["runs"] = ([{k: report[k] for k in ("started_at", "seconds", "ok", "monitor_remaining")}] + history["runs"])[:14]
    await asyncio.to_thread(kvstore.put, "ops:last", report)
    await asyncio.to_thread(kvstore.put, "ops:history", history)
    return report


# ------------------------------------------------------------ integrations

INTEGRATION_TIMEOUT = 6.0


async def _probe(fn):
    try:
        return await asyncio.wait_for(fn(), INTEGRATION_TIMEOUT)
    except Exception as exc:  # the probe's failure IS the finding
        return {"status": "red", "detail": f"{type(exc).__name__}: {str(exc)[:160]}"}


@router.get("/integrations")
async def integrations():
    """One traffic-light row per integration: configured? reachable? current?
    Green = works, amber = configured but degraded / demo, red = broken,
    off = not configured (with what enabling it would unlock)."""
    import httpx

    from app.config import get_settings
    from app.main import APP_VERSION
    from app.services import panel_providers, provider_health

    st = get_settings()

    async def kv():
        if kvstore.mode() != "kv":
            return {"status": "amber", "detail": "file store (ephemeral on serverless) — set KV_REST_API_URL/TOKEN for durable wallets, listings, sync"}
        probe = {"t": int(time.time())}
        await asyncio.to_thread(kvstore.put, "probe:integrations", probe)
        back = await asyncio.to_thread(kvstore.get, "probe:integrations")
        return {"status": "green" if back == probe else "red", "detail": "Upstash REST round-trip ok" if back == probe else "round-trip mismatch"}

    async def supabase():
        if not auth.enabled():
            return {"status": "off", "detail": "set SUPABASE_URL + SUPABASE_ANON_KEY to enable sign-in and cloud sync"}
        async with httpx.AsyncClient(timeout=INTEGRATION_TIMEOUT) as c:
            r = await c.get(f"{st.supabase_url.rstrip('/')}/auth/v1/settings", headers={"apikey": st.supabase_anon_key})
        if r.status_code != 200:
            return {"status": "red", "detail": f"/auth/v1/settings → HTTP {r.status_code}"}
        ext = r.json().get("external", {})
        return {"status": "green" if ext.get("email") else "amber", "detail": "reachable; email provider " + ("enabled" if ext.get("email") else "DISABLED in Supabase Auth settings")}

    async def stripe():
        if not st.stripe_secret_key:
            return {"status": "off", "detail": "set STRIPE_SECRET_KEY to accept cards / Apple Pay (+ STRIPE_WEBHOOK_SECRET)"}
        async with httpx.AsyncClient(timeout=INTEGRATION_TIMEOUT, auth=(st.stripe_secret_key, "")) as c:
            r = await c.get("https://api.stripe.com/v1/balance")
        if r.status_code != 200:
            return {"status": "red", "detail": f"/v1/balance → HTTP {r.status_code}"}
        live = not st.stripe_secret_key.startswith("sk_test")
        hook = "webhook secret set" if st.stripe_webhook_secret else "no STRIPE_WEBHOOK_SECRET (polling only)"
        return {"status": "green" if st.stripe_webhook_secret else "amber", "detail": f"{'LIVE' if live else 'test'} key ok; {hook}"}

    async def coinbase():
        if not st.coinbase_commerce_api_key:
            return {"status": "off", "detail": "set COINBASE_COMMERCE_API_KEY to accept crypto (+ COINBASE_WEBHOOK_SECRET)"}
        async with httpx.AsyncClient(timeout=INTEGRATION_TIMEOUT) as c:
            r = await c.get("https://api.commerce.coinbase.com/charges?limit=1", headers={"X-CC-Api-Key": st.coinbase_commerce_api_key, "X-CC-Version": "2018-03-22"})
        if r.status_code != 200:
            return {"status": "red", "detail": f"/charges → HTTP {r.status_code}"}
        return {"status": "green" if st.coinbase_webhook_secret else "amber", "detail": "API key ok; " + ("webhook secret set" if st.coinbase_webhook_secret else "no COINBASE_WEBHOOK_SECRET (polling only)")}

    async def sentry():
        return {"status": "green", "detail": "DSN set — errors from KV, webhooks and rechecks are reported"} if st.sentry_dsn else {"status": "off", "detail": "set SENTRY_DSN (backend) / VITE_SENTRY_DSN (frontend)"}

    async def anthropic():
        return {"status": "green", "detail": f"{st.claude_model} / light {st.claude_model_light}"} if st.anthropic_api_key else {"status": "off", "detail": "set ANTHROPIC_API_KEY for AI mining, chat and explanations"}

    async def kronos():
        if not st.kronos_remote_url:
            return {"status": "amber" if st.kronos_enabled != "0" else "off", "detail": "no KRONOS_REMOTE_URL — forecasts only where torch is installed"}
        base = st.kronos_remote_url.rstrip("/")
        async with httpx.AsyncClient(timeout=INTEGRATION_TIMEOUT) as c:
            status = await c.get(f"{base}/api/kronos/status")
            ver = await c.get(f"{base}/api/version")
        if status.status_code != 200:
            return {"status": "red", "detail": f"remote status → HTTP {status.status_code}"}
        if ver.status_code != 200:
            return {"status": "amber", "detail": "remote reachable but runs an OLD build (no /api/version): hourly forecasts unavailable — update the Space Dockerfile and rebuild"}
        rv = ver.json().get("version")
        same = rv == APP_VERSION
        return {"status": "green" if same else "amber", "detail": f"remote build {rv} vs local {APP_VERSION}" + ("" if same else " — restart the Space to pull the latest code")}

    async def data():
        ph = await asyncio.to_thread(provider_health.summary, 7)
        markets = ph.get("markets", {})
        us = panel_providers.effective_us_provider(st.panel_provider_us)
        detail = f"us: {us}{' (+stooq fill)' if st.stooq_fill else ''} · crypto: {st.panel_provider_crypto}{' (+coingecko fill)' if st.coingecko_fill else ''}"
        degraded = any((m.get("fallback_rate") or 0) > 0.5 for m in markets.values()) if markets else False
        return {"status": "amber" if degraded else "green", "detail": detail + (" · heavy fallback use in the last 7 days" if degraded else ""), "markets": markets}

    async def admin_token():
        return {"status": "green", "detail": "ADMIN_TOKEN set"}

    async def secret():
        return {"status": "green", "detail": "MARKETPLACE_SECRET set — entitlements survive restarts"} if st.marketplace_secret else {"status": "amber", "detail": "MARKETPLACE_SECRET unset — entitlement tokens die on cold start"}

    probes = {
        "kv": kv, "supabase": supabase, "stripe": stripe, "coinbase": coinbase, "sentry": sentry, "anthropic": anthropic,
        "kronos_remote": kronos, "market_data": data, "admin_token": admin_token, "marketplace_secret": secret,
    }
    results = await asyncio.gather(*(_probe(fn) for fn in probes.values()))
    rows = [{"name": name, **res} for name, res in zip(probes, results, strict=True)]
    counts = {k: sum(1 for r in rows if r["status"] == k) for k in ("green", "amber", "red", "off")}
    return {"version": APP_VERSION, "checked_at": int(time.time()), "counts": counts, "integrations": rows}
