"""The cluster, as the director answers for it.

Every route here relays to the gentian-os director as the caller and hands
back whatever it answers, unchanged. The console holds no credential, keeps
no state, and decides nothing: whether this person may list tenants, change
a setting or open a console is the director's answer, read from the
authorization graph, and a refusal comes back as the refusal it is.
"""

from fastapi import APIRouter, Depends, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/cluster", tags=["cluster"])
_bearer = HTTPBearer(auto_error=False)


def _cluster_path(settings: Settings, suffix: str) -> str:
    return f"/v1/clusters/{director.cluster(settings)}{suffix}"


@router.get("/me")
async def cluster_me(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """Which of the cluster's verbs this person holds. Every verb false is an
    ordinary answer: it is what almost everyone who signs in gets."""
    return await director.forward(
        settings, "GET", _cluster_path(settings, "/me"), bearer_of(credentials)
    )


@router.get("/settings")
async def cluster_settings(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """What this cluster is configured with, catalogue and values together, so
    the screen renders from one answer and holds no catalogue of its own."""
    return await director.forward(
        settings, "GET", _cluster_path(settings, "/settings"), bearer_of(credentials)
    )


@router.patch("/settings")
async def set_cluster_settings(
    body: dict,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """One request is one commit. 202 with a commit means git has it and the
    cluster does not yet; 200 means the state asked for already held."""
    return await director.forward(
        settings,
        "PATCH",
        _cluster_path(settings, "/settings"),
        bearer_of(credentials),
        json_body=body,
    )


@router.get("/tenants")
async def cluster_tenants(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    return await director.forward(
        settings, "GET", _cluster_path(settings, "/tenants"), bearer_of(credentials)
    )


@router.post("/tenants")
async def create_cluster_tenant(
    body: dict,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    return await director.forward(
        settings,
        "POST",
        _cluster_path(settings, "/tenants"),
        bearer_of(credentials),
        json_body=body,
    )


@router.delete("/tenants/{tenant}")
async def retire_cluster_tenant(
    tenant: str,
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    return await director.forward(
        settings, "DELETE", _cluster_path(settings, f"/tenants/{tenant}"), bearer_of(credentials)
    )


@router.get("/tiles")
async def cluster_tiles(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    return await director.forward(
        settings, "GET", _cluster_path(settings, "/tiles"), bearer_of(credentials)
    )
