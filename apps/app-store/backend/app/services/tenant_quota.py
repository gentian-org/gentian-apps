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

# Helper pods the platform runs beside an app — post-install Jobs and the like.
# They are labelled with the app they serve, but they are not the app, and they
# come and go; counting them would make an app's share flicker.
_COMPONENT_LABEL = "gentianos.io/component"
_APP_LABEL = "gentianos.io/app"

# A pod in a terminal phase has released what it reserved.
_TERMINAL_PHASES = {"Succeeded", "Failed"}

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


def _container_limits(container: Any) -> tuple[float, float]:
    resources = getattr(container, "resources", None)
    limits = getattr(resources, "limits", None) or {}
    return (
        _as_float(limits.get("cpu")) or 0.0,
        _as_float(limits.get("memory")) or 0.0,
    )


def _pod_limits(pod: Any) -> tuple[float, float]:
    """What one pod reserves, the way the quota counts it.

    Not a plain sum of every container: init containers run before the others
    and their reservation is released, so the effective figure is the larger of
    the running set's total and the biggest single init container. Summing all
    of them would over-report an app whose init step is its heaviest, and the
    panel above is drawn from the quota's own totals — a breakdown that does not
    add up to them is worse than none.
    """
    spec = getattr(pod, "spec", None)
    if spec is None:
        return 0.0, 0.0

    cpu = mem = 0.0
    for container in getattr(spec, "containers", None) or []:
        c, m = _container_limits(container)
        cpu += c
        mem += m

    for container in getattr(spec, "init_containers", None) or []:
        c, m = _container_limits(container)
        cpu = max(cpu, c)
        mem = max(mem, m)

    return cpu, mem


def summarize_app_usage(pods: list[Any]) -> list[dict[str, Any]]:
    """Per-app share of the tenant's quota, largest first.

    Attributed by the gentianos.io/app label, which the platform puts on every
    pod an app owns — including its sidecars. A pod without it belongs to no
    app and is left out of the breakdown rather than guessed at; the totals in
    the panel above come from the quota itself, so anything unattributed shows
    up there as the difference rather than being silently reassigned.
    """
    totals: dict[str, dict[str, float]] = {}
    for pod in pods:
        metadata = getattr(pod, "metadata", None)
        labels = getattr(metadata, "labels", None) or {}
        profile = labels.get(_APP_LABEL)
        if not profile or labels.get(_COMPONENT_LABEL):
            continue
        if getattr(getattr(pod, "status", None), "phase", None) in _TERMINAL_PHASES:
            continue
        cpu, mem = _pod_limits(pod)
        entry = totals.setdefault(profile, {"cpu": 0.0, "memory": 0.0})
        entry["cpu"] += cpu
        entry["memory"] += mem

    return sorted(
        (
            {"profile": profile, "cpuValue": values["cpu"], "memoryValue": values["memory"]}
            for profile, values in totals.items()
        ),
        key=lambda entry: (-entry["cpuValue"], -entry["memoryValue"], entry["profile"]),
    )
