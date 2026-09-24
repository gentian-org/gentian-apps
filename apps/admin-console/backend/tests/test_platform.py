"""Three reads relayed from the director, and the writes that are not."""

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import admin, platform
from app.core import director
from app.core.config import Settings, get_settings


def _app(settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(platform.router, prefix="/api/v1")
    app.include_router(admin.router, prefix="/api/v1")
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


def _fake_client(monkeypatch, body, seen: dict, status: int = 200):
    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, method, url, params=None, json=None, headers=None):
            seen["method"], seen["url"] = method, url
            return httpx.Response(status, json=body, request=httpx.Request(method, url))

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)


def test_integrations_are_asked_of_the_tenant(monkeypatch):
    seen: dict = {}
    _fake_client(
        monkeypatch,
        {
            "bindings": [{"name": "notes-files", "contract": "files"}],
            "grants": [],
            "summary": {"bindingCount": 1, "grantCount": 0, "grantReadyCount": 0},
            "effectiveAccess": [{"contract": "files", "ungranted": ["write"]}],
        },
        seen,
    )
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/integrations", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    # The join the screen cares about survives the relay untouched.
    assert r.json()["effectiveAccess"][0]["ungranted"] == ["write"]
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/integrations"


def test_platform_security_and_customization_are_asked_of_the_cluster(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, {"allowedMacWaivers": [], "catalogueRequests": []}, seen)
    client = TestClient(_app(_settings()))
    r = client.get("/api/v1/admin/platform/security-policy", headers={"Authorization": "Bearer t"})
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/clusters/demo/platform-security"

    _fake_client(monkeypatch, {"totalRecords": 0, "carriedDeltas": 0, "byRung": {}}, seen)
    r = client.get(
        "/api/v1/admin/platform/customization-debt", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/clusters/demo/customizations"


@pytest.mark.parametrize("status", [403, 502])
def test_the_directors_refusal_is_passed_through_unchanged(monkeypatch, status):
    _fake_client(monkeypatch, {"error": "refused"}, {}, status=status)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/integrations", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == status


def test_the_writes_still_say_they_are_not_wired():
    """Changing what an app may consume, or what the cluster permits to
    escape its posture, are both changes to declared state that nobody has
    built a commit for yet."""
    client = TestClient(_app(_settings()))
    r = client.put("/api/v1/admin/grants/notes", json={}, headers={"Authorization": "Bearer t"})
    assert r.status_code == 501 and "Integrations" in r.json()["detail"]
    r = client.put(
        "/api/v1/admin/platform/security-policy", json={}, headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 501 and "Platform security" in r.json()["detail"]


def test_no_token_is_refused_before_anything_is_forwarded():
    assert TestClient(_app(_settings())).get("/api/v1/admin/integrations").status_code == 401
