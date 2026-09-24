"""Notices an administrator publishes to the people of a tenant.

Read on the desktop, which owns the table they live in — `admin_notifications`
in the tenant's own database. The console keeps no copy: two stores would mean
a notice that exists in one and not the other. The operator writes into the
desktop's table, because it already resolves that database for the usage
history, and relays through the director like everything else here.

Reading is a read of state. Publishing is an ACTION: it happens once, nothing
reconciles it, and the answer says what was published rather than what was
committed, because nothing was.
"""

from fastapi import APIRouter, Depends, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/admin", tags=["notifications"])
_bearer = HTTPBearer(auto_error=False)


@router.get("/notifications")
async def notifications(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """What has been said to this tenant's people.

    503 means the desktop has not created its table yet — it will work once
    the desktop has started, and nothing is broken. An empty list would have
    read as "nothing was ever said", which is a different thing.
    """
    answer = await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{tenant or settings.tenant_id}/notifications",
        bearer_of(credentials),
    )
    return director.unwrapped(answer, "notifications")


@router.post("/notifications")
async def publish_notification(
    body: dict,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Say something to them. The publisher is recorded: a notice nobody can
    ask about is worse than none."""
    return await director.forward(
        settings,
        "POST",
        f"/v1/tenants/{tenant or settings.tenant_id}/actions/notify",
        bearer_of(credentials),
        json_body=body,
    )
