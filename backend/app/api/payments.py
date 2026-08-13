from fastapi import APIRouter, HTTPException
from pydantic import BaseModel

from app.services import payments

router = APIRouter(prefix="/api/payments", tags=["payments"])


@router.get("/config")
async def get_config():
    return payments.config()


class CreateChargeRequest(BaseModel):
    item_id: str


@router.post("/charges")
async def create_charge(req: CreateChargeRequest):
    try:
        return await payments.create_charge(req.item_id)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    except Exception as exc:  # provider/network failure
        raise HTTPException(status_code=502, detail=f"payment provider error: {exc}") from exc


@router.get("/charges/{charge_id}")
async def get_charge(charge_id: str):
    try:
        return await payments.charge_status(charge_id)
    except payments.PaymentError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except Exception as exc:
        raise HTTPException(status_code=502, detail=f"payment provider error: {exc}") from exc
