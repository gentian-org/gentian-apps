from fastapi import APIRouter, Response, status

from app.core.config import get_settings

router = APIRouter(tags=["health"])


@router.get("/healthz")
def healthz() -> dict[str, str]:
    return {"status": "ok"}


@router.get("/readyz")
def readyz(response: Response) -> dict[str, object]:
    """Ready means this console can do its one job: verify the forwarded token
    and reach the director. Missing either is not ready, and says which."""
    settings = get_settings()
    checks: dict[str, str] = {}
    errors: list[str] = []

    if settings.is_production and not settings.oidc_issuer:
        errors.append("OIDC_ISSUER required in production")
    if not settings.director_url or not settings.cluster_id:
        errors.append(
            "DIRECTOR_URL and GENTIAN_CLUSTER_ID are required: this console is a client of the director"
        )

    checks["oidc"] = "ok" if settings.oidc_issuer or not settings.is_production else "missing"
    checks["director"] = (
        "configured" if settings.director_url and settings.cluster_id else "missing"
    )

    if errors:
        response.status_code = status.HTTP_503_SERVICE_UNAVAILABLE
        return {"status": "not_ready", "checks": checks, "errors": errors}
    return {"status": "ready", "checks": checks}
