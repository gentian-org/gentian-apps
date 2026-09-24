"""A person's own credentials, relayed to the credential manager.

The credential manager holds no authority of its own: every write takes the
caller's token and exchanges it for one OpenBao will accept, so what a person
may store is decided by their own identity rather than by a service acting for
them. This console holds neither its token nor OpenBao's — it passes the
person through, exactly as it does to the director.

Unset `CREDENTIAL_MANAGER_URL` answers 503 saying so, rather than guessing at
a host: a component that has not been told where something is has not been
told, and inventing an address would turn a configuration mistake into a
connection error somewhere else.
"""

from fastapi import APIRouter, Depends, Request, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/credentials", tags=["credentials"])
_bearer = HTTPBearer(auto_error=False)

# What the screen calls, and what the credential manager calls it. The console
# keeps the paths its screen already uses; the service keeps its own. A map
# rather than a prefix rewrite, so a path this console does not serve is a 404
# here instead of an unexpected request there.
_PATHS: dict[tuple[str, str], str] = {
    ("GET", ""): "/v1/credentials",
    ("GET", "backup-identity"): "/v1/backup-identity",
    ("PUT", "backup-identity"): "/v1/backup-identity",
    ("GET", "repositories/list"): "/v1/repositories",
}


def _upstream(method: str, rest: str) -> str | None:
    """The credential manager's path for one of the screen's."""
    if mapped := _PATHS.get((method, rest)):
        return mapped
    # The per-credential and per-repository routes are named by the thing
    # they act on, which the screen already URL-encodes.
    if method == "PUT" and rest and "/" not in rest:
        return f"/v1/credentials/{rest}"
    if rest.startswith("repositories/") and method in ("PUT", "DELETE"):
        return f"/v1/repositories/{rest.removeprefix('repositories/')}"
    return None


@router.api_route("", methods=["GET"])
@router.api_route("/{rest:path}", methods=["GET", "PUT", "DELETE"])
async def credentials(
    request: Request,
    rest: str = "",
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    path = _upstream(request.method, rest)
    if path is None:
        return Response(
            content='{"detail":"No such credentials route."}',
            status_code=404,
            media_type="application/json",
        )
    body = None
    if request.method in ("PUT", "POST"):
        raw = await request.body()
        if raw:
            import json

            body = json.loads(raw)
    return await director.forward_to(
        director.credential_manager_url(settings),
        request.method,
        path,
        bearer_of(credentials),
        json_body=body,
    )
