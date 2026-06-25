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
            "message": "Waiting for the platform to create the app claim",
            "conditions": [],
        }
    conditions = claim.get("status", {}).get("conditions", [])
    ready = any(c.get("type") == "Ready" and c.get("status") == "True" for c in conditions)
    message = ""
    for cond in conditions:
        if cond.get("status") != "True" and cond.get("message"):
            message = str(cond.get("message"))
            break
    if ready:
        phase = "ready"
        message = message or "Application is ready"
    elif message:
        phase = "provisioning"
    else:
        phase = "provisioning"
        message = "Provisioning in progress"
    return {
        "phase": phase,
        "ready": ready,
        "message": message,
        "conditions": conditions,
        "claim": claim.get("metadata", {}).get("name"),
    }


def _merge_installed(k8s: K8sClient, tenant: str, ns: str) -> list[dict[str, Any]]:
    profiles: dict[str, dict[str, Any]] = {}

    try:
        tenant_cr = k8s.get_tenant(tenant)
        for app in tenant_cr.get("spec", {}).get("apps", []):
            profile = app.get("profile")
            if profile:
                profiles[profile] = {"profile": profile, "source": "tenant"}
    except Exception:
        pass

    for claim in k8s.list_apps_in_namespace(ns):
        meta = claim.get("metadata", {})
        spec = claim.get("spec", {})
        profile = spec.get("profileRef", {}).get("name")
        if not profile:
            continue
        status_info = _claim_status(claim)
        profiles[profile] = {
            "profile": profile,
            "source": "app-claim",
            "name": meta.get("name"),
            **status_info,
        }

    return list(profiles.values())


@router.get("/installed")
def list_installed(user: dict = Depends(get_current_user)) -> dict:
    settings = get_settings()
    tenant = settings.tenant_id
    k8s = K8sClient()
    ns = settings.tenant_namespace or _tenant_namespace(tenant)
    return {"tenant": tenant, "namespace": ns, "apps": _merge_installed(k8s, tenant, ns)}


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
