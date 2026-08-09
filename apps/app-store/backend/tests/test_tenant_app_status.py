"""The store must say *why* an install is stuck, not that it is stuck.

Crossplane writes one sentence on every unready claim — "Claim is waiting for
composite resource to become Ready" — whether provisioning is advancing or has
been wedged for an hour. _blocking_detail digs a resource-level reason out of
the composite to replace it. These tests cover the two ways that reason got
lost: swallowed on the way up, and overwritten on the way out.
"""

from __future__ import annotations

from typing import Any

from app.services.tenant_app_status import _entry_from_claim, merge_lifecycle_status

GENERIC = "Claim is waiting for composite resource to become Ready"


def _claim(ready: bool = False, message: str = GENERIC) -> dict[str, Any]:
    return {
        "metadata": {"name": "odoo-base-ce"},
        "spec": {"resourceRef": {"name": "odoo-base-ce-z9zjh"}},
        "status": {
            "conditions": [
                {
                    "type": "Ready",
                    "status": "True" if ready else "False",
                    "message": message,
                }
            ]
        },
    }


class FakeK8s:
    """Composite naming one composed resource whose Synced condition failed."""

    def __init__(self, synced_message: str | None = "no matching Helm chart") -> None:
        self._synced_message = synced_message

    def get_composite(self, plural: str, name: str) -> dict[str, Any]:
        assert plural == "xapps"
        return {
            "spec": {
                "resourceRefs": [
                    {
                        "name": "odoo-base-ce-z9zjh-release",
                        "kind": "Release",
                        "apiVersion": "helm.crossplane.io/v1beta1",
                    }
                ]
            },
            "status": {"conditions": [{"type": "Ready", "message": GENERIC}]},
        }

    def get_composed(
        self, api: str, kind: str, name: str, namespace: str | None
    ) -> dict[str, Any]:
        return {
            "status": {
                "conditions": [
                    {
                        "type": "Synced",
                        "status": "False",
                        "message": self._synced_message,
                    }
                ]
            }
        }


class ExplodingK8s:
    def get_composite(self, plural: str, name: str) -> dict[str, Any]:
        raise RuntimeError("the API server said no")


def test_resource_level_reason_replaces_the_generic_sentence() -> None:
    entry = _entry_from_claim("odoo-base-ce", _claim(), FakeK8s())
    assert entry["message"] == "Release odoo-base-ce-z9zjh-release: no matching Helm chart"
    assert entry["detail"] == entry["message"]
    assert entry["ready"] is False


def test_lookup_failure_is_logged_not_swallowed(caplog: Any) -> None:
    with caplog.at_level("WARNING"):
        entry = _entry_from_claim("odoo-base-ce", _claim(), ExplodingK8s())
    # The listing still renders...
    assert entry["message"] == GENERIC
    assert entry["detail"] is None
    # ...but the failure is visible, rather than looking like "nothing to report".
    assert any("could not determine why" in r.message for r in caplog.records)


def test_ready_claim_costs_no_extra_lookups() -> None:
    class Forbidden:
        def get_composite(self, *a: Any, **k: Any) -> Any:
            raise AssertionError("must not inspect the composite for a ready claim")

    entry = _entry_from_claim("odoo-base-ce", _claim(ready=True, message="Ready"), Forbidden())
    assert entry["ready"] is True
    assert entry["detail"] is None


def test_lifecycle_merge_keeps_the_detail() -> None:
    """The bug this fixes: the lifecycle overlay used to carry its generic
    message across wholesale, so adding _blocking_detail changed nothing the
    user could see."""
    entry = _entry_from_claim("odoo-base-ce", _claim(), FakeK8s())
    detailed = entry["message"]
    assert detailed != GENERIC

    merged = merge_lifecycle_status(entry, {"ready": False, "message": GENERIC})
    assert merged["message"] == detailed


def test_lifecycle_merge_still_wins_on_readiness() -> None:
    """Readiness is the lifecycle service's to decide — it sees installs that
    have no claim yet — so the overlay must not be reduced to a no-op."""
    entry = _entry_from_claim("odoo-base-ce", _claim(), FakeK8s())
    merged = merge_lifecycle_status(entry, {"ready": True, "message": "Ready"})
    assert merged["ready"] is True
    assert merged["phase"] == "ready"
    assert merged["message"] == "Ready"


def test_lifecycle_merge_without_a_detail_uses_the_generic_message() -> None:
    entry = _entry_from_claim("odoo-base-ce", _claim(), ExplodingK8s())
    merged = merge_lifecycle_status(entry, {"ready": False, "message": GENERIC})
    assert merged["message"] == GENERIC
