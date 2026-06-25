from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, status

from app.core.auth import get_current_user
from app.core.config import get_settings
from app.services.gitops import DeploymentsGitOps, GitOpsError
from app.services.k8s_client import K8sClient

router = APIRouter(prefix="/tenant/apps", tags=["tenant-apps"])


def _actor(user: dict) -> str:
    return str(user.get("preferred_username") or user.get("sub") or "unknown")


def _tenant_namespace(tenant_id: str) -> str:
    return f"tenant-{tenant_id}"


def _claim_status(claim: dict[str, Any] | None) -> dict[str, Any]:
    if claim is None:
        return {
            "phase": "pending",
            "ready": False,
            "message": "Install requested — waiting for the app claim to be created",
            "conditions": [],
        }
    conditions = claim.get("status", {}).get("conditions", [])
    ready = any(c.get("type") == "Ready" and c.get("status") == "True" for c in conditions)
    message = ""
    for cond in conditions:
        if cond.get("type") == "Ready" and cond.get("status") == "True":
            break
        if cond.get("status") != "True" and cond.get("message"):
            message = str(cond.get("message"))
            break
    if ready:
        return {
            "phase": "ready",
            "ready": True,
            "message": "Installed and ready",
            "conditions": conditions,
            "claim": claim.get("metadata", {}).get("name"),
        }
    return {
        "phase": "provisioning",
        "ready": False,
        "message": message or "Provisioning in progress",
        "conditions": conditions,
        "claim": claim.get("metadata", {}).get("name"),
    }


def _merge_installed(k8s: K8sClient, tenant: str, ns: str) -> list[dict[str, Any]]:
    """Build install status from tenant.spec.apps, enriched with App claim conditions."""
    profiles: dict[str, dict[str, Any]] = {}

    try:
        tenant_cr = k8s.get_tenant(tenant)
        tenant_profiles = [
            app.get("profile")
            for app in tenant_cr.get("spec", {}).get("apps", [])
            if app.get("profile")
        ]
    except Exception:
        tenant_profiles = []

    for profile in tenant_profiles:
        claim = k8s.get_app_claim(ns, profile)
        entry: dict[str, Any] = {"profile": profile, **_claim_status(claim)}
        if claim:
            entry["name"] = claim.get("metadata", {}).get("name")
        profiles[profile] = entry

    # Surface orphan claims (e.g. created before tenant.spec.apps caught up).
    for claim in k8s.list_apps_in_namespace(ns):
        profile = claim.get("spec", {}).get("profileRef", {}).get("name")
        if not profile or profile in profiles:
            continue
        profiles[profile] = {
            "profile": profile,
            "name": claim.get("metadata", {}).get("name"),
            **_claim_status(claim),
        }

    return list(profiles.values())


@router.get("/installed")
def list_installed(user: dict = Depends(get_current_user)) -> dict:
    settings = get_settings()
    tenant = settings.tenant_id
    k8s = K8sClient()
    ns = settings.tenant_namespace or _tenant_namespace(tenant)
    apps = _merge_installed(k8s, tenant, ns)
    ready = [app for app in apps if app.get("ready")]
    pending = [app for app in apps if not app.get("ready")]
    return {
        "tenant": tenant,
        "namespace": ns,
        "apps": apps,
        "ready": ready,
        "pending": pending,
    }


@router.post("/{profile}/install")
def install_app(profile: str, user: dict = Depends(get_current_user)) -> dict:
    settings = get_settings()
    tenant = settings.tenant_id
    k8s = K8sClient()

    try:
        k8s.get_app_profile(profile)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"AppProfile '{profile}' not found") from exc

    if settings.install_mode == "k8s":
        try:
            result = k8s.add_tenant_app(tenant, profile)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to update tenant apps: {exc}",
            ) from exc
        ns = settings.tenant_namespace or _tenant_namespace(tenant)
        claim = k8s.get_app_claim(ns, profile)
        return {
            "status": result,
            "mode": "k8s",
            "tenant": tenant,
            "profile": profile,
            **_claim_status(claim),
        }

    try:
        gitops = DeploymentsGitOps()
        result = gitops.install_app(tenant, profile, _actor(user))
    except GitOpsError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"status": result, "mode": "gitops", "tenant": tenant, "profile": profile}


@router.delete("/{profile}")
def uninstall_app(profile: str, user: dict = Depends(get_current_user)) -> dict:
    settings = get_settings()
    tenant = settings.tenant_id

    if settings.install_mode == "k8s":
        k8s = K8sClient()
        try:
            result = k8s.remove_tenant_app(tenant, profile)
        except Exception as exc:
            raise HTTPException(
                status_code=500,
                detail=f"Failed to update tenant apps: {exc}",
            ) from exc
        return {"status": result, "mode": "k8s", "tenant": tenant, "profile": profile}

    try:
        gitops = DeploymentsGitOps()
        result = gitops.uninstall_app(tenant, profile, _actor(user))
    except GitOpsError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {"status": result, "mode": "gitops", "tenant": tenant, "profile": profile}


@router.get("/{profile}/status")
def app_status(profile: str, user: dict = Depends(get_current_user)) -> dict:
    _ = user
    settings = get_settings()
    ns = settings.tenant_namespace or _tenant_namespace(settings.tenant_id)
    k8s = K8sClient()
    claim = k8s.get_app_claim(ns, profile)
    return {"profile": profile, **_claim_status(claim)}
