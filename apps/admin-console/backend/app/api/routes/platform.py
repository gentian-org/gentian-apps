"""Integrations, platform security, and how much customisation is carried.

Three screens, all reads, all relayed from the director. What an app may
consume from another, what the cluster permits to escape its default security
posture, and which carried changes want attention are each computed by the
operator from the CRs it reconciles — not here, and not by the screen, because
a second implementation of any of them is a second answer to the same
question.

The writes are commits. Changing what an app may consume is declared state,
committed under `can_grant`; changing which waivers the platform permits is
the cluster's own security configuration, committed under `can_set_admission`
— which model v1 binds to break-glass, so an ordinary platform administrator
is refused it. That refusal is correct and the screen should say so: letting
an app out of the pod-security baseline is meant to cost a deliberate
elevation.
"""

from fastapi import APIRouter, Depends, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/admin", tags=["platform"])
_bearer = HTTPBearer(auto_error=False)


@router.get("/integrations")
async def integrations(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """What this tenant's apps consume from each other.

    `effectiveAccess` is the join worth reading: for each binding, what it
    asks for against what the grant permits, with anything ungranted named.
    A binding asking for more than its grant will not do what its author
    expected, and nothing else reports that.
    """
    return await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{tenant or settings.tenant_id}/integrations",
        bearer_of(credentials),
    )


@router.get("/platform/security-policy")
async def platform_security_policy(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """What the cluster permits to escape its default posture, and what the
    catalogue asks of it. The difference between the two lists is the point:
    a profile asking for something not permitted is refused at deploy time,
    and seeing that before installing beats finding out afterwards."""
    return await director.forward(
        settings,
        "GET",
        f"/v1/clusters/{director.cluster(settings)}/platform-security",
        bearer_of(credentials),
    )


@router.get("/platform/customization-debt")
async def customization_debt(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """How much the cluster is carrying above stock, and which of it wants
    attention. L0 is "we changed nothing" and is not counted as carried."""
    return await director.forward(
        settings,
        "GET",
        f"/v1/clusters/{director.cluster(settings)}/customizations",
        bearer_of(credentials),
    )


@router.put("/grants/{app}")
async def set_grant(
    app: str,
    body: dict,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """A WRITE of declared state: what this app may consume, and which apps
    may consume from it. Answers a commit."""
    return await director.forward(
        settings,
        "PUT",
        f"/v1/tenants/{tenant or settings.tenant_id}/grants/{app}",
        bearer_of(credentials),
        json_body=body,
    )


@router.delete("/grants/{app}")
async def clear_grant(
    app: str,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Withdraw everything it permitted."""
    return await director.forward(
        settings,
        "DELETE",
        f"/v1/tenants/{tenant or settings.tenant_id}/grants/{app}",
        bearer_of(credentials),
    )


@router.put("/platform/security-policy")
async def set_platform_security_policy(
    body: dict,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Which waivers the cluster permits. Needs `can_set_admission`, which is
    break-glass: a 403 here means the caller has not elevated, not that the
    screen is broken."""
    return await director.forward(
        settings,
        "PUT",
        f"/v1/clusters/{director.cluster(settings)}/platform-security",
        bearer_of(credentials),
        json_body=body,
    )
