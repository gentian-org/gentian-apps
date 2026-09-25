"""People, groups and the realm's password policy, relayed to the director.

What these assert is the relay's shape rather than Keycloak's behaviour: the
director is the one that holds a credential and decides, and a test here that
pretended otherwise would be testing a second implementation of a decision
that has one home.
"""

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import admin, people
from app.core import director
from app.core.config import Settings, get_settings


def _app(settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(people.router, prefix="/api/v1")
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
            seen["params"], seen["json"] = params, json
            return httpx.Response(status, json=body, request=httpx.Request(method, url))

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)


def test_people_are_asked_of_the_tenant(monkeypatch):
    seen: dict = {}
    _fake_client(
        monkeypatch,
        {"tenant": "platform", "people": [{"id": "u1", "username": "ada@example.com", "pending": True}]},
        seen,
    )
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/people", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/people"
    # pending survives the relay: somebody invited who has not finished is not
    # the same as somebody who can sign in, and a list that flattened the two
    # would make a failed invitation invisible.
    assert r.json()["people"][0]["pending"] is True


def test_a_search_is_passed_through(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, {"people": []}, seen)
    TestClient(_app(_settings())).get(
        "/api/v1/admin/people?search=ada&limit=10", headers={"Authorization": "Bearer t"}
    )
    assert seen["params"] == {"search": "ada", "limit": "10"}


def test_inviting_is_an_action_not_a_commit(monkeypatch):
    seen: dict = {}
    _fake_client(
        monkeypatch,
        {"person": {"id": "new", "email": "ada@example.com", "pending": True}, "mailed": True},
        seen,
        status=202,
    )
    r = TestClient(_app(_settings())).post(
        "/api/v1/admin/people/invite",
        json={"email": "ada@example.com", "groups": ["gentian:tenant:platform:members"]},
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 202
    assert seen["method"] == "POST"
    # /actions/ is the director's way of saying this happens once and leaves
    # no commit. A PUT here would be declaring a person as state.
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/actions/invite-person"
    assert seen["json"] == {"email": "ada@example.com", "groups": ["gentian:tenant:platform:members"]}


def test_an_invitation_whose_mail_failed_still_reports_the_person(monkeypatch):
    seen: dict = {}
    _fake_client(
        monkeypatch,
        {"person": {"id": "new", "email": "ada@example.com"}, "mailed": False, "warning": "smtp down"},
        seen,
        status=202,
    )
    r = TestClient(_app(_settings())).post(
        "/api/v1/admin/people/invite",
        json={"email": "ada@example.com"},
        headers={"Authorization": "Bearer t"},
    )
    # The repair is to re-send, not to invite again, so the screen has to be
    # able to tell the two apart.
    assert r.json()["mailed"] is False
    assert r.json()["person"]["id"] == "new"


def test_membership_says_which_way(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, {"member": False}, seen)
    TestClient(_app(_settings())).post(
        "/api/v1/admin/people/membership",
        json={"person": "u1", "group": "gentian:tenant:platform:members", "member": False},
        headers={"Authorization": "Bearer t"},
    )
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/actions/set-membership"
    assert seen["json"]["member"] is False


def test_the_password_policy_is_read_and_written(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, {"realm": "platform", "passwordPolicy": "length(8)"}, seen)
    client = TestClient(_app(_settings()))

    r = client.get("/api/v1/admin/identity", headers={"Authorization": "Bearer t"})
    assert r.json()["passwordPolicy"] == "length(8)"
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/identity"

    client.post(
        "/api/v1/admin/identity/password-policy",
        json={"passwordPolicy": "length(12)"},
        headers={"Authorization": "Bearer t"},
    )
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/actions/set-password-policy"
    assert seen["json"] == {"passwordPolicy": "length(12)"}


def test_groups_are_served_rather_than_refused(monkeypatch):
    """They used to answer 501 for the Notifications screen.

    The entry said a group-scoped audience waited for the group list to have
    an owner. It has one now, so the entry is gone and this route answers.
    """
    seen: dict = {}
    _fake_client(monkeypatch, {"groups": [{"path": "gentian:tenant:platform:admins"}]}, seen)
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/groups", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/tenants/platform/groups"


def test_a_realm_with_no_credential_is_relayed_as_the_platforms_problem(monkeypatch):
    """503, not 403.

    The caller holds the relation; what is missing is the credential the
    operator writes per realm. Telling them they are forbidden would send
    them to ask for a permission they already have.
    """
    seen: dict = {}
    _fake_client(
        monkeypatch,
        {"error": "this director holds no credential for the realm demo"},
        seen,
        status=503,
    )
    r = TestClient(_app(_settings())).get(
        "/api/v1/admin/people?tenant=demo", headers={"Authorization": "Bearer t"}
    )
    assert r.status_code == 503
    assert "demo" in r.json()["error"]
