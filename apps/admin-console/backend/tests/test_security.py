"""The realm policy is declared state, and the screen keeps its own shape.

This screen used to reach Keycloak's admin API with a credential that could
read and write the whole realm. Now it reads and writes the tenant's declared
policy through the director, and the composition applies it. What this module
is really responsible for is the translation — the screen's flat form, the
director's nested resource — and the rule that a field nobody asked for is not
written, so the realm keeps the default rather than a zero.
"""

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import security
from app.core import director
from app.core.config import Settings, get_settings


def _app(settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(security.router, prefix="/api/v1")
    app.dependency_overrides[get_settings] = lambda: settings
    return app


def _settings() -> Settings:
    return Settings(
        AUTH_DISABLED="true",
        KERNEL_DOMAIN="desk.gentian.org",
        TENANT_ID="platform",
        DIRECTOR_URL="http://director.test:8080",
        GENTIAN_CLUSTER_ID="demo",
    )


def _fake_client(monkeypatch, responder, seen: dict):
    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, method, url, params=None, json=None, headers=None):
            seen["method"], seen["url"], seen["json"] = method, url, json
            return responder(method, url)

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)


def _answer(status, body):
    return lambda m, url: httpx.Response(status, json=body, request=httpx.Request(m, url))


def test_what_is_not_declared_reads_as_what_the_realm_will_do(monkeypatch):
    """A tenant that declares nothing still has a session length. Reporting a
    zero would read as "no timeout"; the composition's default is the truth,
    and the director sends it alongside."""
    _fake_client(
        monkeypatch,
        _answer(
            200,
            {
                "tenant": "platform",
                "policy": {},
                "defaults": {"session": {"idleMinutes": 720, "maxHours": 12}},
            },
        ),
        {},
    )
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/security-policies", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["ssoSessionIdleMinutes"] == 720
    assert body["ssoSessionMaxHours"] == 12
    assert body["passwordMinLength"] == 0
    assert body["bruteForceProtected"] is False


def test_a_declared_policy_reads_back_flat(monkeypatch):
    _fake_client(
        monkeypatch,
        _answer(
            200,
            {
                "tenant": "platform",
                "policy": {
                    "password": {"minLength": 12, "requireDigits": True, "historyCount": 3},
                    "session": {"idleMinutes": 30, "maxHours": 8},
                    "bruteForce": {
                        "enabled": True,
                        "maxLoginFailures": 5,
                        "lockoutDurationSeconds": 900,
                    },
                },
                "defaults": {"session": {"idleMinutes": 720, "maxHours": 12}},
            },
        ),
        {},
    )
    body = (
        TestClient(_app(_settings()))
        .get("/api/v1/admin/security-policies", headers={"Authorization": "Bearer t"})
        .json()
    )
    assert body["passwordMinLength"] == 12
    assert body["passwordRequireDigits"] is True
    assert body["passwordRequireLowercase"] is False
    assert body["ssoSessionIdleMinutes"] == 30
    assert body["maxLoginFailures"] == 5


def test_a_write_states_only_what_was_asked_for(monkeypatch):
    """The realm keeps the composition's default for anything the form left
    at zero, which means those fields must not be written at all."""
    seen: dict = {}
    _fake_client(monkeypatch, _answer(202, {"status": "updated", "commit": "a1b2c3d"}), seen)
    r = TestClient(_app(_settings())).put(
        "/api/v1/admin/security-policies",
        json={
            "passwordMinLength": 12,
            "passwordRequireDigits": True,
            "passwordRequireLowercase": False,
            "passwordHistoryCount": 0,
            "ssoSessionIdleMinutes": 30,
            "ssoSessionMaxHours": 0,
            "rememberMe": False,
            "bruteForceProtected": True,
            "maxLoginFailures": 5,
            "lockoutDurationSeconds": 0,
            "requireTotpAdmins": False,
            "requireTotpMembers": "none",
        },
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 202
    assert r.json()["commit"] == "a1b2c3d"
    assert seen["method"] == "PUT"
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/security-policy"
    assert seen["json"] == {
        "password": {"minLength": 12, "requireDigits": True},
        "session": {"idleMinutes": 30},
        "bruteForce": {"enabled": True, "maxLoginFailures": 5},
    }


def test_requiring_a_second_factor_says_it_cannot_yet(monkeypatch):
    """Keycloak expresses it as a conditional flow rather than a realm
    setting, so it cannot be declared with the rest. Refusing with the reason
    beats accepting it and dropping it."""
    seen: dict = {}
    _fake_client(monkeypatch, _answer(202, {"status": "updated"}), seen)
    r = TestClient(_app(_settings())).put(
        "/api/v1/admin/security-policies",
        json={"passwordMinLength": 12, "requireTotpMembers": "required"},
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 400
    assert "conditional authentication flow" in r.json()["detail"]
    assert not seen, "nothing should have been forwarded"


def test_the_directors_refusal_is_passed_through_unchanged(monkeypatch):
    _fake_client(monkeypatch, _answer(403, {"error": "forbidden"}), {})
    r = TestClient(_app(_settings())).put(
        "/api/v1/admin/security-policies",
        json={"passwordMinLength": 12},
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 403


def test_no_token_is_refused_before_anything_is_forwarded():
    assert TestClient(_app(_settings())).get("/api/v1/admin/security-policies").status_code == 401
