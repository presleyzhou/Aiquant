from fastapi import APIRouter, Depends, HTTPException
from pydantic import BaseModel, Field

from app.services import payments, wallet
from app.services.ratelimit import limiter

router = APIRouter(prefix="/api/wallet", tags=["wallet"])


class Account(BaseModel):
    account_secret: str = Field(min_length=16, max_length=128)


@router.post("")
async def balance(req: Account):
    try:
        return wallet.view(wallet.account_hash(req.account_secret))
    except wallet.WalletError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class TopUp(Account):
    amount_usd: float = Field(ge=wallet.MIN_TOPUP_USD, le=wallet.MAX_TOPUP_USD)
    method: str = Field(pattern="^(card|crypto)$")
    return_url: str | None = Field(default=None, max_length=400)


@router.post("/topup", dependencies=[Depends(limiter("checkout", "rl_checkout_per_hour", 3600))])
async def topup(req: TopUp):
    try:
        return await payments.create_topup(req.amount_usd, req.method, req.account_secret, req.return_url)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # provider/network failure
        raise HTTPException(status_code=502, detail=f"payment provider error: {exc}") from exc


class DemoTopUp(Account):
    amount_usd: float = Field(ge=wallet.MIN_TOPUP_USD, le=wallet.MAX_TOPUP_USD)


@router.post("/topup/demo/{order_id}/confirm")
async def confirm_demo_topup(order_id: str, req: DemoTopUp):
    try:
        return payments.confirm_demo_topup(order_id, req.account_secret, req.amount_usd)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class Purchase(Account):
    item_id: str = Field(min_length=1, max_length=64)


@router.post("/purchase")
async def purchase(req: Purchase):
    try:
        return payments.purchase_with_wallet(req.item_id, req.account_secret)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


class Withdraw(Account):
    amount_usd: float = Field(ge=1, le=100_000)
    method: str = Field(pattern="^(crypto|bank)$")
    address: str = Field(min_length=6, max_length=160)


@router.post("/withdraw", dependencies=[Depends(limiter("withdraw", "rl_listings_per_day", 86_400))])
async def withdraw(req: Withdraw):
    try:
        return wallet.request_withdrawal(wallet.account_hash(req.account_secret), req.amount_usd, req.method, req.address)
    except wallet.WalletError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
