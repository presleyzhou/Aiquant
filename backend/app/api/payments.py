from fastapi import APIRouter, Depends, HTTPException, Request
from pydantic import BaseModel, Field

from app.services import payments
from app.services.ratelimit import limiter

router = APIRouter(prefix="/api/payments", tags=["payments"])


@router.get("/config")
async def get_config():
    return payments.config()


class CheckoutRequest(BaseModel):
    item_id: str = Field(min_length=1, max_length=64)
    method: str = Field(pattern="^(card|crypto)$")
    return_url: str | None = Field(default=None, max_length=400)


@router.post("/checkout", dependencies=[Depends(limiter("checkout", "rl_checkout_per_hour", 3600))])
async def checkout(req: CheckoutRequest):
    try:
        return await payments.create_checkout(req.item_id, req.method, req.return_url)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # provider/network failure
        raise HTTPException(status_code=502, detail=f"payment provider error: {exc}") from exc


@router.get("/orders/{provider}/{order_id}")
async def order(provider: str, order_id: str, item_id: str | None = None):
    try:
        return await payments.order_status(provider, order_id, item_id)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"payment provider error: {exc}") from exc


class DemoConfirm(BaseModel):
    item_id: str = Field(min_length=1, max_length=64)


@router.post("/orders/demo/{order_id}/confirm")
async def confirm_demo(order_id: str, req: DemoConfirm):
    try:
        return payments.confirm_demo(order_id, req.item_id)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@router.post("/webhooks/stripe")
async def stripe_webhook(request: Request):
    payload = await request.body()
    if not payments.verify_stripe_signature(payload, request.headers.get("stripe-signature")):
        raise HTTPException(status_code=400, detail="invalid signature")
    return {"result": payments.handle_stripe_event(await request.json())}


@router.post("/webhooks/coinbase")
async def coinbase_webhook(request: Request):
    payload = await request.body()
    if not payments.verify_coinbase_signature(payload, request.headers.get("x-cc-webhook-signature")):
        raise HTTPException(status_code=400, detail="invalid signature")
    return {"result": payments.handle_coinbase_event(await request.json())}


class ConnectRequest(BaseModel):
    email: str | None = Field(default=None, max_length=120)
    return_url: str | None = Field(default=None, max_length=400)


@router.post("/connect/onboard", dependencies=[Depends(limiter("connect", "rl_listings_per_day", 86_400))])
async def connect_onboard(req: ConnectRequest):
    try:
        return await payments.connect_onboard(req.email, req.return_url)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"payment provider error: {exc}") from exc


@router.get("/connect/{account_id}")
async def connect_status(account_id: str):
    try:
        return await payments.connect_status(account_id)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"payment provider error: {exc}") from exc


# ----------------------------------------------------------------- legacy


class CreateChargeRequest(BaseModel):
    item_id: str


@router.post("/charges")
async def create_charge(req: CreateChargeRequest):
    try:
        return await payments.create_charge(req.item_id)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"payment provider error: {exc}") from exc


@router.get("/charges/{charge_id}")
async def get_charge(charge_id: str):
    try:
        return await payments.charge_status(charge_id)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"payment provider error: {exc}") from exc
