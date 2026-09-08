"""Error reporting: log always, forward to Sentry when a DSN is configured.
Used at the seams that fail silently in production otherwise — KV writes,
payment webhooks, the scheduled recheck."""

from __future__ import annotations

import logging

log = logging.getLogger("aiquant.observe")


def capture(exc: BaseException, where: str, **context) -> None:
    log.warning("%s failed: %s %s", where, exc, context or "")
    try:
        import sentry_sdk

        if sentry_sdk.Hub.current.client is None:  # no DSN → nothing to send
            return
        with sentry_sdk.push_scope() as scope:
            scope.set_tag("where", where)
            for k, v in context.items():
                scope.set_extra(k, v)
            sentry_sdk.capture_exception(exc)
    except Exception as sentry_exc:  # sentry itself must never break the request
        log.debug("sentry capture skipped: %s", sentry_exc)
