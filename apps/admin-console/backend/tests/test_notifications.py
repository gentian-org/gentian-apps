"""Notices are read from, and published into, the desktop's own table.

The console keeps no copy: two stores would mean a notice that exists in one
and not the other. Reading is a read of state; publishing is an action, and
the answer says what was published rather than what was committed, because
nothing was.
"""

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import notifications
from app.core import director
from app.core.config import Settings, get_settings


def _app(settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(notifications.router, prefix="/api/v1")
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
            seen["method"], seen["url"], seen["json"] = method, url, json
            return httpx.Response(status, json=body, request=httpx.Request(method, url))

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)


def test_the_notices_arrive_as_the_bare_list_the_screen_reads(monkeypatch):
    seen: dict = {}
    rows = [{"id": "1", "title": "Maintenance", "severity": "warning"}]
    _fake_client(monkeypatch, {"tenant": "platform", "notifications": rows}, seen)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/notifications", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    assert r.json() == rows
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/notifications"


def test_publishing_is_an_action(monkeypatch):
    seen: dict = {}
    _fake_client(
        monkeypatch,
        {"id": "abc", "title": "Maintenance", "publisher": "tom@example.com"},
        seen,
        status=202,
    )
    r = TestClient(_app(_settings())).post(
        "/api/v1/admin/notifications",
        json={"title": "Maintenance", "body": "Tonight at 22:00", "severity": "warning"},
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 202
    body = r.json()
    # What was published, with who published it, and no commit because
    # nothing was declared.
    assert body["publisher"] == "tom@example.com"
    assert "commit" not in body
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/actions/notify"


def test_a_tenant_whose_desktop_has_not_started_says_so(monkeypatch):
    """503 rather than an empty list: "nothing was ever said" and "there is
    nowhere to say it yet" are different answers, and only one of them is
    something to wait for."""
    _fake_client(
        monkeypatch,
        {"detail": "this tenant has no notification store yet"},
        {},
        status=503,
    )
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/notifications", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 503


def test_no_token_is_refused_before_anything_is_forwarded():
    assert TestClient(_app(_settings())).get("/api/v1/admin/notifications").status_code == 401
