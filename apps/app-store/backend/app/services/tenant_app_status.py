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


def _entry_from_claim(profile: str, claim: dict[str, Any]) -> dict[str, Any]:
    ready, message = _claim_status(claim)
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
            entries.append(_entry_from_claim(profile, claim))
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
