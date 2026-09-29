"""The cluster's own catalogue screen: a relay, and nothing more.

What is worth pinning here is not the plumbing but the DIVISION. Which
editions are listed, which entries may be installed and which digest is
trustworthy are all the director's answers; this component must not have an
opinion about any of them, because a second opinion is a second answer to the
same question.
"""

import httpx
from fastapi import FastAPI
from fastapi.testclient import TestClient

from app.api.routes import catalogue
from app.core import director
from app.core.config import Settings, get_settings


# The relay forwards the CALLER's bearer, so every call carries one even
# where authentication is disabled: it is the token the director decides by.
_auth = {"Authorization": "Bearer t"}


def _app(settings: Settings) -> FastAPI:
    app = FastAPI()
    app.include_router(catalogue.router, prefix="/api/v1")
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


def test_the_sources_screen_asks_the_director_and_carries_the_store(monkeypatch):
    seen: dict = {}
    _fake_client(
        monkeypatch,
        {
            "tenant": "demo",
            "storeUrl": "https://store.gentian.org",
            "catalogues": [
                {"name": "main", "access": "entitled", "open": False},
                {"name": "in-house", "access": "open", "open": True},
            ],
        },
        seen,
    )
    client = TestClient(_app(_settings()))
    answer = client.get("/api/v1/catalogue/sources?tenant=demo", headers=_auth)
    assert answer.status_code == 200
    assert seen["url"] == "http://director.test:8080/v1/tenants/demo/catalogues"
    # The store travels with the list, because "go to the App Store" is the
    # honest answer to most of this screen and it needs somewhere to point.
    assert answer.json()["storeUrl"] == "https://store.gentian.org"


def test_entries_are_relayed_untouched(monkeypatch):
    seen: dict = {}
    body = {
        "tenant": "demo",
        "catalogue": "in-house",
        "open": True,
        "storeOnly": 7,
        "entries": [
            {
                "coordinate": "in-house/timesheets",
                "name": "timesheets",
                "version": "2.1.0",
                "edition": "pe",
                "digest": "sha256:" + "a" * 64,
                "installable": True,
            }
        ],
    }
    _fake_client(monkeypatch, body, seen)
    client = TestClient(_app(_settings()))
    answer = client.get("/api/v1/catalogue/sources/in-house/entries?tenant=demo", headers=_auth)
    assert answer.status_code == 200
    assert seen["url"] == (
        "http://director.test:8080/v1/tenants/demo/catalogues/in-house/entries"
    )
    # Verbatim: which editions are listed and what may be installed are the
    # director's to decide, and re-deciding them here would be a second answer.
    assert answer.json() == body


def test_a_refusal_comes_back_as_the_director_gave_it(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, {"error": "forbidden"}, seen, status=403)
    client = TestClient(_app(_settings()))
    assert client.get("/api/v1/catalogue/sources?tenant=other", headers=_auth).status_code == 403


def test_without_a_tenant_the_component_asks_about_its_own(monkeypatch):
    seen: dict = {}
    _fake_client(monkeypatch, {"catalogues": []}, seen)
    client = TestClient(_app(_settings()))
    assert client.get("/api/v1/catalogue/sources", headers=_auth).status_code == 200
    assert seen["url"].endswith("/v1/tenants/platform/catalogues")
