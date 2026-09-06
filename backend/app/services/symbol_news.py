"""Per-symbol headlines via yfinance, normalized across its two news shapes
(legacy flat dicts vs the newer {"content": {...}} wrapper), disk-cached so
repeat visitors don't hammer Yahoo."""

from __future__ import annotations

from datetime import UTC, datetime

import yfinance as yf

from app.services import disk_cache

_TTL = 900  # 15 min


def fetch_symbol_news(symbol: str, limit: int = 8) -> list[dict]:
    cache_key = f"news-{symbol}"
    cached = disk_cache.load(cache_key, _TTL)
    if isinstance(cached, list):
        return cached[:limit]

    try:
        raw = yf.Ticker(symbol).news or []
    except Exception:
        raw = []

    articles: list[dict] = []
    for item in raw:
        content = item.get("content", item)  # new shape nests under "content"
        title = content.get("title")
        if not title:
            continue
        url = (
            (content.get("canonicalUrl") or {}).get("url")
            or (content.get("clickThroughUrl") or {}).get("url")
            or item.get("link")
            or ""
        )
        publisher = (
            (content.get("provider") or {}).get("displayName")
            or item.get("publisher")
            or ""
        )
        published = content.get("pubDate") or ""
        if not published and item.get("providerPublishTime"):
            published = datetime.fromtimestamp(
                int(item["providerPublishTime"]), tz=UTC
            ).isoformat()
        articles.append(
            {"title": str(title)[:200], "url": url, "publisher": publisher, "published": published}
        )
        if len(articles) >= 15:
            break

    disk_cache.store(cache_key, articles)
    return articles[:limit]
