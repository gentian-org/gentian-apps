from app.core.config import Settings
from app.services.catalogue_tiers import (
    ACTION_BUY,
    ACTION_INSTALL,
    enrich_catalogue_entry,
    is_proprietary,
)


def test_community_app_install_action() -> None:
    entry = {"name": "openproject", "license": "Apache-2.0"}
    profile = {"spec": {"displayName": "OpenProject"}}
    settings = Settings()
    result = enrich_catalogue_entry(entry, profile, settings=settings)
    assert result["tier"] == "community"
    assert result["catalogueAction"] == ACTION_INSTALL
    assert result["requiresEntitlement"] is False


def test_proprietary_app_buy_without_entitlement() -> None:
    entry = {"name": "element", "license": "proprietary"}
    profile = {"spec": {"family": "element", "license": "proprietary"}}
    settings = Settings(
        gentian_commerce_enabled=True,
        gentian_corp_checkout_url="https://corp.gentian.org",
        tenant_domain="demo.desk.gentian.org",
    )
    result = enrich_catalogue_entry(entry, profile, settings=settings, entitled_profiles=set())
    assert result["tier"] == "pro"
    assert result["catalogueAction"] == ACTION_BUY
    assert "checkout" in (result.get("checkoutUrl") or "")
    assert is_proprietary(entry, profile)


def test_proprietary_app_install_when_entitled() -> None:
    entry = {"name": "element", "license": "proprietary"}
    profile = {"spec": {"family": "element"}}
    settings = Settings()
    result = enrich_catalogue_entry(
        entry, profile, settings=settings, entitled_profiles={"element"}
    )
    assert result["catalogueAction"] == ACTION_INSTALL
    assert result.get("checkoutUrl") is None
