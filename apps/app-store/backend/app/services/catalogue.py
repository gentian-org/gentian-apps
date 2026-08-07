from __future__ import annotations

from typing import Any

from app.core.config import Settings, get_settings
from app.services.catalogue_tiers import (
    TIER_PRO,
    enrich_catalogue_entry,
    is_proprietary,
    profile_license,
)
from app.services.corp_client import fetch_entitled_profiles
from app.services.k8s_client import K8sClient
from app.services.tile_resolver import resolve_tile_logo

PLATFORM_ANNOTATION = "gentianos.io/platform-app"
DEPLOYMENT_ROLE_ANNOTATION = "gentianos.io/deployment-role"
# "module" is the deprecated spelling of "addon"; both must be filtered while the
# catalogue migrates.
ADDON_ROLES = {"addon", "module"}


def _is_platform_app(profile: dict[str, Any]) -> bool:
    annotations = profile.get("metadata", {}).get("annotations") or {}
    return annotations.get(PLATFORM_ANNOTATION) == "true"


def _is_addon(profile: dict[str, Any]) -> bool:
    """Addons are activated inside an installed app, never installed on their own.

    They must not appear as store tiles: they are chosen in the addon selection
    window after install, and behind the Edit button afterwards. Listing them here
    would put ~18 uninstallable entries in the grid and let a user try to install
    one standalone.
    """
    annotations = profile.get("metadata", {}).get("annotations") or {}
    role = (annotations.get(DEPLOYMENT_ROLE_ANNOTATION) or "").strip().lower()
    return role in ADDON_ROLES


def build_catalogue(
    k8s: K8sClient,
    *,
    include_platform: bool = False,
    settings: Settings | None = None,
    bearer_token: str | None = None,
) -> dict[str, Any]:
    settings = settings or get_settings()
    catalogue = k8s.get_app_catalogue()
    status = catalogue.get("status", {})
    apps = status.get("apps", [])
    profiles = {p["metadata"]["name"]: p for p in k8s.list_app_profiles()}

    entitled_profiles = fetch_entitled_profiles(settings, bearer_token=bearer_token)

    # Which bases have at least one addon, so the UI knows where to offer an Edit
    # button. Derived from the addons' own declarations rather than a list on the
    # base, so a new addon needs no edit to the app it extends.
    bases_with_addons = {
        decl["of"]
        for p in profiles.values()
        if (decl := (((p.get("spec") or {}).get("customization") or {}).get("addon")))
        and decl.get("of")
    }

    entries: list[dict[str, Any]] = []
    community_count = 0
    pro_count = 0
    for entry in apps:
        name = entry.get("name")
        profile = profiles.get(name, {})
        if not include_platform and _is_platform_app(profile):
            continue
        if _is_addon(profile):
            continue
        spec = profile.get("spec", {})
        meta = profile.get("metadata", {})
        base = {
            "name": name,
            "displayName": entry.get("displayName") or spec.get("displayName", name),
            "description": entry.get("description") or spec.get("description", ""),
            "logo": resolve_tile_logo(spec),
            "chartVersion": entry.get("chartVersion"),
            "deploymentMethod": entry.get("deploymentMethod"),
            "kernelRequirements": entry.get("kernelRequirements", []),
            "installedCount": entry.get("installedCount", 0),
            "platformApp": _is_platform_app(profile),
            "hasAddons": name in bases_with_addons,
            "annotations": meta.get("annotations", {}),
            "license": entry.get("license") or spec.get("license") or "",
            "family": entry.get("family") or spec.get("family") or name,
            "resources": spec.get("extraValues", {}).get("resources") if spec.get("extraValues") else None,
        }
        enriched = enrich_catalogue_entry(
            base,
            profile,
            settings=settings,
            entitled_profiles=entitled_profiles,
        )
        if enriched["tier"] == TIER_PRO:
            pro_count += 1
        else:
            community_count += 1
        entries.append(enriched)

    entries.sort(key=lambda item: (item.get("displayName") or item.get("name") or "").lower())

    return {
        "totalApps": len(entries),
        "communityCount": community_count,
        "proCount": pro_count,
        "commerceEnabled": settings.gentian_commerce_enabled,
        "lastUpdated": status.get("lastUpdated"),
        "apps": entries,
    }


def build_addon_window(
    k8s: K8sClient,
    base_profile: str,
    *,
    settings: Settings | None = None,
    bearer_token: str | None = None,
) -> dict[str, Any]:
    """Everything the UI needs to render the addon selection window for one base.

    Addons are discovered by their own declaration (spec.customization.addon.of),
    not by a list held on the base. A new addon therefore appears in the window as
    soon as its profile syncs, with no edit to the base — the same reason the
    resolver in gentian-os is catalogue-driven.
    """
    settings = settings or get_settings()
    profiles = k8s.list_app_profiles()
    entitled = fetch_entitled_profiles(settings, bearer_token=bearer_token)

    base = next((p for p in profiles if p.get("metadata", {}).get("name") == base_profile), None)
    if base is None:
        raise KeyError(base_profile)
    base_family = (base.get("spec", {}) or {}).get("family") or base_profile

    addons: list[dict[str, Any]] = []
    for profile in profiles:
        spec = profile.get("spec", {}) or {}
        decl = ((spec.get("customization") or {}).get("addon")) or {}
        if decl.get("of") != base_profile:
            continue
        name = profile["metadata"]["name"]
        # Reuse the store's own license resolution so an addon is judged commercial
        # by exactly the rule that judges an app commercial.
        proprietary = is_proprietary({}, profile)
        license_ = profile_license({}, profile)
        addons.append(
            {
                "name": name,
                "displayName": spec.get("displayName", name),
                "description": spec.get("description", ""),
                "logo": resolve_tile_logo(spec),
                "license": license_,
                "author": spec.get("author", ""),
                "edition": spec.get("edition") or "ce",
                # Commercial addons stay visible but are gated on entitlement, the
                # same rule the store applies to commercial apps.
                "requiresEntitlement": proprietary,
                "entitled": (not proprietary) or name in entitled,
            }
        )
    addons.sort(key=lambda a: a["displayName"].lower())

    packages = []
    for pkg in k8s.list_app_packages():
        pspec = pkg.get("spec", {}) or {}
        if pspec.get("family") != base_family:
            continue
        known = {a["name"] for a in addons}
        selects = [a for a in (pspec.get("addons") or []) if a in known]
        if not selects:
            continue
        packages.append(
            {
                "name": pkg["metadata"]["name"],
                "displayName": pspec.get("displayName", pkg["metadata"]["name"]),
                "description": pspec.get("description", ""),
                "addons": selects,
            }
        )
    packages.sort(key=lambda p: p["displayName"].lower())

    return {"base": base_profile, "family": base_family, "addons": addons, "packages": packages}
