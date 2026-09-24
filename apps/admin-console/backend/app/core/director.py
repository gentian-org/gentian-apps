"""Relay to the gentian-os director, as the caller.

Why a relay rather than calling the director from the browser
-------------------------------------------------------------
The director serves no CORS headers and lives on the cluster network. Routing
through this API keeps it there, gives the bundle one origin, and means the
browser never holds a second audience's session.

What this deliberately does not do
----------------------------------
It holds no credential of its own and makes no authorisation decision. Every
call forwards the CALLER's bearer, which under edge is the zone's token the
Gateway put on the request, and the director decides from the authorization
graph what that person may see or change. Whatever it answers comes back
unchanged, including a refusal: a 403 from the director means the caller does
not hold the relation, and turning that into a friendlier status here would be
this component inventing an authorisation answer it is not entitled to give.

Only a platform-trust component may relay: forwardToken on an exposure
requires trustTier platform, and without forwardToken there is no token here
to relay. An ordinary app leaves director.url unset and never calls this.
"""

import json

import httpx
from fastapi import HTTPException, Response

from app.core.config import Settings

_TIMEOUT = httpx.Timeout(15.0)


def base_url(settings: Settings) -> str:
    if not settings.director_url:
        raise HTTPException(
            status_code=503, detail="The director is not configured for this component."
        )
    return settings.director_url.rstrip("/")


def cluster(settings: Settings) -> str:
    if not settings.cluster_id:
        raise HTTPException(
            status_code=503, detail="This component does not know which cluster it belongs to."
        )
    return settings.cluster_id


async def forward(
    settings: Settings,
    method: str,
    path: str,
    token: str,
    *,
    params: dict[str, str] | None = None,
    json_body: object | None = None,
) -> Response:
    """Pass one request to the director as the caller and hand back its answer verbatim."""
    url = f"{base_url(settings)}{path}"
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            upstream = await client.request(
                method,
                url,
                params=params,
                json=json_body,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"The director is unreachable: {exc}") from exc
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
    )


def unwrapped(answer: Response, key: str) -> Response:
    """Hand back one field of the director's answer as the screen reads it.

    The director answers a list under a key, with the tenant or the cluster
    beside it, because an answer that says what it is about is the right shape
    for an API. The screens were written against the bare list and stay as
    they are. A refusal or an error is passed through untouched — only a 200
    is unwrapped, because only a 200 has the field.
    """
    if answer.status_code != 200:
        return answer
    body = json.loads(answer.body)
    return Response(
        content=json.dumps(body.get(key, [])), status_code=200, media_type="application/json"
    )


def credential_manager_url(settings: Settings) -> str:
    """Where credential writes go.

    A separate service from the director and a separate question: the
    director decides what a person may do and writes git, the credential
    manager exchanges the person's token for one OpenBao accepts and writes
    the secret. Neither holds authority of its own, and this component holds
    neither of theirs.
    """
    if not settings.credential_manager_url:
        raise HTTPException(
            status_code=503,
            detail="The credential manager is not configured for this component.",
        )
    return settings.credential_manager_url.rstrip("/")


async def forward_to(
    base: str,
    method: str,
    path: str,
    token: str,
    *,
    params: dict[str, str] | None = None,
    json_body: object | None = None,
) -> Response:
    """Pass one request to a service other than the director, as the caller.

    Same rule, same shape: the caller's own bearer, the answer unchanged,
    including a refusal. Only the base differs.
    """
    try:
        async with httpx.AsyncClient(timeout=_TIMEOUT) as client:
            upstream = await client.request(
                method,
                f"{base}{path}",
                params=params,
                json=json_body,
                headers={"Authorization": f"Bearer {token}"},
            )
    except httpx.RequestError as exc:
        raise HTTPException(status_code=502, detail=f"The service is unreachable: {exc}") from exc
    return Response(
        content=upstream.content,
        status_code=upstream.status_code,
        media_type=upstream.headers.get("content-type", "application/json"),
    )
