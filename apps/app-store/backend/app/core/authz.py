"""Authorization helpers (OpenFGA / AuthZEN PEP)."""

from typing import Any, Callable

from fastapi import Depends, HTTPException, status

from app.core.auth import get_current_user
from app.core.config import Settings, get_settings
from app.core.openfga_client import OpenFGAClient


def _user_subject(user: dict[str, Any]) -> str:
    return str(user.get("sub") or user.get("preferred_username") or "")


async def check_permission(
    *,
    user: dict[str, Any],
    relation: str,
    object_type: str,
    object_id: str,
    settings: Settings,
) -> None:
    client = OpenFGAClient(settings)
    allowed = await client.check(
        user=_user_subject(user),
        relation=relation,
        object_type=object_type,
        object_id=object_id,
    )
    if not allowed:
        raise HTTPException(status_code=status.HTTP_403_FORBIDDEN, detail="Forbidden")


def require_permission(
    relation: str,
    object_type: str,
    object_id: str,
) -> Callable[..., Any]:
    """Dependency factory for route-level ReBAC checks (M22)."""

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
