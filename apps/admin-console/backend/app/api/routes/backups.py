"""Backups, as the director answers for them.

What exists, what each run did, which policy is in force once a tenant's is
resolved against the cluster's, and when the next scheduled run is — all of it
is cluster state the backup reconcilers hold, relayed by the director to
whoever may view the tenant. The console recomputes nothing: inheritance is
resolved once, by the reconciler that applies it, and read here.

Reads only for now. Changing a policy is a commit to the deployments
repository, the way a resource plan is, and taking a backup now is an action
rather than a piece of declared state; neither has a director endpoint yet, so
both still answer 501 naming the screen.
"""

from fastapi import APIRouter, Depends, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/admin", tags=["backups"])
_bearer = HTTPBearer(auto_error=False)


def _tenant(settings: Settings, tenant: str | None) -> str:
    return tenant or settings.tenant_id


@router.get("/backups")
async def backups(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    answer = await director.forward(
        settings, "GET", f"/v1/tenants/{_tenant(settings, tenant)}/backups", bearer_of(credentials)
    )
    return director.unwrapped(answer, "backups")


@router.get("/backups/{name}")
async def backup(
    name: str,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    return await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{_tenant(settings, tenant)}/backups/{name}",
        bearer_of(credentials),
    )


@router.get("/backup-policy/cluster")
async def cluster_backup_policy(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """The cluster's own policy, which every tenant's is resolved against.
    Read under can_audit, so a tenant administrator is refused it."""
    return await director.forward(
        settings,
        "GET",
        f"/v1/clusters/{director.cluster(settings)}/backup-policy",
        bearer_of(credentials),
    )


@router.get("/backup-policy")
async def backup_policy(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """One tenant's policy. `configured: false` means it states nothing of its
    own and inherits, and the effective values say what that comes to."""
    return await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{_tenant(settings, tenant)}/backup-policy",
        bearer_of(credentials),
    )


@router.get("/backup-schedules")
async def backup_schedules(
    tenant: str | None = Query(default=None),
    allTenants: bool = Query(default=False),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    if allTenants:
        answer = await director.forward(
            settings,
            "GET",
            f"/v1/clusters/{director.cluster(settings)}/backup-schedules",
            bearer_of(credentials),
        )
    else:
        answer = await director.forward(
            settings,
            "GET",
            f"/v1/tenants/{_tenant(settings, tenant)}/backup-schedules",
            bearer_of(credentials),
        )
    return director.unwrapped(answer, "schedules")
