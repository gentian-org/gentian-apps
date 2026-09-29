"""The cluster's own catalogues — the plain fallback, not a shop.

The App Store is where somebody should be looking. It knows what an app is
for, what it costs, who maintains it, and it is kept current by people whose
job that is. This screen is what remains when the store is not the answer:
it is unreachable, or the cluster is air-gapped, or — the case with no store
answer at all — the entry is this operator's own profile in their own
repository, which nobody sells and nobody else lists.

So it shows coordinates, versions and editions, and nothing else. Everything
here is relayed from the director, which lists only the community (ce) and
private (pe) editions of the sources named on the Cluster claim and counts
the rest as the store's (AD-14). None of that is decided here.
"""

from fastapi import APIRouter, Depends, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/catalogue", tags=["catalogue"])
_bearer = HTTPBearer(auto_error=False)


@router.get("/sources")
async def sources(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Which catalogues this cluster may fetch from, and which are open here.

    `storeUrl` comes back with them, because the honest answer to most of this
    screen is "go to the App Store" and the screen needs somewhere to point.
    """
    return await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{tenant or settings.tenant_id}/catalogues",
        bearer_of(credentials),
    )


@router.get("/sources/{source}/entries")
async def entries(
    source: str,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """What is in one catalogue.

    An entry is `installable` only when the claim opened its source to this
    tenant. Otherwise the App Store decides, and `storeOnly` says how many
    further entries are not listed here at all.
    """
    return await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{tenant or settings.tenant_id}/catalogues/{source}/entries",
        bearer_of(credentials),
    )
