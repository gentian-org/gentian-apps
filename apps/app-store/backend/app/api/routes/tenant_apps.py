from __future__ import annotations

from typing import Any

from fastapi import APIRouter, Body, Depends, HTTPException, Query

from app.core.auth import get_current_user
from app.core.config import get_settings
from app.services.catalogue import build_addon_window
from app.services.k8s_client import K8sClient
from app.services.catalogue_tiers import is_proprietary
from app.services.corp_client import fetch_entitled_profiles
from app.services.lifecycle import LifecycleError, get_lifecycle_client
from app.services.tenant_app_status import (
    claim_status_from_result,
    list_from_k8s,
    merge_lifecycle_status,
)

router = APIRouter(prefix="/tenant/apps", tags=["tenant-apps"])


def _actor(user: dict) -> str:
    return str(user.get("preferred_username") or user.get("sub") or "unknown")


def _profile_entitled(profile_name: str, settings, entitled: set[str]) -> bool:
    if profile_name in entitled:
        return True
    try:
        k8s = K8sClient()
        profile = k8s.get_app_profile(profile_name)
        family = (profile.get("spec") or {}).get("family") or profile_name
        return family in entitled
    except Exception:
        return False


def _assert_may_install(profile: str, settings) -> None:
    k8s = K8sClient()
    try:
        profile_obj = k8s.get_app_profile(profile)
    except Exception as exc:
        raise HTTPException(status_code=404, detail=f"Unknown profile: {profile}") from exc
    entry = {"name": profile, "license": (profile_obj.get("spec") or {}).get("license")}
    if not is_proprietary(entry, profile_obj):
        return
    entitled = fetch_entitled_profiles(settings)
    if _profile_entitled(profile, settings, entitled):
        return
    raise HTTPException(
        status_code=402,
        detail="This app requires a commercial subscription. Use Buy in the catalogue first.",
    )


def _selected_addons(k8s: K8sClient, tenant: str, profile: str) -> list[str]:
    """The tenant's current selection, read from the Tenant CR.

    Read from the cluster rather than from git so the window shows what is actually
    applied; a selection committed but not yet synced is not yet in effect.
    """
    try:
        apps = (k8s.get_tenant(tenant).get("spec") or {}).get("apps") or []
    except Exception:
        return []
    for app in apps:
        if app.get("profile") == profile:
            return list(app.get("addons") or [])
    return []


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
                merge_lifecycle_status(entry, lifecycle_app)
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
def install_app(profile: str, provision: bool = False, user: dict = Depends(get_current_user)) -> dict:
    settings = get_settings()
    _assert_may_install(profile, settings)
    try:
        result = get_lifecycle_client().install(
            profile,
            _actor(user),
            provision=provision,
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


@router.get("/{profile}/addons")
def get_addons(profile: str, user: dict = Depends(get_current_user)) -> dict:
    """Addons offered for an installed app, plus the tenant's current selection."""
    settings = get_settings()
    k8s = K8sClient()
    try:
        window = build_addon_window(k8s, profile, settings=settings)
    except KeyError as exc:
        raise HTTPException(status_code=404, detail=f"Unknown profile: {profile}") from exc
    window["selected"] = _selected_addons(k8s, settings.tenant_id, profile)
    return window


@router.put("/{profile}/addons")
def set_addons(
    profile: str,
    addons: list[str] = Body(default=[], embed=True),
    provision: bool = Body(default=False, embed=True),
    user: dict = Depends(get_current_user),
) -> dict:
    """Replace the addon selection. The body is the complete list; [] clears it.

    provision mirrors the app-level flag: install and grant access to every
    existing tenant user, rather than install and leave access to be granted by
    adding users to the addon's group.
    """
    settings = get_settings()
    try:
        result = get_lifecycle_client().set_addons(
            profile, addons, _actor(user), provision=provision
        )
    except LifecycleError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {
        "status": result.get("status", "updated"),
        "mode": "gitops",
        "tenant": settings.tenant_id,
        "profile": profile,
        "addons": addons,
        "provisioned": provision,
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
