"""The change history is relayed, and it says what it does not cover."""

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import audit
from app.core import director
from app.core.config import Settings, get_settings


def _app(settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(audit.router, prefix="/api/v1")
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


def _fake_client(monkeypatch, body, seen: dict):
    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, method, url, params=None, json=None, headers=None):
            seen["method"], seen["url"], seen["params"] = method, url, params
            return httpx.Response(200, json=body, request=httpx.Request(method, url))

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)


ANSWER = {
    "tenant": "platform",
    "covers": "changes to declared state, from git. Sign-ins, refused requests and reads of data are recorded elsewhere and are not in this list.",
    "changes": [
        {
            "commit": "aaa111",
            "author": {"Name": "Tom", "Email": "tom@example.com"},
            "summary": "Set the backup policy for tenant platform",
            "throughPlatform": True,
            "principal": "tom",
            "decision": "can_set_policy tenant:platform",
            "requestId": "abc123",
            "files": ["clusters/c/tenants/platform/backup-policy.yaml"],
        },
        {
            "commit": "bbb222",
            "author": {"Name": "brandli", "Email": "ch@example.com"},
            "summary": "seed the tenant",
            "throughPlatform": False,
            "files": ["clusters/c/tenants/platform/tenant.yaml"],
        },
    ],
}


def test_a_tenants_history_carries_the_authority_for_each_change(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, ANSWER, seen)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/changes", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    body = r.json()
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/changes"
    first, second = body["changes"]
    assert first["decision"] == "can_set_policy tenant:platform"
    assert first["requestId"] == "abc123"
    # A commit pushed by hand is reported as one rather than dressed up.
    assert second["throughPlatform"] is False
    assert "decision" not in second


def test_the_answer_says_what_it_leaves_out(monkeypatch):
    """A screen headed "audit" that showed only git would be claiming more
    than it has."""
    _fake_client(monkeypatch, ANSWER, {})
    body = (
        TestClient(_app(_settings()))
        .get("/api/v1/admin/changes", headers={"Authorization": "Bearer t"})
        .json()
    )
    assert "Sign-ins" in body["covers"]


def test_the_cluster_scope_asks_the_cluster(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, ANSWER, seen)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/changes?scope=cluster&limit=5&since=2026-01-01",
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/clusters/demo/changes"
    assert seen["params"] == {"limit": "5", "since": "2026-01-01"}


def test_no_token_is_refused_before_anything_is_forwarded():
    assert TestClient(_app(_settings())).get("/api/v1/admin/changes").status_code == 401
