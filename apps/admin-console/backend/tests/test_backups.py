"""The Backup screens are clients of the director.

Three screens, one rule: what exists, what a run did, and which policy is in
force are cluster state, relayed by the director to whoever may view the
tenant. The console recomputes no inheritance — a tenant that states nothing
still runs under a policy, and saying what that comes to is the reconciler's
answer, read here.

The writes are not relayed yet and must still answer 501 naming their screen,
because a screen that silently did nothing would be worse than one that says
it cannot.
"""

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import admin, backups
from app.core import director
from app.core.config import Settings, get_settings


def _app(settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(backups.router, prefix="/api/v1")
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
            seen["method"], seen["url"] = method, url
            seen["json"] = json
            seen["auth"] = (headers or {}).get("Authorization")
            return responder(method, url)

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)


def _answer(status, body):
    return lambda m, url: httpx.Response(status, json=body, request=httpx.Request(m, url))


def test_the_backups_arrive_as_the_bare_list_the_screen_reads(monkeypatch):
    seen: dict = {}
    items = [{"name": "nightly-1", "phase": "Ready", "platformReadable": True}]
    _fake_client(monkeypatch, _answer(200, {"tenant": "platform", "backups": items}), seen)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/backups", headers={"Authorization": "Bearer person"}
    )
    assert r.status_code == 200
    assert r.json() == items
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/backups"
    assert seen["auth"] == "Bearer person"


def test_a_tenant_that_states_no_policy_still_gets_what_applies(monkeypatch):
    """`configured: false` with effective values is the answer the screen
    renders as "inherited", and it comes from the reconciler that resolved
    it, not from arithmetic here."""
    seen: dict = {}
    _fake_client(
        monkeypatch,
        _answer(
            200,
            {
                "scope": "tenant",
                "tenant": "platform",
                "configured": False,
                "effectiveSchedule": "0 2 * * *",
                "effectiveBucket": "gentian-backups",
                "effectiveRecipients": [],
            },
        ),
        seen,
    )
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/backup-policy", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    body = r.json()
    assert body["configured"] is False
    assert body["effectiveSchedule"] == "0 2 * * *"
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/backup-policy"


def test_the_clusters_policy_is_asked_of_the_cluster(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, _answer(200, {"scope": "cluster", "configured": True}), seen)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/backup-policy/cluster", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/clusters/demo/backup-policy"


def test_schedules_come_per_tenant_or_for_the_whole_cluster(monkeypatch):
    seen: dict = {}
    rows = [{"name": "policy", "managed": True, "schedule": "0 2 * * *"}]
    _fake_client(monkeypatch, _answer(200, {"tenant": "platform", "schedules": rows}), seen)
    client = TestClient(_app(_settings()))
    r = client.get("/api/v1/admin/backup-schedules", headers={"Authorization": "Bearer t"})
    assert r.status_code == 200
    assert r.json() == rows
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/backup-schedules"

    _fake_client(monkeypatch, _answer(200, {"schedules": rows}), seen)
    r = client.get(
        "/api/v1/admin/backup-schedules?allTenants=true", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/clusters/demo/backup-schedules"


@pytest.mark.parametrize("status", [403, 404, 502])
def test_the_directors_refusal_is_passed_through_unchanged(monkeypatch, status):
    _fake_client(monkeypatch, _answer(status, {"error": "refused"}), {})
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/backups", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == status


def test_a_policy_is_a_commit_and_a_backup_is_something_started(monkeypatch):
    """The two kinds of write, and the two shapes of answer. A policy says
    what should be true from now on and comes back as a commit; a backup
    happens once and comes back as something started, with no commit because
    nothing was declared."""
    seen: dict = {}
    _fake_client(
        monkeypatch,
        _answer(202, {"status": "updated", "commit": "a1b2c3d"}),
        seen,
    )
    client = TestClient(_app(_settings()))
    r = client.put(
        "/api/v1/admin/backup-policy",
        json={"schedule": "0 3 * * *"},
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 202
    assert r.json()["commit"] == "a1b2c3d"
    assert seen["method"] == "PUT"
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/backup-policy"

    _fake_client(
        monkeypatch,
        _answer(202, {"action": "backup", "name": "manual-1", "status": "started"}),
        seen,
    )
    r = client.post("/api/v1/admin/backups", json={}, headers={"Authorization": "Bearer t"})
    assert r.status_code == 202
    body = r.json()
    assert body["status"] == "started" and "commit" not in body
    # An action goes to an action route, which is what says it is one.
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/actions/backup"


def test_clearing_a_policy_is_how_a_tenant_inherits_again(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, _answer(202, {"status": "updated", "commit": "d4e5f6a"}), seen)
    r = TestClient(_app(_settings())).delete(
        "/api/v1/admin/backup-policy", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 202
    assert seen["method"] == "DELETE"
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/backup-policy"


def test_deleting_a_backup_is_an_action_not_a_deletion_of_state(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, _answer(202, {"action": "delete-backup", "status": "started"}), seen)
    r = TestClient(_app(_settings())).delete(
        "/api/v1/admin/backups/nightly-1", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 202
    assert seen["method"] == "POST"
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/actions/delete-backup"
    assert seen["json"] == {"name": "nightly-1"}


def test_what_is_left_still_says_it_is_not_wired():
    """Schedules are derived from the policy, and minting a key belongs to
    the credential manager. Both still answer 501 naming their screen."""
    client = TestClient(_app(_settings()))
    r = client.put(
        "/api/v1/admin/backup-schedules/policy", json={}, headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 501 and "Backup schedules" in r.json()["detail"]
    r = client.post(
        "/api/v1/admin/backup-keys/mint", json={}, headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 501 and "Backup" in r.json()["detail"]


def test_no_token_is_refused_before_anything_is_forwarded():
    assert TestClient(_app(_settings())).get("/api/v1/admin/backups").status_code == 401
