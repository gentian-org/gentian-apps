"""Tenant scoping helpers (M4, M26).

Every handler must operate within the workload's configured tenant. Never trust
client-supplied tenant IDs without matching JWT claims or platform injection.
"""

from typing import Any

from fastapi import HTTPException, status

from app.core.config import Settings


def extract_tenant_from_claims(claims: dict[str, Any]) -> str | None:
    """Resolve tenant id from standard Gentian / Keycloak claim shapes."""
    for key in ("tenant", "tenant_id", "tenantId"):
        value = claims.get(key)
        if value:
            return str(value)

    groups = claims.get("groups") or claims.get("realm_access", {}).get("roles") or []
    for group in groups:
        group_str = str(group)
        if group_str.startswith("tenant:"):
            return group_str.removeprefix("tenant:")

    sub = str(claims.get("preferred_username") or claims.get("sub") or "")
    if sub.startswith("admin-"):
        return sub.removeprefix("admin-").split("@", 1)[0]

    return None


def assert_tenant_access(claims: dict[str, Any], settings: Settings) -> str:
    """Ensure the authenticated user belongs to this workload's tenant."""
    claim_tenant = extract_tenant_from_claims(claims)

    if settings.is_production and claim_tenant is None and not settings.auth_disabled:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Missing tenant claim",
        )

    effective = claim_tenant or settings.tenant_id
    if claim_tenant and claim_tenant != settings.tenant_id:
        raise HTTPException(
            status_code=status.HTTP_403_FORBIDDEN,
            detail="Tenant mismatch",
        )
    return effective
