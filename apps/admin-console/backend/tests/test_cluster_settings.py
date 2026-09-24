"""The console reads and writes the cluster's settings through the director.

The same rule as the tile list, for the same reason: the console holds no
credential and decides nothing. The caller's own token goes to the director,
which asks whether that person may audit or configure the cluster, and
whatever it answers comes back unchanged -- including a refusal. A console
that softened a 403 into an empty screen would be inventing an authorisation
answer it has no standing to give.

The write is a commit, not a save. 202 with a commit means git has the change
and the cluster does not yet; 200 means the values already held. Both have to
survive the proxy intact, because the screen shows the difference.
"""

import httpx
import pytest
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import cluster
from app.core import director
from app.core.config import Settings, get_settings


def _app(settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(cluster.router, prefix="/api/v1")
    app.dependency_overrides[get_settings] = lambda: settings
    return app


def _settings(**over) -> Settings:
    return Settings(
        AUTH_DISABLED="true",
        KERNEL_DOMAIN="desk.gentian.org",
        TENANT_ID="platform",
        DIRECTOR_URL=over.pop("director_url", "http://director.test:8080"),
        GENTIAN_CLUSTER_ID=over.pop("cluster_id", "demo"),
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
            seen["json"] = json
            seen["auth"] = (headers or {}).get("Authorization")
            return responder(method, url)

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)
    return FakeClient


CATALOGUE = {
    "cluster": "demo",
    "settings": [
        {
            "path": "mail.serviceMode",
            "doc": "Where mail is sent from.",
            "oneOf": ["kernel", "external"],
            "value": "kernel",
        },
        {"path": "certificates.acmeEnv", "doc": "Which ACME environment issues certificates."},
    ],
}


def test_the_catalogue_and_the_values_arrive_together(monkeypatch):
    seen: dict = {}
    _fake_client(
        monkeypatch,
        lambda m, url: httpx.Response(200, json=CATALOGUE, request=httpx.Request(m, url)),
        seen,
    )
    client = TestClient(_app(_settings()))
    r = client.get("/api/v1/cluster/settings", headers={"Authorization": "Bearer person-token"})

    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/clusters/demo/settings"
    assert seen["auth"] == "Bearer person-token"
    body = r.json()
    # A setting the claim does not carry has no value at all, rather than an
    # empty one: "unset, so the default applies" is a different answer from
    # "set to nothing", and the screen renders them differently.
    assert "value" not in body["settings"][1]


def test_a_change_comes_back_as_a_commit(monkeypatch):
    seen: dict = {}
    _fake_client(
        monkeypatch,
        lambda m, url: httpx.Response(
            202, json={"status": "committed", "commit": "a1b2c3d4"}, request=httpx.Request(m, url)
        ),
        seen,
    )
    client = TestClient(_app(_settings()))
    r = client.patch(
        "/api/v1/cluster/settings",
        json={"settings": {"mail.serviceMode": "external"}},
        headers={"Authorization": "Bearer person-token"},
    )

    assert r.status_code == 202
    assert r.json()["commit"] == "a1b2c3d4"
    assert seen["method"] == "PATCH"
    assert seen["json"] == {"settings": {"mail.serviceMode": "external"}}
    assert seen["auth"] == "Bearer person-token"


def test_setting_what_already_holds_is_not_a_commit(monkeypatch):
    seen: dict = {}
    _fake_client(
        monkeypatch,
        lambda m, url: httpx.Response(
            200, json={"status": "unchanged"}, request=httpx.Request(m, url)
        ),
        seen,
    )
    client = TestClient(_app(_settings()))
    r = client.patch(
        "/api/v1/cluster/settings",
        json={"settings": {"mail.serviceMode": "kernel"}},
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == 200
    assert "commit" not in r.json()


@pytest.mark.parametrize("status", [403, 400, 409])
def test_the_directors_refusal_is_passed_through_unchanged(monkeypatch, status):
    """Including 403. Whether this person may configure the cluster is the
    director's answer, read from the authorization store, and the console must
    not dress it up as anything else."""
    seen: dict = {}
    _fake_client(
        monkeypatch,
        lambda m, url: httpx.Response(
            status, json={"error": "refused"}, request=httpx.Request(m, url)
        ),
        seen,
    )
    client = TestClient(_app(_settings()))
    r = client.patch(
        "/api/v1/cluster/settings",
        json={"settings": {"mail.serviceMode": "external"}},
        headers={"Authorization": "Bearer t"},
    )
    assert r.status_code == status


def test_an_unreachable_director_is_a_gateway_error(monkeypatch):
    def boom(m, url):
        raise httpx.ConnectError("refused", request=httpx.Request(m, url))

    _fake_client(monkeypatch, boom, {})
    client = TestClient(_app(_settings()))
    r = client.get("/api/v1/cluster/settings", headers={"Authorization": "Bearer t"})
    assert r.status_code == 502


def test_no_token_is_refused_before_anything_is_forwarded():
    client = TestClient(_app(_settings()))
    r = client.get("/api/v1/cluster/settings")
    assert r.status_code == 401
