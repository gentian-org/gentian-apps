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


def test_both_writes_are_commits(monkeypatch):
    """A grant and the waiver allowlist are both declared state, so both
    answer a commit rather than a save."""
    seen: dict = {}
    _fake_client(monkeypatch, {"status": "updated", "commit": "a1b2c3d"}, seen, status=202)
    client = TestClient(_app(_settings()))

    r = client.put(
        "/api/v1/admin/grants/notes",
        json={"consume": [{"contract": "files", "granted": ["read"]}]},
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 202
    assert r.json()["commit"] == "a1b2c3d"
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/grants/notes"

    r = client.put(
        "/api/v1/admin/platform/security-policy",
        json={"allowedMacWaivers": []},
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 202
    assert seen["url"] == "http://director.test:8080/v1/clusters/demo/platform-security"


def test_a_refused_waiver_change_is_the_models_answer(monkeypatch):
    """`can_set_admission` is break-glass in model v1, so an ordinary
    platform administrator is refused. That is correct, and the screen
    shows the refusal rather than pretending the change landed."""
    _fake_client(monkeypatch, {"error": "forbidden"}, {}, status=403)
    r = TestClient(_app(_settings())).put(
        "/api/v1/admin/platform/security-policy",
        json={"allowedMacWaivers": [{"profile": "p", "policy": "q", "scope": "r"}]},
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 403


def test_no_token_is_refused_before_anything_is_forwarded():
    assert TestClient(_app(_settings())).get("/api/v1/admin/integrations").status_code == 401


def test_the_authorization_view_asks_the_right_scope(monkeypatch):
    """Who holds what, read-only, at two scopes.

    A tenant's bindings are the tenant's and are read under `can_view`; the
    cluster's are read under `can_audit`. The console does not decide either —
    it asks the right object and relays the director's answer, refusals
    included.
    """
    seen: dict = {}
    view = {
        "object": "tenant:platform",
        "bindings": [
            {"relation": "admin", "groups": ["gentian:tenant:platform:admins"], "grants": ["can_view"]}
        ],
        "unheld": 0,
    }
    _fake_client(monkeypatch, view, seen)
    client = TestClient(_app(_settings()))

    r = client.get("/api/v1/admin/authorization", headers={"Authorization": "Bearer t"})
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/authorization"
    # The grants survive the relay: without them a reader sees "admin" and has
    # to go and read the model to learn what it means.
    assert r.json()["bindings"][0]["grants"] == ["can_view"]

    r = client.get(
        "/api/v1/admin/authorization?scope=cluster", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/clusters/demo/authorization"


def test_a_refusal_of_the_cluster_scope_is_relayed_not_hidden(monkeypatch):
    """A tenant administrator holds no `can_audit`, and the director says so.

    The console must pass that through rather than show an empty table: "you
    may not read this" and "nobody holds anything" are different answers.
    """
    seen: dict = {}
    _fake_client(monkeypatch, {"detail": "forbidden"}, seen, status=403)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/authorization?scope=cluster", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 403


def test_the_cluster_scope_needs_a_cluster_id(monkeypatch):
    """No cluster id configured means no object to ask about, which is this
    console's own gap and is said as one rather than asked of the director."""
    seen: dict = {}
    _fake_client(monkeypatch, {}, seen)
    settings = Settings(
        AUTH_DISABLED="true",
        KERNEL_DOMAIN="desk.gentian.org",
        TENANT_ID="platform",
        DIRECTOR_URL="http://director.test:8080",
    )
    r = TestClient(_app(settings)).get(
        "/api/v1/admin/authorization?scope=cluster", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 501
    assert "GENTIAN_CLUSTER_ID" in r.json()["detail"]
