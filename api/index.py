"""Vercel serverless entry point.

Vercel's Python runtime serves any ASGI app exported as `app` from a file in
/api. This file just points it at the FastAPI application in backend/.

Two serverless-specific accommodations:

- HOME is forced to /tmp before anything imports: the vendored fincept logger
  and DataSourceManager write config under $HOME, and /tmp is the only
  writable path in a Vercel function. If a write still fails, the adapter in
  app.services.datasource degrades to the direct-yfinance path by design.

- WebSockets are not supported on Vercel functions, so /ws/quotes will never
  connect here. The frontend detects that and falls back to REST polling —
  see frontend/src/hooks/useQuoteStream.ts.
"""

import os
import sys

os.environ.setdefault("HOME", "/tmp")

sys.path.insert(0, os.path.join(os.path.dirname(__file__), "..", "backend"))

from app.main import app  # noqa: E402,F401
