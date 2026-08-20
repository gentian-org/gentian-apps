"""What the tenant has, and what is left of it.

A tenant's ResourceQuota is the ceiling every install is admitted against, and
until now nothing showed it to the person doing the installing. The failure
that follows is quiet and late: the claim reports Ready because Helm succeeded,
while the workload underneath is refused every pod for want of a few hundred
millicores. Showing the headroom before the install is the cheap half of that
problem.

Only the quota is read here. It is the number the API server actually enforces,
so a display built from anything else — summed pod specs, chart defaults —
could disagree with the admission decision it is meant to predict.
"""

from __future__ import annotations

from typing import Any

from kubernetes.utils import parse_quantity

# The three the tenant claim exposes, in the order they matter to someone
# deciding whether an app fits. Names are the quota's own keys; the labels are
# what the store shows.
_TRACKED: list[tuple[str, str, str]] = [
    ("limits.cpu", "CPU", "cores"),
    ("limits.memory", "Memory", "bytes"),
    ("requests.storage", "Storage", "bytes"),
    ("pods", "Pods", "count"),
]


def _as_float(quantity: str | None) -> float | None:
    """A quota quantity as a number, or None when it cannot be read.

    None is not zero. A quantity this cannot parse must not render as an empty
    bar, which reads as "nothing used" — the caller drops the entry instead.
    """
    if quantity is None:
        return None
    try:
        return float(parse_quantity(str(quantity)))
    except (ValueError, TypeError):
        return None


def summarize_quota(quota: dict[str, Any] | None) -> dict[str, Any]:
    """Shape a ResourceQuota for the store header.

    Returns present=False when the tenant has no quota at all, which is a real
    configuration — unlimited — and must not be drawn as a full bar.
    """
    if not quota:
        return {"present": False, "resources": []}

    status = quota.get("status") or {}
    hard = status.get("hard") or (quota.get("spec") or {}).get("hard") or {}
    used = status.get("used") or {}

    resources: list[dict[str, Any]] = []
    for key, label, unit in _TRACKED:
        hard_value = _as_float(hard.get(key))
        if hard_value is None or hard_value <= 0:
            # Not every cluster sets every key, and an absent ceiling is not a
            # ceiling of zero.
            continue
        used_value = _as_float(used.get(key)) or 0.0
        resources.append(
            {
                "name": key,
                "label": label,
                "unit": unit,
                "used": str(used.get(key, "0")),
                "hard": str(hard.get(key)),
                "usedValue": used_value,
                "hardValue": hard_value,
                # Clamped: a quota lowered below what is already running yields
                # more than 100%, and a bar wider than its track is a rendering
                # bug rather than information.
                "percent": min(100.0, round(used_value / hard_value * 100, 1)),
            }
        )

    return {"present": bool(resources), "resources": resources}
