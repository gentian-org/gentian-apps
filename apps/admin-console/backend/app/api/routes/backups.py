"""Backups, as the director answers for them.

What exists, what each run did, which policy is in force once a tenant's is
resolved against the cluster's, and when the next scheduled run is — all of it
is cluster state the backup reconcilers hold, relayed by the director to
whoever may view the tenant. The console recomputes nothing: inheritance is
resolved once, by the reconciler that applies it, and read here.

Three kinds of call, and the routes say which:

    GET  ...                a READ of state — what is.
    PUT/DELETE <resource>   a WRITE of declared state — what should be true
                            from now on. Answers a commit: 202 with one, or
                            200 "unchanged". Git has it; the cluster does not
                            yet, and the screen says so rather than claiming
                            a save.
    POST .../actions/x      an ACTION — something that happens once, now.
                            Answers what was started. There is no commit,
                            because nothing was declared.

A backup policy is the second kind: where bundles go, how often, how long they
are kept, whose key opens them. Taking a backup is the third: it happens at a
moment somebody chose, and writing it into git would leave an object there
that has already finished.
"""

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/admin", tags=["backups"])
_bearer = HTTPBearer(auto_error=False)

# The one schedule the BackupPolicy reconciler owns per tenant. It restates it
# from the policy on every pass, so it is the policy that has to change.
MANAGED_SCHEDULE = "policy"


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


# ── Writes of declared state ────────────────────────────────────────────────


@router.put("/backup-policy")
async def set_backup_policy(
    body: dict,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """What should be true of this tenant's backups from now on. 202 with a
    commit means git has it and Argo CD applies it on the next sync."""
    return await director.forward(
        settings,
        "PUT",
        f"/v1/tenants/{_tenant(settings, tenant)}/backup-policy",
        bearer_of(credentials),
        json_body=body,
    )


@router.delete("/backup-policy")
async def clear_backup_policy(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Stop stating one, which is how a tenant goes back to inheriting the
    cluster's. There is no "inherit" value to send: a tenant inherits by
    saying nothing."""
    return await director.forward(
        settings,
        "DELETE",
        f"/v1/tenants/{_tenant(settings, tenant)}/backup-policy",
        bearer_of(credentials),
    )


@router.put("/backup-policy/cluster")
async def set_cluster_backup_policy(
    body: dict,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """The cluster's own, which every tenant's is resolved against. Needs
    can_configure on the cluster, so a tenant administrator is refused."""
    return await director.forward(
        settings,
        "PUT",
        f"/v1/clusters/{director.cluster(settings)}/backup-policy",
        bearer_of(credentials),
        json_body=body,
    )


# ── Actions ─────────────────────────────────────────────────────────────────


@router.post("/backups")
async def take_backup(
    body: dict,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Take one now. The answer says what was started, not what was saved."""
    return await director.forward(
        settings,
        "POST",
        f"/v1/tenants/{_tenant(settings, tenant)}/actions/backup",
        bearer_of(credentials),
        json_body=body,
    )


@router.delete("/backups/{name}")
async def delete_backup(
    name: str,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Remove one run's record. Also an action: what happens to the bundle in
    storage is the retention policy's answer, and nothing the tenant declares
    changes."""
    return await director.forward(
        settings,
        "POST",
        f"/v1/tenants/{_tenant(settings, tenant)}/actions/delete-backup",
        bearer_of(credentials),
        json_body={"name": name},
    )


@router.put("/backup-schedules/{name}")
async def set_backup_schedule(
    name: str,
    body: dict,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Change the schedule by changing the policy it comes from.

    The operator derives one schedule per tenant from the backup policy and
    restates it on every reconcile, so editing the schedule object directly
    does not hold — it is reverted within the minute, which looks like the
    save failing at random. So this writes the policy instead: the same
    three fields, at the place that decides them.

    A schedule that is not the derived one would be somebody's own, and
    nothing creates those today; changing one is refused rather than
    silently redirected into the policy.
    """
    if name != MANAGED_SCHEDULE:
        raise HTTPException(
            status_code=400,
            detail=(
                f"Only the {MANAGED_SCHEDULE!r} schedule is managed here, and it is derived "
                "from the backup policy. Change the policy instead."
            ),
        )
    policy: dict = {}
    if schedule := body.get("schedule"):
        policy["schedule"] = schedule
    if body.get("suspended"):
        policy["suspendSchedule"] = True
    if retention := body.get("retention"):
        policy["retention"] = retention
    if encryption := body.get("encryption"):
        # The policy states recipients; "platform" means none of its own.
        recipients = encryption.get("recipients") or []
        if encryption.get("mode") == "own" and recipients:
            policy["encryption"] = {"recipients": recipients}
    return await director.forward(
        settings,
        "PUT",
        f"/v1/tenants/{_tenant(settings, tenant)}/backup-policy",
        bearer_of(credentials),
        json_body=policy,
    )


@router.delete("/backup-schedules/{name}")
async def clear_backup_schedule(
    name: str,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Stop the derived schedule, which is the policy suspending it. The
    object itself would be recreated on the next reconcile."""
    if name != MANAGED_SCHEDULE:
        raise HTTPException(
            status_code=400,
            detail=f"Only the {MANAGED_SCHEDULE!r} schedule is managed here.",
        )
    return await director.forward(
        settings,
        "PUT",
        f"/v1/tenants/{_tenant(settings, tenant)}/backup-policy",
        bearer_of(credentials),
        json_body={"suspendSchedule": True},
    )
