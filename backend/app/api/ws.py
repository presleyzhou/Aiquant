import asyncio
import json
import logging

from fastapi import APIRouter, WebSocket, WebSocketDisconnect

from app.config import get_settings
from app.services.datasource import market_data

log = logging.getLogger(__name__)
router = APIRouter()


@router.websocket("/ws/quotes")
async def quotes_socket(websocket: WebSocket):
    """Push quote updates for a client-chosen watchlist.

    Protocol: the client sends `{"symbols": ["AAPL", "MSFT"]}` at any time to set
    or replace the watchlist; the server pushes `{"type": "quotes", "quotes": [...]}`
    on an interval. yfinance is not a streaming source, so this is polling on the
    server side — the point is that the browser holds one socket instead of N
    polling timers, and the quote cache collapses duplicate fetches across clients.
    """
    settings = get_settings()
    await websocket.accept()
    symbols: list[str] = []

    async def receive_loop():
        nonlocal symbols
        while True:
            payload = await websocket.receive_json()
            incoming = payload.get("symbols")
            if isinstance(incoming, list):
                symbols = [str(s).upper().strip() for s in incoming if str(s).strip()][:25]
                log.info("watchlist set to %s", symbols)

    async def push_loop():
        # The quote cache TTL (15s) outlives the push interval (5s), so most
        # polls return byte-identical data. Skip those frames: each one costs
        # the client a full quote-merge re-render for no new information.
        last_sent: str | None = None
        while True:
            if symbols:
                try:
                    quotes = await market_data.quotes(symbols)
                    frame = json.dumps(
                        {"type": "quotes", "quotes": quotes}, separators=(",", ":")
                    )
                    if frame != last_sent:
                        await websocket.send_text(frame)
                        last_sent = frame
                except Exception as exc:
                    await websocket.send_json({"type": "error", "message": str(exc)})
            await asyncio.sleep(settings.ws_poll_seconds)

    receiver = asyncio.create_task(receive_loop())
    pusher = asyncio.create_task(push_loop())
    try:
        done, pending = await asyncio.wait(
            {receiver, pusher}, return_when=asyncio.FIRST_EXCEPTION
        )
        for task in done:
            task.result()  # surface the exception that ended the connection
    except WebSocketDisconnect:
        pass
    except Exception:
        log.exception("quote socket closed on error")
    finally:
        for task in (receiver, pusher):
            task.cancel()
        await asyncio.gather(receiver, pusher, return_exceptions=True)
