from __future__ import annotations

from typing import Any

from app.services.catalogue import PLATFORM_ANNOTATION
from app.services.k8s_client import K8sClient


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
    if not ready and k8s is not None:
        try:
            detail = _blocking_detail(k8s, claim)
        except Exception:
            detail = None
        if detail:
            message = detail
    return {
        "profile": profile,
        "name": claim.get("metadata", {}).get("name"),
        "ready": ready,
        "phase": "ready" if ready else "installing",
        "message": message,
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
