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

import httpx
from fastapi import HTTPException, Response

from app.core.config import Settings

_TIMEOUT = httpx.Timeout(15.0)


def base_url(settings: Settings) -> str:
    if not settings.director_url:
        raise HTTPException(status_code=503, detail="The director is not configured for this component.")
    return settings.director_url.rstrip("/")


def cluster(settings: Settings) -> str:
    if not settings.cluster_id:
        raise HTTPException(status_code=503, detail="This component does not know which cluster it belongs to.")
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
