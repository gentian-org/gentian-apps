"""The caller's roles on this app, as the platform says them.

The token the front door hands on (exchangeToken in the profile) carries the
roles the person holds on this app in the claim gentian_app_roles, in the
platform's names: user, admin, the roles the profile declares in
spec.roles.declared, and <add-on>/<role> for an add-on's. Who holds which is
decided in the platform's rights store, by the positions a tenant's
administrator gives; the app reads the claim and grants nothing itself.

A role given or taken reaches the app with the person's next token: taking
one ends their sessions, so they sign in again with what they hold now.
"""

from collections.abc import Callable
from typing import Any

from fastapi import Depends, HTTPException, status

from app.core.auth import get_current_user
from app.core.config import Settings, get_settings


def roles_of(user: dict[str, Any], settings: Settings) -> set[str]:
    """The roles the token names; none when it names none."""
    if settings.auth_disabled:
        # Local development only: the stand-in caller holds every role.
        return {"user", "admin"}
    claim = user.get(settings.roles_claim)
    if not isinstance(claim, list):
        return set()
    return {role for role in claim if isinstance(role, str)}


def require_role(*roles: str) -> Callable[..., Any]:
    """A dependency that admits a caller holding any of roles, and refuses
    everyone else with 403. admin holds every declared role on the platform's
    side, so require_role("editor") admits an administrator too, as the claim
    names both."""

    async def _dependency(
        user: dict[str, Any] = Depends(get_current_user),
        settings: Settings = Depends(get_settings),
    ) -> dict[str, Any]:
        if not roles_of(user, settings) & set(roles):
            raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")
        return user

    return _dependency
