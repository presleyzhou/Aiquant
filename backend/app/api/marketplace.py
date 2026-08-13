from fastapi import APIRouter, HTTPException, Query

from app.services import marketplace

router = APIRouter(prefix="/api/marketplace", tags=["marketplace"])


@router.get("/items")
async def list_items(
    type: str | None = Query(None, pattern="^(strategy|skill|data)$"),
    q: str | None = Query(None, max_length=80),
):
    items = marketplace.list_items(item_type=type, query=q)
    return {"count": len(items), "items": items}


@router.get("/items/{item_id}")
async def get_item(item_id: str):
    item = marketplace.get_item(item_id)
    if item is None:
        raise HTTPException(status_code=404, detail=f"no marketplace item {item_id!r}")
    return item
