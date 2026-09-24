"""The console's own context, and an honest answer for every screen that is
not yet a client of the director.

Context
-------
Which screens exist for this person is decided from two answers of the
director: the tenant's verbs, asked on the tenant this console runs in, and
the cluster's verbs. Nothing here reads a group out of a token. The tenant is
the one the platform put this component in, which is the only tenant this
console administers; a platform administrator reaching into another tenant
does so through that tenant's own console, never through this process.

Screens not yet mapped
----------------------
The console was carved out of the desktop, where its screens reached Keycloak
and Kubernetes through the desktop's backend with credentials this component
must not hold. Each screen is being re-pointed at the director one at a time.
Until a screen's director endpoints exist, the route it calls is answered 501
with a message naming the screen, so the console shows exactly that rather
than a spinner or a fabricated empty state. The table below is the list of
what is left; a screen leaves it by getting a real route above it.
"""

from fastapi import APIRouter, Depends, HTTPException, Request
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer
from pydantic import BaseModel

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/admin", tags=["admin"])
_bearer = HTTPBearer(auto_error=False)


class AdminContextResponse(BaseModel):
    tenant: str
    realm: str
    isPlatformAdmin: bool
    isTenantAdmin: bool
    availableTenants: list[str]
    kernelDomain: str
    # Kept for the screens that read it. People are managed in Keycloak's own
    # console, which this component links to; it holds no store of its own.
    storeConfigured: bool = True


async def _relations(settings: Settings, path: str, token: str) -> dict[str, bool]:
    answer = await director.forward(settings, "GET", path, token)
    if answer.status_code != 200:
        raise HTTPException(
            status_code=answer.status_code, detail=answer.body.decode() or "the director refused"
        )
    import json

    body = json.loads(answer.body)
    relations = body.get("relations") or {}
    return {k: bool(v) for k, v in relations.items()}


@router.get("/context", response_model=AdminContextResponse)
async def admin_context(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> AdminContextResponse:
    token = bearer_of(credentials)
    tenant = settings.tenant_id
    tenant_rel = await _relations(settings, f"/v1/tenants/{tenant}/me", token)
    cluster_rel = await _relations(settings, f"/v1/clusters/{director.cluster(settings)}/me", token)
    if not tenant_rel.get("can_administer"):
        # The edge let this person in, which needs only can_enter. The console
        # needs more, and says so as the refusal it is.
        raise HTTPException(status_code=403, detail="Tenant administrator privileges required")
    return AdminContextResponse(
        tenant=tenant,
        realm=settings.kernel_realm or tenant,
        isPlatformAdmin=bool(cluster_rel.get("can_configure")),
        isTenantAdmin=True,
        availableTenants=[tenant],
        kernelDomain=settings.kernel_domain or "",
    )


# Every route a not-yet-mapped screen calls, and the screen it belongs to.
# Method and path prefix, matched in order. This is the worklist of the
# re-pointing, kept where the code is so it cannot drift from what the
# console actually serves.
NOT_YET_MAPPED: list[tuple[str, str, str]] = [
    # Backup and Backup policy are relayed (routes/backups.py): the reads,
    # the policy writes, and the two actions. What is left of them is the
    # schedules, which are derived from the policy -- editing one does not
    # hold, so the screen shows them and changes them through the policy --
    # and minting a backup key, which belongs to the credential manager.
    ("PUT", "/admin/backup-schedules", "Backup schedules"),
    ("DELETE", "/admin/backup-schedules", "Backup schedules"),
    ("POST", "/admin/backup-keys", "Backup"),
    # The integrations read is relayed (routes/platform.py). Changing what an
    # app may consume is a change to declared state and belongs in the
    # deployments repository, which the director has no endpoint for yet.
    ("PUT", "/admin/grants", "Integrations"),
    ("GET", "/admin/groups", "Notifications"),
    ("GET", "/admin/notifications", "Notifications"),
    ("POST", "/admin/notifications", "Notifications"),
    ("GET", "/admin/audit-events", "Audit"),
    # Platform security and the customisation report are relayed. What is
    # left writes: which waivers the cluster permits is the operator chart's
    # own configuration, and changing it is a commit nobody has built yet.
    ("PUT", "/admin/platform/security-policy", "Platform security"),
    ("GET", "/admin/platform/authorization-summary", "Platform security"),
]


def screen_for(method: str, path: str) -> str | None:
    for m, prefix, screen in NOT_YET_MAPPED:
        if m == method and (path == prefix or path.startswith((prefix + "/", prefix + "?"))):
            return screen
    return None


@router.api_route("/{rest:path}", methods=["GET", "POST", "PUT", "PATCH", "DELETE"])
async def not_yet_mapped(
    rest: str, request: Request, _user: dict = Depends(get_current_user)
) -> None:
    path = "/admin/" + rest
    screen = screen_for(request.method, path)
    if screen is None:
        raise HTTPException(status_code=404, detail="No such route.")
    raise HTTPException(
        status_code=501,
        detail=f"The {screen} screen is not yet a client of the director. "
        "It is being re-pointed from the desktop's backend, and until its director endpoints exist it cannot show anything.",
    )
