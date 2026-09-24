"""The console's context comes from the director, not from the token.

Which screens exist for a person is decided from two answers of the director:
the tenant's verbs on the tenant this console runs in, and the cluster's
verbs. A person the edge let in but who may not administer the tenant is
refused here, as the refusal it is.
"""

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import admin
from app.core import director
from app.core.config import Settings, get_settings


def _app(settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(admin.router, prefix="/api/v1")
    app.dependency_overrides[get_settings] = lambda: settings
    return app


def _settings(**over) -> Settings:
    env = {
        "AUTH_DISABLED": "true",
        "KERNEL_DOMAIN": "desk.gentian.org",
        "KERNEL_REALM": "kernel",
        "TENANT_ID": "platform",
        "DIRECTOR_URL": "http://director.test:8080",
        "GENTIAN_CLUSTER_ID": "demo",
    }
    env.update(over)
    return Settings(**env)


def _director(monkeypatch, answers: dict[str, dict]):
    seen = []

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, method, url, params=None, json=None, headers=None):
            seen.append((method, url, (headers or {}).get("Authorization")))
            for suffix, body in answers.items():
                if url.endswith(suffix):
                    return httpx.Response(200, json=body, request=httpx.Request(method, url))
            return httpx.Response(404, json={"error": "no"}, request=httpx.Request(method, url))

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)
    return seen


def test_a_platform_administrator_sees_the_platform_screens(monkeypatch):
    seen = _director(monkeypatch, {
        "/v1/tenants/platform/me": {"relations": {"can_administer": True, "can_enter": True}},
        "/v1/clusters/demo/me": {"relations": {"can_configure": True, "can_audit": True}},
    })
    r = TestClient(_app(_settings())).get("/api/v1/admin/context", headers={"Authorization": "Bearer person"})
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["tenant"] == "platform" and body["realm"] == "kernel"
    assert body["isPlatformAdmin"] is True and body["isTenantAdmin"] is True
    assert body["availableTenants"] == ["platform"]
    # Both questions were asked as the caller, with the caller's own token.
    assert {u for _, u, _ in seen} == {
        "http://director.test:8080/v1/tenants/platform/me",
        "http://director.test:8080/v1/clusters/demo/me",
    }
    assert all(a == "Bearer person" for _, _, a in seen)


def test_a_tenant_administrator_sees_no_platform_screens(monkeypatch):
    _director(monkeypatch, {
        "/v1/tenants/platform/me": {"relations": {"can_administer": True}},
        "/v1/clusters/demo/me": {"relations": {"can_configure": False, "can_audit": False}},
    })
    r = TestClient(_app(_settings())).get("/api/v1/admin/context", headers={"Authorization": "Bearer t"})
    assert r.status_code == 200
    assert r.json()["isPlatformAdmin"] is False


def test_someone_the_edge_let_in_but_who_may_not_administer_is_refused(monkeypatch):
    _director(monkeypatch, {
        "/v1/tenants/platform/me": {"relations": {"can_administer": False, "can_enter": True}},
        "/v1/clusters/demo/me": {"relations": {}},
    })
    r = TestClient(_app(_settings())).get("/api/v1/admin/context", headers={"Authorization": "Bearer t"})
    assert r.status_code == 403


def test_without_a_director_the_console_says_so():
    r = TestClient(_app(_settings(DIRECTOR_URL=None))).get("/api/v1/admin/context", headers={"Authorization": "Bearer t"})
    assert r.status_code == 503


def test_a_screen_not_yet_mapped_says_which_one():
    """Every route a not-yet-mapped screen calls answers 501 and names the
    screen, so the console shows that rather than a spinner. A route nobody
    calls is a plain 404."""
    client = TestClient(_app(_settings()))
    r = client.get("/api/v1/admin/security-policies?tenant=platform", headers={"Authorization": "Bearer t"})
    assert r.status_code == 501 and "Security" in r.json()["detail"]
    r = client.put("/api/v1/admin/backup-policy/cluster", json={}, headers={"Authorization": "Bearer t"})
    assert r.status_code == 501 and "Backup policy" in r.json()["detail"]
    r = client.get("/api/v1/admin/members", headers={"Authorization": "Bearer t"})
    assert r.status_code == 404
