"""Roles from the token, and per-record checks that fail closed.

The arbiter is stood in for by httpx.MockTransport, so these run with no
network.
"""

import asyncio

import httpx
import pytest
from fastapi import HTTPException

from app.core import authz
from app.core.config import Settings
from app.core.roles import require_role, roles_of

ISSUER = "https://id.example.test/auth/realms/acme"
REAL_CLIENT = httpx.AsyncClient


def settings(**env: str) -> Settings:
    return Settings(_env_file=None, AUTH_DISABLED="false", OIDC_ISSUER=ISSUER, **env)


def test_roles_are_read_from_the_claim():
    user = {"gentian_app_roles": ["user", "editor", 7]}
    assert roles_of(user, settings()) == {"user", "editor"}
    assert roles_of({}, settings()) == set()
    assert roles_of({"gentian_app_roles": "admin"}, settings()) == set()


def test_require_role_refuses_a_caller_without_it():
    check = require_role("admin")
    with pytest.raises(HTTPException) as refused:
        asyncio.run(check(user={"gentian_app_roles": ["user"]}, settings=settings()))
    assert refused.value.status_code == 403
    user = {"gentian_app_roles": ["user", "admin"]}
    assert asyncio.run(check(user=user, settings=settings())) is user


def test_the_subject_is_the_one_the_platform_writes():
    assert authz.subject_of({"iss": ISSUER, "sub": "f:1:2"}) == "user:acme/f/1/2"
    for user in ({"iss": ISSUER}, {"sub": "x"}, {"iss": ISSUER, "sub": "a#b"}):
        with pytest.raises(HTTPException):
            authz.subject_of(user)


def ask(answer, monkeypatch, **env: str) -> int:
    """Run one check against a stand-in arbiter; the status it ends with."""
    seen = {}

    def handler(request: httpx.Request) -> httpx.Response:
        seen["auth"] = request.headers.get("authorization")
        seen["url"] = str(request.url)
        return answer(request)

    monkeypatch.setattr(
        authz.httpx,
        "AsyncClient",
        lambda **kw: REAL_CLIENT(transport=httpx.MockTransport(handler), **kw),
    )
    try:
        asyncio.run(
            authz.check_permission(
                user={"iss": ISSUER, "sub": "p1"},
                relation="can_delete",
                object_type="item",
                object_id="i1",
                settings=settings(**env),
            )
        )
    except HTTPException as exc:
        return exc.status_code
    assert seen == {"auth": "Bearer k", "url": "http://arbiter.test/v1/check"}
    return 200


STORE = {"AUTHORIZATION_URL": "http://arbiter.test", "AUTHORIZATION_KEY": "k"}


def test_a_check_with_no_store_refuses(monkeypatch):
    assert ask(lambda r: httpx.Response(200, json={"allowed": True}), monkeypatch) == 503


def test_a_check_passes_only_on_a_clear_yes(monkeypatch):
    assert ask(lambda r: httpx.Response(200, json={"allowed": True}), monkeypatch, **STORE) == 200
    assert ask(lambda r: httpx.Response(200, json={"allowed": False}), monkeypatch, **STORE) == 403
    assert ask(lambda r: httpx.Response(200, json={}), monkeypatch, **STORE) == 403
    assert ask(lambda r: httpx.Response(500), monkeypatch, **STORE) == 503
    assert ask(lambda r: httpx.Response(200, text="no"), monkeypatch, **STORE) == 503
