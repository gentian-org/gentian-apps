from __future__ import annotations

import logging
from typing import Any

from app.services.catalogue import PLATFORM_ANNOTATION
from app.services.k8s_client import K8sClient

logger = logging.getLogger(__name__)


def _is_platform_profile(k8s: K8sClient, profile: str) -> bool:
    try:
        app_profile = k8s.get_app_profile(profile)
    except Exception:
        return False
    annotations = app_profile.get("metadata", {}).get("annotations") or {}
    return annotations.get(PLATFORM_ANNOTATION) == "true"


def _claim_status(claim: dict[str, Any]) -> tuple[bool, str]:
    conditions = claim.get("status", {}).get("conditions") or []
    for condition in conditions:
        if condition.get("type") != "Ready":
            continue
        if condition.get("status") == "True":
            return True, str(condition.get("message") or "Ready")
        return False, str(condition.get("message") or "Installing — provisioning in progress")
    return False, "Installing — waiting for app to become ready"


def _condition(obj: dict[str, Any], kind: str) -> dict[str, Any]:
    for c in (obj.get("status", {}) or {}).get("conditions") or []:
        if c.get("type") == kind:
            return c
    return {}


# Container waiting reasons that mean the workload is broken rather than slow.
# Each is something no amount of further waiting fixes on its own: a bad image
# reference, a missing Secret key, or a process that exits on every start.
_BROKEN_WAITING_REASONS = {
    "CrashLoopBackOff",
    "ImagePullBackOff",
    "ErrImagePull",
    "InvalidImageName",
    "CreateContainerConfigError",
    "CreateContainerError",
}

# A container that has restarted a couple of times is still plausibly waiting on
# a dependency that is coming up — the retry-until-ready contract that init and
# bootstrap containers rely on. Past this, it is looping, not starting.
_CRASH_RESTART_THRESHOLD = 3


def _pod_failure(pod: Any) -> str | None:
    """The reason this pod is broken, or None if it is merely still starting."""
    status = getattr(pod, "status", None)
    if status is None:
        return None
    name = getattr(getattr(pod, "metadata", None), "name", "pod")

    for cs in (getattr(status, "container_statuses", None) or []):
        waiting = getattr(getattr(cs, "state", None), "waiting", None)
        if waiting is None or waiting.reason not in _BROKEN_WAITING_REASONS:
            continue
        restarts = getattr(cs, "restart_count", 0) or 0
        # CrashLoopBackOff is the one reason that is normal early on: a
        # container waiting for its database to accept connections looks
        # exactly like one that is broken, until it keeps happening.
        if waiting.reason == "CrashLoopBackOff" and restarts < _CRASH_RESTART_THRESHOLD:
            continue
        detail = (waiting.message or "").strip()
        suffix = f" — {detail}" if detail else ""
        restart_note = f" after {restarts} restarts" if restarts else ""
        return f"{name}: {waiting.reason}{restart_note}{suffix}"

    for cond in (getattr(status, "conditions", None) or []):
        if (
            cond.type == "PodScheduled"
            and cond.status == "False"
            and cond.reason == "Unschedulable"
        ):
            detail = (cond.message or "").strip()
            return f"{name}: Unschedulable{f' — {detail}' if detail else ''}"
    return None


def _workload_failure(k8s: K8sClient, namespace: str, profile: str) -> str | None:
    """Why this app's own workload is broken, if it is.

    Selects on the label the platform guarantees for every app pod
    (gentianos.io/app, promoted from annotations by Kyverno for charts that
    cannot set pod labels themselves), and skips the platform's own helper pods:
    a post-install Job that exits non-zero until its app is reachable is
    following its documented retry contract, not failing.
    """
    for pod in k8s.list_pods(namespace, f"gentianos.io/app={profile}"):
        labels = getattr(getattr(pod, "metadata", None), "labels", None) or {}
        if labels.get("gentianos.io/component"):
            continue
        failure = _pod_failure(pod)
        if failure:
            return failure
    return None


def _blocking_detail(k8s: K8sClient, claim: dict[str, Any]) -> str | None:
    """Explain *why* a claim is not ready yet.

    Crossplane always writes the same sentence on a claim — "Claim is waiting for
    composite resource to become Ready" — whether provisioning is advancing
    normally or has been wedged for an hour. That single message is the whole
    reason an install looks like it failed silently.

    The useful information is one and two levels down: the composite names the
    resources it is still waiting on, and a resource that has actually failed
    carries the error on its own Synced condition. Only the resources the
    composite names as unready are fetched, so this costs a couple of extra reads
    for an app that is mid-install and none for one that is ready.
    """
    xr_name = (claim.get("spec", {}) or {}).get("resourceRef", {}).get("name")
    if not xr_name:
        return None
    xr = k8s.get_composite("xapps", xr_name)
    if xr is None:
        return None

    # A real error surfaces on a composed resource, so prefer it over the
    # composite's "still waiting" summary.
    for ref in (xr.get("spec", {}) or {}).get("resourceRefs") or []:
        name, kind, api = ref.get("name"), ref.get("kind"), ref.get("apiVersion")
        if not (name and kind and api):
            continue
        obj = k8s.get_composed(api, kind, name, ref.get("namespace"))
        if obj is None:
            continue
        synced = _condition(obj, "Synced")
        if synced.get("status") == "False" and synced.get("message"):
            return f"{kind} {name}: {synced['message']}"

    ready = _condition(xr, "Ready")
    return str(ready.get("message")) if ready.get("message") else None


def _entry_from_claim(
    profile: str, claim: dict[str, Any], k8s: K8sClient | None = None
) -> dict[str, Any]:
    ready, message = _claim_status(claim)
    detail: str | None = None
    failure: str | None = None
    if not ready and k8s is not None:
        namespace = claim.get("metadata", {}).get("namespace")
        if namespace:
            try:
                failure = _workload_failure(k8s, namespace, profile)
            except Exception:
                logger.warning(
                    "could not inspect %s workload pods", profile, exc_info=True
                )
        try:
            detail = _blocking_detail(k8s, claim)
        except Exception:
            # Never fail the listing over the explanation — but say so. A silent
            # `detail = None` here is indistinguishable from "nothing to report",
            # which is precisely the generic message this function exists to
            # replace, so swallowing it hides the fault twice over.
            logger.warning(
                "could not determine why %s is not ready", profile, exc_info=True
            )
        # A broken workload beats "waiting for composite resource": it names the
        # thing that is actually wrong instead of the layer that is blocked on it.
        if failure:
            message = failure
        elif detail:
            message = detail
    return {
        "profile": profile,
        "name": claim.get("metadata", {}).get("name"),
        "ready": ready,
        # "failing" rather than "failed": Kubernetes keeps restarting the
        # workload, so this can still recover on its own once the cause is
        # fixed. It says "something is wrong, look at it" without claiming the
        # install has been abandoned.
        "phase": "ready" if ready else ("failing" if failure else "installing"),
        "message": message,
        # Kept separately so a later merge can tell an explanation apart from a
        # placeholder — see list_installed in api/routes/tenant_apps.py.
        "detail": detail,
        "failure": failure,
        "conditions": claim.get("status", {}).get("conditions") or [],
    }


def _entry_installing(profile: str, message: str | None = None) -> dict[str, Any]:
    return {
        "profile": profile,
        "ready": False,
        "phase": "installing",
        "message": message or "Install requested — waiting for provisioning",
    }


def list_from_k8s(k8s: K8sClient, tenant: str, namespace: str) -> list[dict[str, Any]]:
    profiles: list[str] = []
    try:
        tenant_cr = k8s.get_tenant(tenant)
        for app in tenant_cr.get("spec", {}).get("apps") or []:
            profile = app.get("profile")
            if not profile or _is_platform_profile(k8s, profile):
                continue
            profiles.append(profile)
    except Exception:
        return []

    claims_by_profile: dict[str, dict[str, Any]] = {}
    for claim in k8s.list_apps_in_namespace(namespace):
        profile = claim.get("spec", {}).get("profileRef", {}).get("name")
        if profile:
            claims_by_profile[profile] = claim

    entries: list[dict[str, Any]] = []
    for profile in profiles:
        claim = claims_by_profile.get(profile)
        if claim:
            entries.append(_entry_from_claim(profile, claim, k8s))
        else:
            entries.append(_entry_installing(profile))
    return entries


def merge_lifecycle_status(
    entry: dict[str, Any], lifecycle_app: dict[str, Any]
) -> dict[str, Any]:
    """Overlay the lifecycle service's view of an app onto its k8s-derived entry.

    The lifecycle service is authoritative for readiness: it sees an install
    that has been requested but has no claim yet. It is useless for *why*,
    because it reads the claim's Ready condition and that is always Crossplane's
    "Claim is waiting for composite resource to become Ready" — the same
    sentence whether provisioning is advancing or wedged.

    So readiness comes from the lifecycle service and the explanation stays with
    whatever list_from_k8s dug out of the composite. Letting the overlay carry
    its message across wholesale is what made _blocking_detail invisible: the
    reason was computed correctly and then overwritten one layer up.

    The same applies to a broken workload: the lifecycle service reports it as
    plainly "not ready", so re-apply the failure this module found underneath —
    otherwise the overlay silently downgrades a crash-looping app back to
    "installing", which is the exact spinner-forever bug this guards against.

    Mutates and returns `entry`.
    """
    failure = entry.get("failure")
    entry.update(claim_status_from_result(lifecycle_app))
    if not entry.get("ready"):
        if failure:
            entry["failure"] = failure
            entry["phase"] = "failing"
            entry["message"] = failure
        elif entry.get("detail"):
            entry["message"] = entry["detail"]
    return entry


def claim_status_from_result(item: dict[str, Any]) -> dict[str, Any]:
    ready = bool(item.get("ready"))
    if ready:
        return {
            "phase": "ready",
            "ready": True,
            "message": item.get("message") or "Ready",
        }
    return {
        "phase": "installing",
        "ready": False,
        "message": item.get("message") or "Installing — provisioning in progress",
    }
