from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import get_current_user
from app.core.config import get_settings
from app.services.k8s_client import K8sClient
from app.services.lifecycle import LifecycleError, get_lifecycle_client
from app.services.tenant_app_status import claim_status_from_result, list_from_k8s

router = APIRouter(prefix="/tenant/apps", tags=["tenant-apps"])


def _actor(user: dict) -> str:
    return str(user.get("preferred_username") or user.get("sub") or "unknown")


def _list_installed_entries() -> tuple[list[dict[str, Any]], str | None]:
    settings = get_settings()
    k8s = K8sClient()
    namespace = settings.tenant_namespace
    entries = list_from_k8s(k8s, settings.tenant_id, namespace)

    lifecycle_warning: str | None = None
    try:
        lifecycle_apps = get_lifecycle_client().list_installed()
        lifecycle_by_profile = {
            app["profile"]: app for app in lifecycle_apps if app.get("profile")
        }
        for entry in entries:
            lifecycle_app = lifecycle_by_profile.get(entry["profile"])
            if lifecycle_app:
                entry.update(claim_status_from_result(lifecycle_app))
    except LifecycleError as exc:
        lifecycle_warning = str(exc)

    return entries, lifecycle_warning


@router.get("/installed")
def list_installed(user: dict = Depends(get_current_user)) -> dict:
    _ = user
    settings = get_settings()
    entries, lifecycle_warning = _list_installed_entries()
    ready = [app for app in entries if app.get("ready")]
    installing = [app for app in entries if not app.get("ready")]
    result = {
        "tenant": settings.tenant_id,
        "namespace": settings.tenant_namespace,
        "apps": entries,
        "ready": ready,
        "installing": installing,
    }
    if lifecycle_warning:
        result["lifecycleWarning"] = lifecycle_warning
    return result


@router.post("/{profile}/install")
def install_app(profile: str, user: dict = Depends(get_current_user)) -> dict:
    settings = get_settings()
    try:
        result = get_lifecycle_client().install(
            profile,
            _actor(user),
        )
    except LifecycleError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    status = result.get("status", "installed")
    ready = bool(result.get("ready"))
    return {
        "status": status,
        "mode": "gitops",
        "tenant": settings.tenant_id,
        "profile": profile,
        **claim_status_from_result({"ready": ready, "message": result.get("message")}),
    }


@router.delete("/{profile}")
def uninstall_app(
    profile: str,
    purge: bool = Query(default=False, description="Delete persistent DB, S3, secrets, and kernel artifacts"),
    user: dict = Depends(get_current_user),
) -> dict:
    settings = get_settings()
    try:
        result = get_lifecycle_client().uninstall(
            profile,
            _actor(user),
            purge=purge,
        )
    except LifecycleError as exc:
        raise HTTPException(status_code=500, detail=str(exc)) from exc
    return {
        "status": result.get("status", "uninstalled"),
        "mode": "gitops",
        "tenant": settings.tenant_id,
        "profile": profile,
        "purged": bool(result.get("purged")),
        "warnings": result.get("warnings") or [],
    }


@router.get("/{profile}/status")
def app_status(profile: str, user: dict = Depends(get_current_user)) -> dict:
    _ = user
    entries, _ = _list_installed_entries()
    for app in entries:
        if app.get("profile") == profile:
            return {"profile": profile, **claim_status_from_result(app)}
    return {
        "profile": profile,
        "phase": "installing",
        "ready": False,
        "message": "Not installed",
    }
