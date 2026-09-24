"""What changed, who changed it, and what allowed them to.

This is the change-management half of an audit trail, and it needs no store of
its own: every change to declared state is already a commit that the director
authored as the person whose token authorised it, trailered with the relation
and object that permitted the change and the request id that started it. So
"who changed this tenant's backup policy in March, and under what authority"
is a git question.

What it is not
--------------
A sign-in leaves no commit. A refused request changes nothing, so it commits
nothing. Reading a secret writes nothing anywhere. Those are real audit
records and they are not in here; the screen says so, from the director's own
answer, rather than presenting this as the whole story. See the roadmap's
audit item for where each of them is going.
"""

from fastapi import APIRouter, Depends, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/admin", tags=["audit"])
_bearer = HTTPBearer(auto_error=False)


@router.get("/changes")
async def changes(
    tenant: str | None = Query(default=None),
    scope: str = Query(default="tenant"),
    limit: int | None = Query(default=None),
    since: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """A READ of state, from git.

    `scope=cluster` is every tenant and the claims that describe the cluster
    itself, which needs can_audit on the cluster; the default is one tenant's
    own history, which its administrators read.

    Each entry says whether the change went through the platform. One that
    did not was pushed by hand, with whatever credential the pusher held and
    no record of what allowed it — which is the thing an audit most wants
    marked, not smoothed over.
    """
    params = {k: str(v) for k, v in {"limit": limit, "since": since}.items() if v is not None}
    if scope == "cluster":
        path = f"/v1/clusters/{director.cluster(settings)}/changes"
    else:
        path = f"/v1/tenants/{tenant or settings.tenant_id}/changes"
    return await director.forward(settings, "GET", path, bearer_of(credentials), params=params)
