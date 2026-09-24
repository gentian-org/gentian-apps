"""The Resources screen is a client of the director.

Same rule as the cluster's settings: the console holds no credential and
decides nothing. The person's token goes to the director, which asks the
graph whether they may view the tenant or set its plan, reads the cluster's
answers from the operator, and commits the choice as the person. What comes
back is passed on unchanged, except that the screen reads a bare list where
the director answers a list under a key.
"""

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import admin, resources
from app.core import director
from app.core.config import Settings, get_settings


def _app(settings: Settings) -> FastAPI:
    app = FastAPI()
    # In the order main.py includes them: the screen's own routes before the
    # not-yet-mapped catch-all, which must no longer claim them.
    app.include_router(resources.router, prefix="/api/v1")
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


def _fake_client(monkeypatch, responder, seen: dict):
    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, method, url, params=None, json=None, headers=None):
            seen["method"] = method
            seen["url"] = url
            seen["params"] = params
            seen["json"] = json
            seen["auth"] = (headers or {}).get("Authorization")
            return responder(method, url)

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)


def _answer(status, body):
    return lambda m, url: httpx.Response(status, json=body, request=httpx.Request(m, url))


def test_the_state_is_the_directors_answer_for_the_consoles_own_tenant(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, _answer(200, {"tenant": "platform", "plan": "nodes-2", "quota": []}), seen)
    r = TestClient(_app(_settings())).get("/api/v1/admin/resources", headers={"Authorization": "Bearer person"})
    assert r.status_code == 200
    assert r.json()["plan"] == "nodes-2"
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/resources"
    assert seen["auth"] == "Bearer person"


def test_a_platform_operator_asks_about_any_tenant_and_the_director_decides(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, _answer(200, {"tenant": "acme"}), seen)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/resources?tenant=acme", headers={"Authorization": "Bearer person"}
    )
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/tenants/acme/resources"


def test_the_plans_arrive_as_the_bare_list_the_screen_reads(monkeypatch):
    seen: dict = {}
    plans = [{"name": "nodes-2", "current": True, "selectable": True}, {"name": "nodes-4", "selectable": False}]
    _fake_client(monkeypatch, _answer(200, {"tenant": "platform", "plans": plans}), seen)
    r = TestClient(_app(_settings())).get("/api/v1/admin/resources/plans", headers={"Authorization": "Bearer t"})
    assert r.status_code == 200
    assert r.json() == plans
    # No selfService flag: whether this person chooses for themselves is the
    # director's decision from the graph, not the screen's assertion.
    assert not seen["params"]


def test_choosing_a_plan_is_a_commit(monkeypatch):
    seen: dict = {}
    _fake_client(
        monkeypatch,
        _answer(202, {"status": "updated", "tenant": "platform", "plan": "nodes-4", "previousPlan": "nodes-2",
                      "commit": "a1b2c3", "message": "committed"}),
        seen,
    )
    r = TestClient(_app(_settings())).put(
        "/api/v1/admin/resources", json={"plan": "nodes-4", "force": False}, headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 202
    assert r.json()["previousPlan"] == "nodes-2"
    assert seen["method"] == "PUT"
    assert seen["json"] == {"plan": "nodes-4", "force": False}
    assert seen["auth"] == "Bearer t"


@pytest.mark.parametrize("status", [403, 402, 409, 404])
def test_the_directors_refusal_is_passed_through_unchanged(monkeypatch, status):
    """403 included: whether this person may set the plan is the director's
    answer, and 409 is the downgrade guard, which the screen offers to
    force only to someone the director will then allow to."""
    _fake_client(monkeypatch, _answer(status, {"error": "refused"}), {})
    r = TestClient(_app(_settings())).put(
        "/api/v1/admin/resources", json={"plan": "nodes-1"}, headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == status


def test_history_queries_travel_with_the_request(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, _answer(200, {"tenant": "platform", "samples": []}), seen)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/resources/usage?from=2026-09-01T00:00:00Z&stepSeconds=3600",
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/resources/usage"
    assert seen["params"] == {"from": "2026-09-01T00:00:00Z", "stepSeconds": "3600"}

    _fake_client(monkeypatch, _answer(200, {"tenant": "acme", "intervals": []}), seen)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/resources/report?tenant=acme&to=2026-10-01T00:00:00Z", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/tenants/acme/resources/report"
    assert seen["params"] == {"to": "2026-10-01T00:00:00Z"}


def test_the_clusters_view_is_every_tenants_state(monkeypatch):
    seen: dict = {}
    states = [{"tenant": "acme", "plan": "nodes-2"}, {"tenant": "platform", "plan": "nodes-4"}]
    _fake_client(monkeypatch, _answer(200, {"cluster": "demo", "tenants": states, "unavailable": []}), seen)
    r = TestClient(_app(_settings())).get("/api/v1/admin/resources/tenants", headers={"Authorization": "Bearer t"})
    assert r.status_code == 200
    assert r.json() == states
    assert seen["url"] == "http://director.test:8080/v1/clusters/demo/resources"


def test_resources_is_no_longer_a_screen_the_console_cannot_show():
    assert admin.screen_for("GET", "/admin/resources") is None
    assert admin.screen_for("PUT", "/admin/resources") is None
    assert admin.screen_for("GET", "/admin/resources/plans") is None


def test_no_token_is_refused_before_anything_is_forwarded():
    r = TestClient(_app(_settings())).get("/api/v1/admin/resources")
    assert r.status_code == 401
