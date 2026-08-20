"""The header exists to be trusted before an install, so its edges matter.

Each case here is a way the bar could mislead: a ceiling that is absent read as
zero, a value that cannot be parsed read as empty, or an over-subscribed quota
drawn wider than its own track.
"""

from __future__ import annotations

from app.services.tenant_quota import summarize_quota


def _quota(hard: dict[str, str], used: dict[str, str]) -> dict:
    return {"status": {"hard": hard, "used": used}}


def _by_name(summary: dict) -> dict[str, dict]:
    return {entry["name"]: entry for entry in summary["resources"]}


def test_reports_used_against_hard():
    summary = summarize_quota(
        _quota(
            {"limits.cpu": "6", "limits.memory": "6Gi", "requests.storage": "100Gi"},
            {"limits.cpu": "3950m", "limits.memory": "3584Mi", "requests.storage": "12Gi"},
        )
    )
    assert summary["present"] is True
    entries = _by_name(summary)

    cpu = entries["limits.cpu"]
    assert (cpu["used"], cpu["hard"], cpu["label"]) == ("3950m", "6", "CPU")
    assert cpu["percent"] == 65.8

    # Mi against Gi: the numbers only compare once both are bytes.
    assert entries["limits.memory"]["percent"] == 58.3
    assert entries["requests.storage"]["percent"] == 12.0


def test_no_quota_is_not_a_full_bar():
    for empty in (None, {}, {"status": {}}):
        summary = summarize_quota(empty)
        assert summary["present"] is False
        assert summary["resources"] == []


def test_absent_ceiling_is_omitted_not_zero():
    summary = summarize_quota(_quota({"limits.cpu": "4"}, {"limits.cpu": "1"}))
    assert list(_by_name(summary)) == ["limits.cpu"]


def test_unset_usage_reads_as_nothing_used():
    summary = summarize_quota(_quota({"limits.cpu": "4"}, {}))
    cpu = _by_name(summary)["limits.cpu"]
    assert cpu["usedValue"] == 0.0
    assert cpu["percent"] == 0.0


def test_over_subscribed_quota_is_clamped():
    # A quota lowered under what is already running: real, and it must not draw
    # a bar wider than its track.
    summary = summarize_quota(_quota({"limits.cpu": "2"}, {"limits.cpu": "3"}))
    assert _by_name(summary)["limits.cpu"]["percent"] == 100.0


def test_unparsable_values_do_not_render_as_empty():
    # A ceiling that cannot be read is dropped entirely; showing it as 0 used
    # of 0 would read as "nothing used" on a quota that may be full.
    summary = summarize_quota(_quota({"limits.cpu": "not-a-quantity"}, {"limits.cpu": "1"}))
    assert summary["present"] is False

    # An unreadable *usage* against a real ceiling still shows the ceiling.
    summary = summarize_quota(_quota({"limits.cpu": "4"}, {"limits.cpu": "??"}))
    assert _by_name(summary)["limits.cpu"]["usedValue"] == 0.0


def test_spec_hard_is_used_before_status_is_populated():
    summary = summarize_quota({"spec": {"hard": {"limits.cpu": "8"}}, "status": {}})
    assert _by_name(summary)["limits.cpu"]["hard"] == "8"
