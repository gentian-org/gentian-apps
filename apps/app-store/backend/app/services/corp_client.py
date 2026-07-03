from __future__ import annotations

import logging
from typing import Any

import httpx

from app.core.config import Settings

logger = logging.getLogger(__name__)


def fetch_entitled_profiles(
    settings: Settings,
    *,
    bearer_token: str | None = None,
) -> set[str]:
    """Return profile names the tenant may install (corp action=install).

    When gentian-corp is unreachable, returns an empty set — Pro apps stay on Buy.
    """
    if not settings.gentian_commerce_enabled or not settings.gentian_corp_api_url:
        return set()
    if not settings.tenant_domain:
        return set()

    url = settings.gentian_corp_api_url.rstrip("/") + "/catalogue"
    params = {"tenantDomain": settings.tenant_domain}
    headers: dict[str, str] = {}
    if bearer_token:
        headers["Authorization"] = f"Bearer {bearer_token}"

    try:
        with httpx.Client(timeout=5.0) as client:
            response = client.get(url, params=params, headers=headers)
            response.raise_for_status()
            payload = response.json()
    except (httpx.HTTPError, ValueError) as exc:
        logger.info("gentian-corp catalogue unavailable: %s", exc)
        return set()

    entitled: set[str] = set()
    for product in payload.get("products") or []:
        if product.get("action") != "install":
            continue
        for key in ("profileName", "profileFamily", "productSku"):
            value = product.get(key)
            if isinstance(value, str) and value.strip():
                entitled.add(value.strip())
    return entitled
