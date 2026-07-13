from __future__ import annotations

from typing import Any

from app.core.config import Settings, get_settings
from app.services.catalogue_tiers import TIER_COMMUNITY, TIER_PRO, enrich_catalogue_entry
from app.services.corp_client import fetch_entitled_profiles
from app.services.k8s_client import K8sClient
from app.services.tile_resolver import resolve_tile_logo

PLATFORM_ANNOTATION = "gentianos.io/platform-app"


def _is_platform_app(profile: dict[str, Any]) -> bool:
    annotations = profile.get("metadata", {}).get("annotations") or {}
    return annotations.get(PLATFORM_ANNOTATION) == "true"


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

    entries: list[dict[str, Any]] = []
    community_count = 0
    pro_count = 0
    for entry in apps:
        name = entry.get("name")
        profile = profiles.get(name, {})
        if not include_platform and _is_platform_app(profile):
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
