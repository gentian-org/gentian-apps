"""People, groups and the realm's password policy.

Every one of these is relayed to the director with the caller's own token.
This component holds no Keycloak credential and never has: the director holds
one per realm, and what a caller may do with it is decided by OpenFGA against
their token before the director touches anything.

That is the reversal S7A.17 makes, and it is worth stating plainly because the
screen it replaces said the opposite. People used to be managed in Keycloak's
own console, on the argument that a console holding an administrator
credential is a large thing to get wrong. The argument was right; the
conclusion was not. The credential moves to the one component that already
asks who is calling, rather than the screens moving to a console built for
realm engineers. Keycloak's console stays reachable as the detail view behind
the product view.

The writes are ACTIONS, not commits. Inviting somebody happens once and leaves
no declared state; people do not belong in an append-only history, which is the
whole reason they are not in git. The director spells that in the route
(`/actions/...`) and this module keeps the distinction visible rather than
flattening it into a REST-shaped PUT.
"""

from fastapi import APIRouter, Body, Depends, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/admin", tags=["people"])
_bearer = HTTPBearer(auto_error=False)


def _tenant(settings: Settings, tenant: str | None) -> str:
    return tenant or settings.tenant_id


@router.get("/people")
async def people(
    tenant: str | None = Query(default=None),
    search: str | None = Query(default=None),
    limit: int | None = Query(default=None, ge=1, le=200),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Who is in this tenant.

    `pending` is the field worth reading: somebody invited who has not set a
    password or verified their address is not yet a person who can sign in,
    and a list that showed them the same as everybody else would make a failed
    invitation invisible.
    """
    params: dict[str, str] = {}
    if search:
        params["search"] = search
    if limit:
        params["limit"] = str(limit)
    return await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{_tenant(settings, tenant)}/people",
        bearer_of(credentials),
        params=params or None,
    )


@router.get("/people/{person_id}")
async def person(
    person_id: str,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """One person and the groups they hold, within this tenant's scope."""
    return await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{_tenant(settings, tenant)}/people/{person_id}",
        bearer_of(credentials),
    )


@router.get("/groups")
async def groups(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """The groups this tenant may put somebody in.

    A tenant with its own realm sees its realm's groups. A tenant that shares
    the kernel realm sees only its own subtree — the director filters, because
    in a shared realm the credential is no longer the boundary.
    """
    return await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{_tenant(settings, tenant)}/groups",
        bearer_of(credentials),
    )


@router.get("/identity")
async def identity_settings(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """The realm's settings a tenant administrator may see.

    The password policy today, in Keycloak's own spelling. Passed through
    unparsed: the platform does not interpret it, and a parse here would have
    to be kept in step with a vocabulary Keycloak extends.
    """
    return await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{_tenant(settings, tenant)}/identity",
        bearer_of(credentials),
    )


@router.post("/people/invite")
async def invite(
    payload: dict = Body(...),
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Invite somebody by address.

    202 with `mailed: true` is the whole thing done. 202 with `mailed: false`
    means the person exists and the link did not go — the repair is to
    re-send, not to invite again, and the answer says so rather than reading
    as a failure that left nothing behind.
    """
    return await director.forward(
        settings,
        "POST",
        f"/v1/tenants/{_tenant(settings, tenant)}/actions/invite-person",
        bearer_of(credentials),
        json_body={"email": payload.get("email", ""), "groups": payload.get("groups", [])},
    )


@router.post("/people/membership")
async def set_membership(
    payload: dict = Body(...),
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Add or remove one person from one group.

    `member` is required and not defaulted. A request that did not say which
    way is ambiguous, and choosing for the caller is a change nobody asked
    for.
    """
    return await director.forward(
        settings,
        "POST",
        f"/v1/tenants/{_tenant(settings, tenant)}/actions/set-membership",
        bearer_of(credentials),
        json_body={
            "person": payload.get("person", ""),
            "group": payload.get("group", ""),
            "member": payload.get("member"),
        },
    )


@router.post("/identity/password-policy")
async def set_password_policy(
    payload: dict = Body(...),
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Set the realm's password policy.

    A different relation from the rest of this module: can_set_policy rather
    than can_manage_users, because this is a statement about the tenant rather
    than about a person. The director decides that; this only relays.
    """
    return await director.forward(
        settings,
        "POST",
        f"/v1/tenants/{_tenant(settings, tenant)}/actions/set-password-policy",
        bearer_of(credentials),
        json_body={"passwordPolicy": payload.get("passwordPolicy")},
    )
