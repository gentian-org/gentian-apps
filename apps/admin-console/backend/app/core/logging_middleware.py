"""Request logging with secret redaction (M7)."""

import logging
import re
from collections.abc import Awaitable, Callable

from starlette.middleware.base import BaseHTTPMiddleware
from starlette.requests import Request
from starlette.responses import Response

logger = logging.getLogger("gentian.access")

_REDACT_PATTERNS = (
    (re.compile(r"(authorization:\s*)([^\s,]+)", re.I), r"\1[REDACTED]"),
    (re.compile(r"(bearer\s+)([^\s]+)", re.I), r"\1[REDACTED]"),
    (re.compile(r"(password=)[^&\s]+", re.I), r"\1[REDACTED]"),
    (re.compile(r"(token=)[^&\s]+", re.I), r"\1[REDACTED]"),
)


def redact_sensitive(text: str) -> str:
    redacted = text
    for pattern, replacement in _REDACT_PATTERNS:
        redacted = pattern.sub(replacement, redacted)
    return redacted


class RedactingAccessLogMiddleware(BaseHTTPMiddleware):
    async def dispatch(
        self,
        request: Request,
        call_next: Callable[[Request], Awaitable[Response]],
    ) -> Response:
        auth_header = request.headers.get("authorization", "")
        safe_auth = "[REDACTED]" if auth_header else "-"
        logger.info(
            "%s %s auth=%s",
            request.method,
            request.url.path,
            safe_auth,
        )
        return await call_next(request)
