"""Verifying the bearer the edge forwards.

Under edge the platform's Gateway puts the zone's token on the request. That
token is minted for the director and signed by the zone's realm, and this API
must accept exactly that and nothing else: not a token the same realm signed
for some other purpose, not one from another issuer, and not a request with no
bearer at all. What the caller may then do is the director's answer, obtained
by relaying the same token; nothing here grants anything.

The identity provider is stood in for by a key generated here and a JWKS
returned by a patched fetch, so these run with no network.
"""

import time

import jwt
import pytest
from cryptography.hazmat.primitives import serialization
from cryptography.hazmat.primitives.asymmetric import rsa
from fastapi import HTTPException

from app.core import auth
from app.core.config import Settings

ISSUER = "https://id.example.test/auth/realms/kernel"
KID = "test-key"


@pytest.fixture(scope="module")
def keypair():
    private = rsa.generate_private_key(public_exponent=65537, key_size=2048)
    return private, private.public_key()


@pytest.fixture(autouse=True)
def jwks(keypair, monkeypatch):
    _, public = keypair
    jwk = jwt.algorithms.RSAAlgorithm.to_jwk(public, as_dict=True)
    jwk["kid"] = KID
    monkeypatch.setattr(auth, "_jwks", lambda issuer, refresh=False: {"keys": [jwk]})
    auth._jwks_cache.clear()


def settings(**over) -> Settings:
    base = dict(
        # Explicit, because a conftest may put AUTH_DISABLED=true in the
        # process environment for tests that never verify a token, and these
        # tests exist to verify one. In production the validator refuses the
        # inherited value outright, which is right, and this is the fix.
        AUTH_DISABLED="false",
        AUTH_MODE="edge",
        OIDC_ISSUER=ISSUER,
        OIDC_CLIENT_ID="gentian-edge-kernel",
        OIDC_AUDIENCE="gentian-director",
        TENANT_ID="platform",
        ENVIRONMENT="local",
    )
    base.update(over)
    return Settings(**base)


def token(keypair, **claims) -> str:
    private, _ = keypair
    now = int(time.time())
    payload = {
        "iss": ISSUER,
        "sub": "person",
        "aud": "gentian-director",
        "azp": "gentian-edge-kernel",
        "exp": now + 300,
        "iat": now,
        "tenant": "platform",
    }
    payload.update(claims)
    pem = private.private_bytes(
        serialization.Encoding.PEM,
        serialization.PrivateFormat.PKCS8,
        serialization.NoEncryption(),
    )
    return jwt.encode(payload, pem, algorithm="RS256", headers={"kid": KID})


def test_the_zones_token_is_accepted(keypair):
    claims = auth.decode_token(token(keypair), settings())
    assert claims["sub"] == "person"


def test_a_token_for_another_audience_is_refused(keypair):
    """The same realm signs tokens for many purposes. Only the one minted for
    the director is the zone's session; an app's own token or an
    administration console's is not, and is refused here rather than accepted
    as somebody's session."""
    with pytest.raises(jwt.InvalidAudienceError):
        auth.decode_token(token(keypair, aud=["realm-management", "account"], azp="security-admin-console"), settings())


def test_a_token_from_another_issuer_is_refused(keypair):
    with pytest.raises(jwt.InvalidIssuerError):
        auth.decode_token(token(keypair, iss="https://id.example.test/auth/realms/other"), settings())


def test_an_expired_token_is_refused(keypair):
    with pytest.raises(jwt.ExpiredSignatureError):
        auth.decode_token(token(keypair, exp=int(time.time()) - 10), settings())


def test_without_a_configured_audience_the_client_id_is_required(keypair):
    """A component not told an audience falls back to its client id, so it is
    never the case that any token the realm signed is accepted."""
    s = settings(OIDC_AUDIENCE=None)
    with pytest.raises(jwt.InvalidAudienceError):
        auth.decode_token(token(keypair, aud="something-else"), s)
    claims = auth.decode_token(token(keypair, aud="gentian-edge-kernel"), s)
    assert claims["azp"] == "gentian-edge-kernel"


def test_an_unknown_signing_key_is_refused_after_one_refresh(keypair, monkeypatch):
    """A rotated key that is not in the cache costs one extra fetch, not an
    outage; a key the issuer never published is refused."""
    calls = []

    def fetch(issuer, refresh=False):
        calls.append(refresh)
        return {"keys": []}

    monkeypatch.setattr(auth, "_jwks", fetch)
    with pytest.raises(HTTPException) as refused:
        auth.decode_token(token(keypair), settings())
    assert refused.value.status_code == 401
    assert calls == [False, True]


def test_bearer_of_refuses_an_absent_header():
    with pytest.raises(HTTPException) as refused:
        auth.bearer_of(None)
    assert refused.value.status_code == 401


def test_under_edge_the_tenant_is_the_platforms_not_the_tokens(keypair):
    """The zone's token carries no tenant claim, and in production the pkce
    rule would refuse it as missing one. Under edge the component is in the
    tenant the platform put it in, and the edge decided entry."""
    from app.core.tenant import assert_tenant_access

    s = settings(ENVIRONMENT="production", TENANT_ID="acme")
    claims = auth.decode_token(token(keypair, tenant=None), s)
    claims.pop("tenant", None)
    assert "tenant" not in claims
    assert assert_tenant_access(claims, s) == "acme"


def test_under_pkce_a_mismatched_tenant_claim_is_still_refused():
    from app.core.tenant import assert_tenant_access

    s = settings(AUTH_MODE="pkce", TENANT_ID="acme")
    with pytest.raises(HTTPException) as refused:
        assert_tenant_access({"tenant": "other"}, s)
    assert refused.value.status_code == 403
