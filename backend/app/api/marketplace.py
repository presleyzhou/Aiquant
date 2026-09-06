import asyncio

from fastapi import APIRouter, Depends, HTTPException, Query, Request
from pydantic import BaseModel, Field

from app.services import auth, kvstore, listings, marketplace
from app.services.ratelimit import limiter

router = APIRouter(prefix="/api/marketplace", tags=["marketplace"])


@router.get("/items")
async def list_items(
    type: str | None = Query(None, pattern="^(strategy|skill|data|factor|community)$"),
    q: str | None = Query(None, max_length=80),
):
    builtin = [] if type in {"factor", "community"} else marketplace.list_items(item_type=type, query=q)
    try:
        rows = await asyncio.to_thread(listings.active)
    except Exception as exc:
        rows = []
        community_error = str(exc)
    else:
        community_error = None
    community = [listings.serialize(r) for r in rows]
    if type and type not in {"community"}:
        community = [c for c in community if c["type"] == type]
    if q:
        ql = q.strip().lower()
        community = [
            c for c in community
            if ql in c["name"].lower() or ql in c["tagline"].lower() or any(ql in t.lower() for t in c["tags"])
        ]
    items = community + builtin
    return {"count": len(items), "items": items, "persistence": kvstore.mode(), "community_error": community_error}


@router.get("/items/{item_id}")
async def get_item(item_id: str, token: str | None = None):
    row = listings.get(item_id)
    if row is not None:
        unlocked = listings.verify_entitlement(token, item_id) is not None
        return listings.serialize(row, unlocked=unlocked)
    item = marketplace.get_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"no marketplace item {item_id!r}")
    return item


# ------------------------------------------------------------- sell side


class ListingCreate(BaseModel):
    seller_secret: str | None = Field(default=None, min_length=16, max_length=128)
    type: str = Field(pattern="^(strategy|factor)$")
    name: str = Field(min_length=2, max_length=60)
    tagline: str = Field(default="", max_length=120)
    description: str = Field(default="", max_length=2000)
    author: str = Field(default="", max_length=40)
    tags: list[str] = Field(default_factory=list, max_length=6)
    price_usd: float = Field(default=0, ge=0, le=listings.MAX_PRICE_USD)
    risk: str | None = Field(default=None, pattern="^(low|medium|high)$")
    payload: dict = Field(default_factory=dict)
    payout: dict = Field(default_factory=dict)


@router.post("/listings", dependencies=[Depends(limiter("listings", "rl_listings_per_day", 86_400))])
async def create_listing(req: ListingCreate, request: Request):
    seller, _ = await auth.resolve_account(request, req.seller_secret)
    try:
        row = await asyncio.to_thread(listings.create, req.model_dump(), seller)
    except listings.ListingError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"listing store unavailable: {exc}") from exc
    return {"item": listings.serialize(row, unlocked=True), "persistence": kvstore.mode()}


class SellerAuth(BaseModel):
    seller_secret: str | None = Field(default=None, min_length=16, max_length=128)


@router.post("/listings/mine")
async def my_listings(req: SellerAuth, request: Request):
    seller, _ = await auth.resolve_account(request, req.seller_secret)
    try:
        rows = await asyncio.to_thread(listings.seller_summary, seller)
    except Exception as exc:
        raise HTTPException(status_code=503, detail=f"listing store unavailable: {exc}") from exc
    return {"listings": rows, "persistence": kvstore.mode()}


@router.post("/listings/{listing_id}/remove")
async def remove_listing(listing_id: str, req: SellerAuth, request: Request):
    seller, _ = await auth.resolve_account(request, req.seller_secret)
    try:
        ok = await asyncio.to_thread(listings.remove, listing_id, seller)
    except listings.ListingError as exc:
        raise HTTPException(status_code=403, detail=str(exc)) from exc
    if not ok:
        raise HTTPException(status_code=404, detail="listing not found")
    return {"removed": listing_id}


@router.get("/listings/{listing_id}/payload")
async def listing_payload(listing_id: str, token: str | None = None):
    """Release a paid listing's payload against a signed entitlement."""
    row = listings.get(listing_id)
    if row is None:
        raise HTTPException(status_code=404, detail="listing not found")
    if row["price_usd"] > 0 and listings.verify_entitlement(token, listing_id) is None:
        raise HTTPException(status_code=402, detail="valid entitlement token required")
    return {"id": listing_id, "integration": listings.serialize(row, unlocked=True)["integration"]}
