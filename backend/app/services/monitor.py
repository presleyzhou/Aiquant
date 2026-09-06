"""Daily monitor for deployed strategies / factors / pipelines.

Signed-in users' paper deployments live in the cloud state document
(`state:<account>` → data["aiquant.paper"]). A scheduled job replays every
deployment, applies a handful of rules, stores a per-account report under
`monitor:<account>` and, when something NEW fires and the user configured a
webhook, posts a short notice. The rules are deliberately few and loud:

  drawdown   — current drawdown at or below the threshold (default −10%)
  decay      — the paper page's edge-decay verdict is "degraded"
  rebalance  — the rule's target holdings changed since the last check
  stale      — the newest bar is more than 5 days old (data feed problem)
  error      — the deployment could not be replayed at all

Nothing here trades. The monitor tells; the user decides.
"""

from __future__ import annotations

import asyncio
import ipaddress
import logging
import time
from datetime import date, datetime, timezone
from urllib.parse import urlparse

import httpx

from app.config import get_settings
from app.services import kvstore

log = logging.getLogger("aiquant.monitor")

MAX_DEPLOYMENTS_PER_ACCOUNT = 12
STALE_DAYS = 5
REFRESH_SECONDS = 20 * 3600          # an account checked less than 20h ago is skipped
ACCOUNTS_PER_RUN = 20                 # keeps one run well inside the serverless time limit
_BLOCKED_HOSTS = {"localhost", "metadata.google.internal"}


# ------------------------------------------------------------------ rules


def evaluate(dep: dict, track: dict | None, previous: dict | None, error: str | None,
             drawdown_pct: float) -> dict:
    """One deployment → its monitor row. `previous` is the same deployment's
    row from the last run (for change detection)."""
    row = {
        "id": str(dep.get("id")), "name": str(dep.get("name", ""))[:60], "kind": str(dep.get("kind", "")),
        "started_at": dep.get("startedAt"), "alerts": [], "as_of": None, "days_live": None,
        "return_pct": None, "excess_pct": None, "current_drawdown_pct": None, "sharpe": None,
        "decay": None, "position": None,
    }
    if error or track is None:
        row["alerts"].append({"code": "error", "detail": (error or "replay failed")[:200]})
        return row
    stats = track.get("stats", {})
    row.update({
        "as_of": track.get("as_of"), "days_live": track.get("days_live"),
        "return_pct": stats.get("return_pct"), "excess_pct": stats.get("excess_pct"),
        "current_drawdown_pct": stats.get("current_drawdown_pct"), "sharpe": stats.get("sharpe"),
        "decay": (track.get("decay") or {}).get("verdict"),
        "position": {k: (track.get("position") or {}).get(k) for k in ("state", "symbols", "weights_pct", "since")},
    })
    dd = stats.get("current_drawdown_pct")
    if dd is not None and dd <= -abs(drawdown_pct):
        row["alerts"].append({"code": "drawdown", "detail": f"{dd:.1f}%"})
    if row["decay"] == "degraded":
        d = track.get("decay") or {}
        row["alerts"].append({"code": "decay", "detail": f"sharpe {d.get('sharpe_delta')} / excess {d.get('excess_delta')}"})
    prev_syms = ((previous or {}).get("position") or {}).get("symbols") or []
    cur_syms = (row["position"] or {}).get("symbols") or []
    if previous is not None and prev_syms and cur_syms and set(prev_syms) != set(cur_syms):
        added = sorted(set(cur_syms) - set(prev_syms))
        removed = sorted(set(prev_syms) - set(cur_syms))
        row["alerts"].append({"code": "rebalance", "detail": f"+{','.join(added[:6])} -{','.join(removed[:6])}"})
    try:
        as_of = date.fromisoformat(str(track.get("as_of")))
        if (date.today() - as_of).days > STALE_DAYS:
            row["alerts"].append({"code": "stale", "detail": str(as_of)})
    except (TypeError, ValueError):
        pass
    return row


def new_alerts(report: dict, previous: dict | None) -> list[dict]:
    """Alerts that were not already present in the previous report — the
    ones worth a notification."""
    seen = set()
    for item in (previous or {}).get("items", []):
        for a in item.get("alerts", []):
            seen.add((item.get("id"), a.get("code")))
    fresh = []
    for item in report.get("items", []):
        for a in item.get("alerts", []):
            if (item.get("id"), a.get("code")) not in seen:
                fresh.append({"id": item.get("id"), "name": item.get("name"), **a})
    return fresh


# ---------------------------------------------------------------- webhook


def webhook_ok(url: str) -> bool:
    """https only, no loopback / private / link-local literals, no known
    metadata hosts — the cheap half of SSRF hygiene."""
    try:
        u = urlparse(url)
    except ValueError:
        return False
    if u.scheme != "https" or not u.hostname or len(url) > 500:
        return False
    host = u.hostname.lower()
    if host in _BLOCKED_HOSTS or host.endswith(".local") or host.endswith(".internal"):
        return False
    try:
        ip = ipaddress.ip_address(host)
        return not (ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_reserved or ip.is_multicast)
    except ValueError:
        return True


def format_message(account_label: str, alerts: list[dict], site_url: str) -> str:
    names = {"drawdown": "回撤", "decay": "衰减", "rebalance": "需调仓", "stale": "数据过期", "error": "无法重算"}
    lines = [f"AIQUANT 模拟持仓提醒 · {len(alerts)} 条"]
    for a in alerts[:10]:
        lines.append(f"• {a.get('name')}: {names.get(a.get('code'), a.get('code'))} {a.get('detail', '')}".rstrip())
    if len(alerts) > 10:
        lines.append(f"… 另有 {len(alerts) - 10} 条")
    lines.append(f"{site_url.rstrip('/')}/?view=paper")
    return "\n".join(lines)


def post_webhook(url: str, text: str) -> bool:
    """One POST carrying the message under the keys Slack, Discord and
    Telegram each read; failures are logged, never raised."""
    if not webhook_ok(url):
        return False
    try:
        resp = httpx.post(url, json={"text": text, "content": text}, timeout=10.0, follow_redirects=False)
        return 200 <= resp.status_code < 300
    except Exception as exc:
        log.warning("webhook post failed: %s", exc)
        return False


# -------------------------------------------------------------------- run


async def run_account(key: str, doc: dict, force: bool = False) -> dict | None:
    """Evaluate one account's deployments; returns the stored report, or None
    when the account was skipped (fresh enough / nothing deployed)."""
    from app.api.paper import compute_track  # local import: paper imports services

    settings = get_settings()
    account = key.split(":", 1)[1]
    data = doc.get("data") or {}
    deployments = [d for d in (data.get("aiquant.paper") or []) if isinstance(d, dict)][:MAX_DEPLOYMENTS_PER_ACCOUNT]
    if not deployments:
        return None
    previous = kvstore.get(f"monitor:{account}") or {}
    if not force and previous.get("generated_at") and time.time() - previous["generated_at"] < REFRESH_SECONDS:
        return None
    prev_rows = {r.get("id"): r for r in previous.get("items", [])}
    items = []
    for dep in deployments:
        track, err = None, None
        try:
            started = date.fromisoformat(str(dep.get("startedAt")))
            track = await compute_track(str(dep.get("kind", "strategy")), started, dict(dep.get("config") or {}))
        except Exception as exc:  # HTTPException carries .detail; anything else its str
            err = str(getattr(exc, "detail", None) or exc)
        items.append(evaluate(dep, track, prev_rows.get(str(dep.get("id"))), err, settings.monitor_drawdown_pct))
    report = {
        "account": account,
        "generated_at": int(time.time()),
        "generated_on": datetime.now(timezone.utc).date().isoformat(),
        "items": items,
        "alerts_total": sum(len(i["alerts"]) for i in items),
    }
    fresh = new_alerts(report, previous)
    report["new_alerts"] = len(fresh)
    notify = data.get("aiquant.notify") or {}
    url = str(notify.get("webhook_url") or "").strip()
    report["notified"] = False
    if fresh and url:
        report["notified"] = await asyncio.to_thread(
            post_webhook, url, format_message(account[:8], fresh, settings.site_url)
        )
    kvstore.put(f"monitor:{account}", report)
    return report


async def run_all(force: bool = False, limit: int = ACCOUNTS_PER_RUN) -> dict:
    """Walk every cloud state document; stop after `limit` accounts so one
    call stays inside the function time budget. Returns counts and how many
    accounts still need a pass (the caller loops until zero)."""
    processed = skipped = alerts = notified = remaining = 0
    now = time.time()
    for key, doc in kvstore.list_prefix_items("state"):
        data = (doc or {}).get("data") or {}
        if not data.get("aiquant.paper"):
            continue
        acct = key.split(":", 1)[1]
        prev = kvstore.get(f"monitor:{acct}") or {}
        if not force and prev.get("generated_at") and now - prev["generated_at"] < REFRESH_SECONDS:
            skipped += 1
            continue
        if processed >= limit:
            remaining += 1
            continue
        report = await run_account(key, doc, force=True)
        processed += 1
        if report:
            alerts += report["alerts_total"]
            notified += int(bool(report.get("notified")))
    return {"processed": processed, "skipped": skipped, "remaining": remaining, "alerts": alerts, "notified": notified}
