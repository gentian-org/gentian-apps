"""Who the caller is.

The bearer on a request is verified here and nowhere else. Under edge it is
the zone's token, put on the request by the platform's Gateway, minted for the
director; under pkce it is the bundle's own. Both are RS256 tokens from the
configured issuer and both are verified the same way: signature against the
issuer's published keys, issuer, expiry, and the audience this component was
told to require. Nothing about the mode changes the verification, only who
put the header there.

What this does not do is decide what the caller may do. That is the director's
answer, obtained by relaying the same token (see director.py). This module
establishes who is asking; it grants nothing.
"""

import time
from typing import Any

import httpx
import jwt
from fastapi import Depends, HTTPException, status
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core.config import Settings, get_settings
from app.core.tenant import assert_tenant_access

_bearer = HTTPBearer(auto_error=False)

# The issuer's signing keys, cached per issuer. Fetching them on every request
# put a network call to the identity provider on the hot path of every API
# call, and made the identity provider's availability the availability of this
# component. A rotated key that is not in the cache is fetched once more before
# the token is refused, so rotation costs one extra fetch, not an outage.
_JWKS_TTL_SECONDS = 600
_jwks_cache: dict[str, tuple[float, dict[str, Any]]] = {}


def _jwks(issuer: str, *, refresh: bool = False) -> dict[str, Any]:
    now = time.monotonic()
    cached = _jwks_cache.get(issuer)
    if cached and not refresh and now - cached[0] < _JWKS_TTL_SECONDS:
        return cached[1]
    url = issuer.rstrip("/") + "/protocol/openid-connect/certs"
    resp = httpx.get(url, timeout=10.0)
    resp.raise_for_status()
    keys = resp.json()
    _jwks_cache[issuer] = (now, keys)
    return keys


def _signing_key(issuer: str, kid: str | None):
    for attempt in (False, True):
        keys = _jwks(issuer, refresh=attempt)
        key = next((k for k in keys.get("keys", []) if k.get("kid") == kid), None)
        if key is not None:
            return jwt.algorithms.RSAAlgorithm.from_jwk(key)
    raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Unknown signing key")


def decode_token(token: str, settings: Settings) -> dict[str, Any]:
    """Verify a bearer against this component's issuer and audience."""
    issuer = (settings.oidc_issuer or "").rstrip("/")
    header = jwt.get_unverified_header(token)
    public_key = _signing_key(issuer, header.get("kid"))
    audience = settings.expected_audience
    return jwt.decode(
        token,
        public_key,
        algorithms=["RS256"],
        audience=audience,
        issuer=issuer,
        options={"verify_aud": audience is not None},
    )


async def get_current_user(
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
) -> dict[str, Any]:
    settings = get_settings()
    if settings.auth_disabled or not settings.oidc_issuer:
        return {"sub": f"admin-{settings.tenant_id}", "tenant": settings.tenant_id}
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="Not authenticated")
    try:
        claims = decode_token(credentials.credentials, settings)
    except jwt.PyJWTError as exc:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail=str(exc)) from exc
    except httpx.HTTPError as exc:
        # The identity provider could not be asked for its keys. That is not
        # the caller's fault and not a refusal of the caller: say so.
        raise HTTPException(
            status_code=status.HTTP_503_SERVICE_UNAVAILABLE,
            detail=f"The identity provider's signing keys are unavailable: {exc}",
        ) from exc

    tenant = assert_tenant_access(claims, settings)
    claims["tenant"] = tenant
    return claims


def bearer_of(credentials: HTTPAuthorizationCredentials | None) -> str:
    """The raw bearer, for relaying to the director as the caller."""
    if credentials is None or not credentials.credentials:
        raise HTTPException(status_code=status.HTTP_401_UNAUTHORIZED, detail="A bearer token is required.")
    return credentials.credentials
