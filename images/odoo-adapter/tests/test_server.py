"""The MCP server: what it offers, and that the caller's credential reaches Odoo."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest
from starlette.testclient import TestClient

import server
from odoo_tools import Odoo, active, load_packs

PACKS = Path(__file__).resolve().parents[1] / "chart" / "packs"
HEADERS = {"Accept": "application/json, text/event-stream", "Content-Type": "application/json"}


def rpc(client: TestClient, method: str, params: dict, authorization: str | None = None) -> dict:
    headers = dict(HEADERS)
    if authorization:
        headers["Authorization"] = authorization
    resp = client.post("/mcp", headers=headers, json={"jsonrpc": "2.0", "id": 1, "method": method, "params": params})
    assert resp.status_code == 200, resp.text
    return resp.json()["result"]


@pytest.fixture
def odoo_calls():
    return []


@pytest.fixture
def client(odoo_calls):
    def answer(request: httpx.Request) -> httpx.Response:
        odoo_calls.append((request.url.path, request.headers.get("authorization")))
        return httpx.Response(200, json=[{"id": 1, "name": "Anna"}])

    tools = active(load_packs(PACKS), {"contacts"})
    app = server.app(tools, Odoo("http://odoo:8069", transport=httpx.MockTransport(answer)))
    with TestClient(app) as c:
        yield c


def test_health_answers_without_odoo(client, odoo_calls):
    assert client.get("/healthz").json() == {"status": "ok", "tools": 4}
    assert odoo_calls == []


def test_only_the_active_modules_tools_are_listed_with_their_class(client):
    tools = rpc(client, "tools/list", {})["tools"]
    assert {t["name"] for t in tools} == {"search-contacts.v1", "get-contact.v1", "create-contact.v1", "update-contact.v1"}
    search = next(t for t in tools if t["name"] == "search-contacts.v1")
    assert search["_meta"]["gentianos.io/class"] == "read"
    assert search["annotations"]["readOnlyHint"] is True
    assert search["inputSchema"]["additionalProperties"] is False


def test_a_tool_call_reaches_odoo_with_the_callers_credential(client, odoo_calls):
    result = rpc(client, "tools/call", {"name": "search-contacts.v1", "arguments": {"query": "an"}}, "Bearer anna")
    assert result.get("isError") is not True
    assert json.loads(result["content"][0]["text"])["count"] == 1
    assert odoo_calls == [("/json/2/res.partner/search_read", "Bearer anna")]


def test_a_tool_call_without_a_credential_is_an_error_and_reaches_nothing(client, odoo_calls):
    result = rpc(client, "tools/call", {"name": "search-contacts.v1", "arguments": {}})
    assert result["isError"] is True
    assert "no bearer credential" in result["content"][0]["text"]
    assert odoo_calls == []


def test_a_tool_of_an_inactive_module_cannot_be_called(client, odoo_calls):
    result = rpc(client, "tools/call", {"name": "search-opportunities.v1", "arguments": {}}, "Bearer anna")
    assert result["isError"] is True
    assert odoo_calls == []


def test_an_argument_outside_the_schema_is_refused_before_odoo(client, odoo_calls):
    result = rpc(client, "tools/call", {"name": "search-contacts.v1", "arguments": {"domain": []}}, "Bearer anna")
    assert result["isError"] is True
    assert odoo_calls == []


@pytest.mark.parametrize(("value", "expected"), [(None, None), ("", set()), ("crm, contacts", {"crm", "contacts"})])
def test_the_active_modules_come_from_the_environment(value, expected):
    assert server.modules_from_env(value) == expected
