"""The tool packs, and what a tool turns into at Odoo."""

from __future__ import annotations

import json
from pathlib import Path

import httpx
import pytest

from odoo_tools import Odoo, PackError, ToolError, active, load_pack, load_packs, plan

PACKS = Path(__file__).resolve().parents[1] / "chart" / "packs"
BEARER = "Bearer person-token"


@pytest.fixture(scope="module")
def tools():
    return {t.key: t for t in load_packs(PACKS)}


def write_pack(tmp_path: Path, body: str) -> Path:
    path = tmp_path / "pack.yaml"
    path.write_text(body, encoding="utf-8")
    return path


# --- The shipped packs -------------------------------------------------------


def test_the_shipped_packs_load(tools):
    assert set(tools) == {
        "search-contacts.v1", "get-contact.v1", "create-contact.v1", "update-contact.v1",
        "search-opportunities.v1", "get-opportunity.v1", "list-stages.v1", "create-opportunity.v1",
        "update-opportunity.v1", "log-note.v1", "send-email.v1",
    }


def test_sending_mail_is_the_one_irreversible_tool(tools):
    assert [k for k, t in tools.items() if t.cls == "irreversible"] == ["send-email.v1"]


def test_every_input_schema_refuses_what_it_does_not_name(tools):
    for tool in tools.values():
        schema = tool.input_schema()
        assert schema["additionalProperties"] is False
        assert set(schema["required"]) <= set(schema["properties"])


def test_only_the_active_modules_tools_are_offered(tools):
    everything = list(tools.values())
    assert {t.module for t in active(everything, {"contacts"})} == {"contacts"}
    assert active(everything, set()) == []
    assert active(everything, None) == everything


# --- What a pack may say -----------------------------------------------------


@pytest.mark.parametrize(
    ("body", "why"),
    [
        ("module: crm\ntools: []\n", "at least one tool"),
        (
            "module: crm\ntools:\n- {name: x-y, version: 1, class: change, description: d, model: crm.lead, "
            "operation: search, fields: [id]}\n",
            "class read",
        ),
        (
            "module: crm\ntools:\n- {name: x-y, version: 1, class: read, description: d, model: crm.lead, "
            "operation: write, inputs: {i: {description: d, target: true}, n: {description: d, field: name}}}\n",
            "cannot write",
        ),
        (
            "module: crm\ntools:\n- {name: x-y, version: 1, class: change, description: d, model: crm.lead, "
            "operation: write, inputs: {n: {description: d, field: name}}}\n",
            "exactly one target",
        ),
        (
            "module: crm\ntools:\n- {name: x-y, version: 1, class: change, description: d, model: crm.lead, "
            "operation: call, method: message_post, inputs: {i: {description: d, target: true}, "
            "x: {description: d, argument: ids}}}\n",
            "never ids or context",
        ),
        (
            "module: crm\ntools:\n- {name: x-y, version: 1, class: read, description: d, model: crm.lead, "
            "operation: search, fields: [id], inputs: {q: {match: [name]}}}\n",
            "no description",
        ),
        (
            "module: crm\ntools:\n- {name: x-y, version: 1, class: change, description: d, model: crm.lead, "
            "operation: create, values: {name: a}, inputs: {n: {description: d, field: name}}}\n",
            "not two",
        ),
    ],
)
def test_a_pack_that_cannot_be_used_is_refused(tmp_path, body, why):
    with pytest.raises(PackError, match=why):
        load_pack(write_pack(tmp_path, body))


def test_a_tool_key_is_offered_once(tmp_path):
    tool = (
        "module: {m}\ntools:\n- {{name: x-y, version: 1, class: read, description: d, model: res.partner, "
        "operation: search, fields: [id]}}\n"
    )
    (tmp_path / "a.yaml").write_text(tool.format(m="contacts"), encoding="utf-8")
    (tmp_path / "b.yaml").write_text(tool.format(m="crm"), encoding="utf-8")
    with pytest.raises(PackError, match="also in a.yaml"):
        load_packs(tmp_path)


# --- From arguments to calls -------------------------------------------------


def test_a_search_matches_any_of_its_paths_within_the_domain(tools):
    (call,) = plan(tools["search-opportunities.v1"], {"query": "acme", "limit": 500})
    assert call.model == "crm.lead" and call.method == "search_read"
    assert call.body["domain"] == [
        ["type", "=", "opportunity"],
        "|", "|", "|",
        ["name", "ilike", "acme"], ["partner_id.name", "ilike", "acme"],
        ["contact_name", "ilike", "acme"], ["email_from", "ilike", "acme"],
    ]
    assert call.body["limit"] == 100  # held to the pack's maximum


def test_a_search_without_a_limit_takes_the_default(tools):
    (call,) = plan(tools["search-contacts.v1"], {})
    assert call.body["limit"] == 20 and call.body["domain"] == []


def test_a_write_finds_its_target_within_the_domain_first(tools):
    find, write = plan(tools["update-opportunity.v1"], {"opportunity_id": 7, "stage_id": 3, "probability": 40})
    assert find.method == "search"
    assert find.body["domain"] == [["id", "=", 7], ["type", "=", "opportunity"]]
    assert write.body == {"ids": [7], "vals": {"stage_id": 3, "probability": 40}}


def test_a_write_with_nothing_to_change_is_refused(tools):
    with pytest.raises(ToolError, match="at least one value"):
        plan(tools["update-opportunity.v1"], {"opportunity_id": 7})


def test_a_create_adds_the_packs_fixed_values(tools):
    (call,) = plan(tools["create-opportunity.v1"], {"name": "Pilot", "customer_id": 12})
    assert call.body == {"vals_list": [{"type": "opportunity", "name": "Pilot", "partner_id": 12}]}


def test_a_call_passes_fixed_and_given_arguments(tools):
    _, post = plan(tools["send-email.v1"], {"opportunity_id": 7, "recipient_ids": [3], "body": "Hello"})
    assert post.method == "message_post"
    assert post.body == {
        "ids": [7], "message_type": "comment", "subtype_xmlid": "mail.mt_comment",
        "partner_ids": [3], "body": "Hello",
    }


@pytest.mark.parametrize("args", [{"opportunity_id": 7, "ids": [1, 2]}, {"opportunity_id": 7, "context": {}}])
def test_an_argument_the_tool_does_not_name_is_refused(tools, args):
    with pytest.raises(ToolError, match="takes no"):
        plan(tools["log-note.v1"], {**args, "body": "x"})


@pytest.mark.parametrize("record", [0, -1, True, "7"])
def test_a_target_is_a_record_id(tools, record):
    with pytest.raises(ToolError, match="record id"):
        plan(tools["get-opportunity.v1"], {"opportunity_id": record})


# --- Calling Odoo ------------------------------------------------------------


class FakeOdoo:
    """Answers JSON-2 calls from a table, and records what it was asked."""

    def __init__(self, answers: dict[str, tuple[int, object]]):
        self.answers = answers
        self.seen: list[tuple[str, dict, dict]] = []

    def __call__(self, request: httpx.Request) -> httpx.Response:
        path = request.url.path.removeprefix("/json/2/")
        self.seen.append((path, json.loads(request.content), dict(request.headers)))
        status, body = self.answers.get(path, (404, {"message": "no such route"}))
        return httpx.Response(status, json=body)


def odoo(answers, database=None):
    fake = FakeOdoo(answers)
    return Odoo("http://odoo:8069", database, transport=httpx.MockTransport(fake)), fake


def test_a_call_carries_the_callers_credential_and_nothing_else(tools):
    client, fake = odoo({"crm.lead/search_read": (200, [{"id": 1, "name": "Pilot"}])}, database="demo")
    answer = client.run(tools["search-opportunities.v1"], {"query": "pil"}, BEARER)
    assert answer == {"records": [{"id": 1, "name": "Pilot"}], "count": 1}
    (_, _, headers), = fake.seen
    assert headers["authorization"] == BEARER
    assert headers["x-odoo-database"] == "demo"


def test_without_a_bearer_credential_nothing_is_called(tools):
    client, fake = odoo({})
    for credential in ("", "Basic dXNlcjpwYXNz", "Bearer "):
        with pytest.raises(ToolError, match="no bearer credential"):
            client.run(tools["search-contacts.v1"], {}, credential)
    assert fake.seen == []


def test_a_write_outside_the_domain_changes_nothing(tools):
    client, fake = odoo({"crm.lead/search": (200, []), "crm.lead/write": (200, True)})
    with pytest.raises(ToolError, match="may change"):
        client.run(tools["update-opportunity.v1"], {"opportunity_id": 9, "name": "x"}, BEARER)
    assert [p for p, _, _ in fake.seen] == ["crm.lead/search"]


def test_a_write_within_the_domain_says_what_it_changed(tools):
    client, _ = odoo({"crm.lead/search": (200, [9]), "crm.lead/write": (200, True)})
    answer = client.run(tools["update-opportunity.v1"], {"opportunity_id": 9, "name": "x", "probability": 10}, BEARER)
    assert answer == {"id": 9, "changed": ["name", "probability"]}


def test_a_create_answers_the_new_id(tools):
    client, _ = odoo({"res.partner/create": (200, [42])})
    assert client.run(tools["create-contact.v1"], {"name": "Anna"}, BEARER) == {"id": 42}


@pytest.mark.parametrize(
    ("status", "words"),
    [(401, "refused the credential"), (403, "does not let this person"), (404, "module installed"),
     (422, "refused crm.lead.search_read")],
)
def test_odoos_refusals_are_told_in_words(tools, status, words):
    client, _ = odoo({"crm.lead/search_read": (status, {"message": "because"})})
    with pytest.raises(ToolError, match=words):
        client.run(tools["search-opportunities.v1"], {}, BEARER)


def test_a_read_of_a_record_it_may_not_see_says_so(tools):
    client, _ = odoo({"crm.lead/search_read": (200, [])})
    with pytest.raises(ToolError, match="may read"):
        client.run(tools["get-opportunity.v1"], {"opportunity_id": 5}, BEARER)
