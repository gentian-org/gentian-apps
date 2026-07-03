from __future__ import annotations

from typing import Any
from urllib.parse import quote

from app.core.config import Settings

PROPRIETARY_LICENSE = "proprietary"
TIER_COMMUNITY = "community"
TIER_PRO = "pro"
ACTION_INSTALL = "install"
ACTION_BUY = "buy"


def profile_license(entry: dict[str, Any], profile: dict[str, Any]) -> str:
    """Resolve SPDX license from AppCatalogue entry or AppProfile spec."""
    from_entry = (entry.get("license") or "").strip()
    if from_entry:
        return from_entry
    spec = profile.get("spec") or {}
    return (spec.get("license") or "").strip()


def is_proprietary(entry: dict[str, Any], profile: dict[str, Any]) -> bool:
    return profile_license(entry, profile).lower() == PROPRIETARY_LICENSE


def profile_family(entry: dict[str, Any], profile: dict[str, Any], name: str) -> str:
    spec = profile.get("spec") or {}
    return (entry.get("family") or spec.get("family") or name).strip() or name


def build_checkout_url(settings: Settings, profile_name: str, family: str) -> str | None:
    if not settings.gentian_commerce_enabled:
        return None
    base = settings.gentian_corp_checkout_base_url
    if not base or not settings.tenant_domain:
        return None
    product = family or profile_name
    return (
        f"{base.rstrip('/')}/checkout"
        f"?tenantDomain={quote(settings.tenant_domain)}"
        f"&product={quote(product)}"
    )


def catalogue_action(
    *,
    proprietary: bool,
    entitled: bool,
) -> str:
    if not proprietary:
        return ACTION_INSTALL
    return ACTION_INSTALL if entitled else ACTION_BUY


def enrich_catalogue_entry(
    entry: dict[str, Any],
    profile: dict[str, Any],
    *,
    settings: Settings,
    entitled_profiles: set[str] | None = None,
) -> dict[str, Any]:
    name = entry.get("name") or profile.get("metadata", {}).get("name") or ""
    proprietary = is_proprietary(entry, profile)
    family = profile_family(entry, profile, name)
    license_id = profile_license(entry, profile)
    entitled = bool(entitled_profiles and name in entitled_profiles)
    tier = TIER_PRO if proprietary else TIER_COMMUNITY
    action = catalogue_action(proprietary=proprietary, entitled=entitled)
    checkout_url = build_checkout_url(settings, name, family) if action == ACTION_BUY else None

    enriched = dict(entry)
    enriched["tier"] = tier
    enriched["license"] = license_id or ("proprietary" if proprietary else "open-source")
    enriched["profileFamily"] = family
    enriched["catalogueAction"] = action
    enriched["requiresEntitlement"] = proprietary
    enriched["checkoutUrl"] = checkout_url
    enriched["licenceNotice"] = (
        "Commercial subscription required — install after purchase."
        if proprietary and action == ACTION_BUY
        else None
    )
    return enriched
