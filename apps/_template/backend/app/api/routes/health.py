from fastapi import APIRouter, Response, status

from app.core.config import get_settings

router = APIRouter(tags=["health"])


@router.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
def readyz(response: Response) -> dict[str, object]:
    """Readiness probe — verify config and optional dependencies (M8)."""
    settings = get_settings()
    checks: dict[str, str] = {}
    errors: list[str] = []

    if settings.is_production and not settings.oidc_issuer:
        errors.append("OIDC_ISSUER required in production")

    if settings.openfga_api_url and not settings.openfga_store_id:
        errors.append("OPENFGA_STORE_ID required when OPENFGA_API_URL is set")

    checks["oidc"] = "ok" if settings.oidc_issuer or not settings.is_production else "missing"
    checks["database"] = (
        "configured (stub ping — wire SELECT 1 when using Postgres)"
        if settings.database_url
        else "skipped"
    )
    checks["openfga"] = (
        "configured" if settings.openfga_api_url and settings.openfga_store_id else "skipped"
    )

    if errors:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "not_ready", "checks": checks, "errors": errors}

    return {"status": "ready", "checks": checks}
