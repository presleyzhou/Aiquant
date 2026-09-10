"""Front-end ↔ back-end contract: every `/api/...` path the React client (or
the Playwright mocks) references must be served by the FastAPI app with the
HTTP method the client uses. Catches the classic drift where a route is
renamed on one side only — a class of bug the unit suites on either side
cannot see.

The scan is textual on purpose (no TypeScript toolchain in the Python CI):
string and template literals containing `/api/` are collected, `${…}`
interpolations become path parameters, query strings are dropped, and the
`method:` of the enclosing fetch call is read from the following ~400 chars.
"""

from __future__ import annotations

import re
from pathlib import Path

import pytest

from app.main import app

ROOT = Path(__file__).resolve().parents[2]
API_TS = ROOT / "frontend" / "src" / "api.ts"
AUTH_TS = ROOT / "frontend" / "src" / "auth.ts"
E2E = ROOT / "frontend" / "e2e" / "smoke.spec.ts"

pytestmark = pytest.mark.skipif(not API_TS.exists(), reason="frontend sources not checked out")

_LITERAL = re.compile(r"(`/api/[^`]*`|\"/api/[^\"]*\"|'/api/[^']*')")
_METHOD = re.compile(r"method:\s*\"(GET|POST|PUT|PATCH|DELETE)\"")


def _backend_routes() -> list[tuple[re.Pattern[str], set[str], str]]:
    """(compiled path regex, methods, template) for every HTTP route."""
    out = []
    for template, ops in app.openapi()["paths"].items():
        regex = "^" + re.sub(r"\{[^}]+\}", r"[^/]+", template) + "$"
        out.append((re.compile(regex), {m.upper() for m in ops}, template))
    return out


def _normalise(literal: str) -> str:
    body = literal[1:-1]
    # nested template literal inside `${…}` (e.g. `${interval ? `&interval=${interval}` : ""}`) — cut at the first `${`
    # that opens a query-string branch; the path part is what matters
    body = body.split("?", 1)[0]
    body = re.sub(r"\$\{[^}]*\}", "{p}", body)
    body = body.split("${", 1)[0]  # unbalanced nested template
    body = re.sub(r"(?<=[^/])\{p\}$", "", body)  # `…/items${suffix}` — a glued suffix is a query string, not a segment
    return body.rstrip("/") or "/"


def _frontend_calls(text: str) -> list[tuple[str, str, str]]:
    """(path, method, raw literal) for each fetch-like call."""
    calls = []
    matches = list(_LITERAL.finditer(text))
    for i, m in enumerate(matches):
        lit = m.group(1)
        end = matches[i + 1].start() if i + 1 < len(matches) else len(text)
        window = text[m.end(): min(end, m.end() + 400)]
        # stop at the next call so we don't read a neighbour's method (fetch / authFetch / streamNDJSON)
        nxt = re.search(r"fetch\(|streamNDJSON\(", window, flags=re.I)
        if nxt:
            window = window[: nxt.start()]
        before = text[max(0, m.start() - 60): m.start()]
        if "streamNDJSON(" in before:
            method = "POST"  # NDJSON streaming helper always POSTs a JSON body
        else:
            mm = _METHOD.search(window)
            method = mm.group(1) if mm else "GET"
        calls.append((_normalise(lit), method, lit))
    return calls


def _match(path: str, method: str, routes) -> tuple[bool, bool]:
    """(path known, method allowed)."""
    known = False
    for rx, methods, _ in routes:
        if rx.match(path):
            known = True
            if method in methods:
                return True, True
    return known, False


def test_every_frontend_api_path_exists_with_the_right_method():
    routes = _backend_routes()
    text = API_TS.read_text() + "\n" + (AUTH_TS.read_text() if AUTH_TS.exists() else "")
    calls = _frontend_calls(text)
    assert len(calls) >= 40, "scanner found suspiciously few API calls — regex drift?"
    missing, wrong_method = [], []
    for path, method, lit in calls:
        known, ok = _match(path, method, routes)
        if not known:
            missing.append(f"{method} {path}   ← {lit}")
        elif not ok:
            wrong_method.append(f"{method} {path}   ← {lit}")
    assert not missing, "frontend calls paths the backend does not serve:\n" + "\n".join(missing)
    assert not wrong_method, "frontend uses a method the backend route does not accept:\n" + "\n".join(wrong_method)


def test_e2e_mocks_only_mock_real_routes():
    """The Playwright mock router pins paths with `path === "/api/…"` and
    `path.startsWith("/api/…")`; a mock for a route that no longer exists
    would keep the E2E suite green while production 404s."""
    if not E2E.exists():
        pytest.skip("e2e spec not checked out")
    routes = _backend_routes()
    text = E2E.read_text()
    exact = set(re.findall(r'path === "(/api/[^"]+)"', text))
    prefixes = set(re.findall(r'path\.startsWith\("(/api/[^"]+)"\)', text))
    exact |= set(re.findall(r'page\.route\("\*\*(/api/[^"*]+)"', text))
    bad = [p for p in sorted(exact) if not _match(p.split("?")[0].rstrip("/"), "GET", routes)[0]
           and not _match(p.split("?")[0].rstrip("/"), "POST", routes)[0]]
    templates = [t for _, _, t in routes]

    def prefix_ok(prefix: str) -> bool:
        if prefix.startswith("/api/fake-"):
            return True  # stand-in for an external host (Supabase) — not our route table
        segs = prefix.rstrip("/").split("/")
        for t in templates:
            ts = t.split("/")
            if len(ts) >= len(segs) and all(b.startswith("{") or a == b for a, b in zip(segs, ts, strict=False)):
                return True
        return False

    bad_prefix = [p for p in sorted(prefixes) if not prefix_ok(p)]
    assert not bad, "E2E mocks paths the backend no longer serves:\n" + "\n".join(bad)
    assert not bad_prefix, "E2E mocks prefixes the backend no longer serves:\n" + "\n".join(bad_prefix)


def test_websocket_quote_stream_path_matches():
    hook = ROOT / "frontend" / "src" / "hooks" / "useQuoteStream.ts"
    if not hook.exists():
        pytest.skip("hook not checked out")
    used = re.search(r"\}/(ws/[a-z_]+)`", hook.read_text())
    assert used, "could not find the WebSocket path in useQuoteStream.ts"
    ws_paths = set()

    def walk(routes):
        for r in routes:
            inner = getattr(r, "original_router", None)  # FastAPI ≥0.140 wraps included routers
            if inner is not None:
                walk(inner.routes)
            elif hasattr(r, "routes"):
                walk(r.routes)
            elif type(r).__name__ in {"APIWebSocketRoute", "WebSocketRoute"}:
                ws_paths.add(r.path)
    walk(app.routes)
    assert f"/{used.group(1)}" in ws_paths, (used.group(1), ws_paths)
