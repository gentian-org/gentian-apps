from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Depends, HTTPException, Query

from app.core.auth import get_current_user
from app.core.config import get_settings
from app.services.lifecycle import LifecycleError, get_lifecycle_client

router = APIRouter(prefix="/tenant/apps", tags=["tenant-apps"])


def _actor(user: dict) -> str:
    return str(user.get("preferred_username") or user.get("sub") or "unknown")


def _claim_status_from_result(item: dict[str, Any]) -> dict[str, Any]:
    ready = bool(item.get("ready"))
    if ready:
        return {
            "phase": "ready",
            "ready": True,
            "message": item.get("message") or "Installed and ready",
        }
    return {
        "phase": "provisioning",
        "ready": False,
        "message": item.get("message") or "Provisioning in progress",
    }


@router.get("/installed")
def list_installed(user: dict = Depends(get_current_user)) -> dict:
    _ = user
    settings = get_settings()
    try:
        lc = get_lifecycle_client()
        apps = lc.list_installed()
    except LifecycleError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    entries = [
        {"profile": app["profile"], **_claim_status_from_result(app)} for app in apps
    ]
    ready = [app for app in entries if app.get("ready")]
    pending = [app for app in entries if not app.get("ready")]
    return {
        "tenant": settings.tenant_id,
        "namespace": settings.tenant_namespace,
        "apps": entries,
        "ready": ready,
        "pending": pending,
    }


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
        **_claim_status_from_result({"ready": ready, "message": result.get("message")}),
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
    settings = get_settings()
    try:
        apps = get_lifecycle_client().list_installed()
    except LifecycleError as exc:
        raise HTTPException(status_code=503, detail=str(exc)) from exc
    for app in apps:
        if app.get("profile") == profile:
            return {"profile": profile, **_claim_status_from_result(app)}
    return {
        "profile": profile,
        "phase": "pending",
        "ready": False,
        "message": "Not installed",
    }
