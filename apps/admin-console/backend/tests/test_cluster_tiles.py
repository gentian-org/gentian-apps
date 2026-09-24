"""The console asks the director which kernel consoles a person may open.

What matters here is that the console adds no authority of its own. The tile
list is the director's answer about this person, decided from their relations
to the cluster -- not a list the console filters by asking whether the caller
is an administrator. So the caller's own token must reach the director
unchanged, and whatever it answers must come back unchanged.
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


def test_the_callers_token_is_what_reaches_the_director(monkeypatch):
    seen = {}

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, method, url, params=None, json=None, headers=None):
            seen["url"] = url
            seen["auth"] = (headers or {}).get("Authorization")
            return httpx.Response(
                200,
                json={"cluster": "demo", "kernelDomain": "desk.gentian.org", "tiles": []},
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)
    client = TestClient(_app(_settings()))
    r = client.get("/api/v1/cluster/tiles", headers={"Authorization": "Bearer person-token"})

    assert r.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/clusters/demo/tiles"
    # The person's token, not a credential of the console's own.
    assert seen["auth"] == "Bearer person-token"


def test_a_person_with_no_cluster_relation_gets_an_empty_list(monkeypatch):
    """Holding nothing is an ordinary answer, not an error.

    Every tenant user is in this position, and a console that rendered a
    failure for them would be wrong for almost everyone who signs in.
    """

    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, method, url, params=None, json=None, headers=None):
            return httpx.Response(
                200,
                json={"cluster": "demo", "kernelDomain": "desk.gentian.org", "tiles": []},
                request=httpx.Request("GET", url),
            )

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)
    client = TestClient(_app(_settings()))
    r = client.get("/api/v1/cluster/tiles", headers={"Authorization": "Bearer t"})
    assert r.status_code == 200
    assert r.json()["tiles"] == []


def test_an_unconfigured_director_says_so_rather_than_pretending():
    client = TestClient(_app(_settings(director_url=None)))
    r = client.get("/api/v1/cluster/tiles", headers={"Authorization": "Bearer t"})
    assert r.status_code == 503


def test_an_unreachable_director_is_a_gateway_error(monkeypatch):
    class FakeClient:
        def __init__(self, *a, **kw):
            pass

        async def __aenter__(self):
            return self

        async def __aexit__(self, *a):
            return False

        async def request(self, method, url, params=None, json=None, headers=None):
            raise httpx.ConnectError("refused", request=httpx.Request("GET", url))

    monkeypatch.setattr(director.httpx, "AsyncClient", FakeClient)
    client = TestClient(_app(_settings()))
    r = client.get("/api/v1/cluster/tiles", headers={"Authorization": "Bearer t"})
    assert r.status_code == 502


@pytest.mark.parametrize("header", [None, ""])
def test_no_token_is_refused_before_anything_is_forwarded(header):
    client = TestClient(_app(_settings()))
    headers = {"Authorization": header} if header is not None else {}
    r = client.get("/api/v1/cluster/tiles", headers=headers)
    assert r.status_code == 401
