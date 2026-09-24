"""A tenant's resources, as the director answers for them.

The Resources screen shows the ceiling the cluster enforces for a tenant, what
is committed under it, the plans it may move to, and its history, and lets
whoever may set the plan choose one. Every route here relays to the director
as the caller. The director reads the cluster's answers from the operator and
decides from the authorization graph whether this person may see them; the
one write, choosing a plan, is a commit the director makes as the person, and
the operator learns the plan from git like every other change to a tenant.

Which tenant is asked is the screen's choice: a tenant administrator's own,
or, for a platform operator managing from the cluster's view, any tenant of
the cluster. The console does not check that choice; the director does, and
its refusal comes back as the refusal it is.
"""

from fastapi import APIRouter, Depends, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/admin/resources", tags=["resources"])
_bearer = HTTPBearer(auto_error=False)


def _tenant_path(settings: Settings, tenant: str | None, suffix: str = "") -> str:
    return f"/v1/tenants/{tenant or settings.tenant_id}/resources{suffix}"


@router.get("")
async def resource_state(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """The tenant's ceiling, what is under it, and the plan it is on."""
    return await director.forward(
        settings, "GET", _tenant_path(settings, tenant), bearer_of(credentials)
    )


@router.get("/plans")
async def resource_plans(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """The catalogue as it applies to this tenant and this person. Whether the
    person chooses for themselves or for the cluster is the director's call,
    made from the graph; the screen asserts nothing about it."""
    answer = await director.forward(
        settings, "GET", _tenant_path(settings, tenant, "/plans"), bearer_of(credentials)
    )
    return director.unwrapped(answer, "plans")


@router.put("")
async def change_resource_plan(
    body: dict,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Choose a plan. 202 with a commit means git has it and the cluster does
    not yet; 200 means the tenant is on that plan already. A plan the tenant
    does not fit under is 409, one it is not entitled to 402, and forcing
    past the guard is refused for anyone who may not configure the cluster."""
    return await director.forward(
        settings, "PUT", _tenant_path(settings, tenant), bearer_of(credentials), json_body=body
    )


@router.get("/usage")
async def resource_usage(
    tenant: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    stepSeconds: int | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    params = {
        k: str(v)
        for k, v in {"from": from_, "to": to, "stepSeconds": stepSeconds}.items()
        if v is not None
    }
    return await director.forward(
        settings,
        "GET",
        _tenant_path(settings, tenant, "/usage"),
        bearer_of(credentials),
        params=params,
    )


@router.get("/report")
async def resource_report(
    tenant: str | None = Query(default=None),
    from_: str | None = Query(default=None, alias="from"),
    to: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    params = {k: v for k, v in {"from": from_, "to": to}.items() if v is not None}
    return await director.forward(
        settings,
        "GET",
        _tenant_path(settings, tenant, "/report"),
        bearer_of(credentials),
        params=params,
    )


@router.get("/tenants")
async def tenant_resource_states(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Every tenant's ceiling side by side, for the cluster's view. The
    director lists the tenants from git and asks the operator about each."""
    answer = await director.forward(
        settings,
        "GET",
        f"/v1/clusters/{director.cluster(settings)}/resources",
        bearer_of(credentials),
    )
    return director.unwrapped(answer, "tenants")
