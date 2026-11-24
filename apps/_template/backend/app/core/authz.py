"""Per-record checks in this app's own authorization store.

Only for an app that decides per record (who may see which project) and so
declares requires.services.authorization with a model of its own. The
platform then writes the Secret authorization-<component> with
AUTHORIZATION_URL and AUTHORIZATION_KEY, and the app asks the arbiter, never
OpenFGA itself: the arbiter speaks OpenFGA's API with the store and model
taken from the key.

People are user:<realm>/<subject>, the form the platform writes role holders
in when the profile says roles: handOver (user:<realm>/<sub> holder
role:<name>), so a model can give objects to role:<name>#holder.

The check fails closed. No store configured, an arbiter that cannot be
reached, or an answer that is not a clear yes is a refusal: a check that
passed whenever it could not ask would be no check. An app that needs only
user and admin, or roles the profile declares, reads them from the token
instead (app.core.roles.require_role) and needs no store.
"""

from collections.abc import Callable
from typing import Any

import httpx
from fastapi import Depends, HTTPException, status

from app.core.auth import get_current_user
from app.core.config import Settings, get_settings


def subject_of(user: dict[str, Any]) -> str:
    """The person as the store knows them: user:<realm>/<subject>.

    The realm is the last part of the token's issuer (…/realms/<realm>). A
    subject's ':' is written '/', as the platform writes it. A token that
    names no realm or subject has no subject here, and is refused.
    """
    issuer = str(user.get("iss") or "")
    _, found, realm = issuer.rstrip("/").rpartition("/realms/")
    sub = str(user.get("sub") or "")
    if not found or not realm or "/" in realm or not sub or any(c in sub for c in "#/ \t\r\n"):
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
    return f"user:{realm}/{sub.replace(':', '/')}"


async def check_permission(
    *,
    user: dict[str, Any],
    relation: str,
    object_type: str,
    object_id: str,
    settings: Settings,
) -> None:
    """Refuse with 403 unless the store says the caller has relation on the
    object; 503 when there is no store to ask or it cannot be asked."""
    if not (settings.authorization_url and settings.authorization_key):
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="No authorization store is configured for this app",
        )
    payload = {
        "tuple_key": {
            "user": subject_of(user),
            "relation": relation,
            "object": f"{object_type}:{object_id}",
        }
    }
    try:
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(
                f"{settings.authorization_url.rstrip('/')}/v1/check",
                json=payload,
                headers={"Authorization": f"Bearer {settings.authorization_key}"},
            )
            resp.raise_for_status()
            allowed = resp.json().get("allowed") is True
    except (httpx.HTTPError, ValueError) as exc:
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail="The authorization store could not be asked",
        ) from exc
    if not allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def require_permission(
    relation: str,
    object_type: str,
    object_id: str,
) -> Callable[..., Any]:
    """Dependency factory for a route-level check on one fixed object."""

    async def _dependency(
        user: dict[str, Any] = Depends(get_current_user),
        settings: Settings = Depends(get_settings),
    ) -> dict[str, Any]:
        await check_permission(
            user=user,
            relation=relation,
            object_type=object_type,
            object_id=object_id,
            settings=settings,
        )
        return user

    return _dependency
