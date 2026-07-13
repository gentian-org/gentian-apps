from fastapi import APIRouter, Depends, Header

from app.core.auth import get_current_user
from app.core.config import get_settings
from app.services.catalogue import build_catalogue
from app.services.k8s_client import K8sClient
from app.services.tile_resolver import resolve_tile_logo

router = APIRouter(prefix="/catalogue", tags=["catalogue"])


def _bearer_token(authorization: str | None) -> str | None:
    if authorization and authorization.lower().startswith("bearer "):
        return authorization[7:].strip() or None
    return None


@router.get("/")
def get_catalogue(
    user: dict = Depends(get_current_user),
    include_platform: bool = False,
    authorization: str | None = Header(default=None),
) -> dict:
    _ = user
    settings = get_settings()
    k8s = K8sClient()
    data = build_catalogue(
        k8s,
        include_platform=include_platform,
        settings=settings,
        bearer_token=_bearer_token(authorization),
    )
    data["catalogueRepo"] = settings.gentian_apps_repo
    data["catalogueBranch"] = settings.gentian_apps_branch
    data["tenantDomain"] = settings.tenant_domain
    return data


@router.get("/{profile_name}")
def get_catalogue_entry(profile_name: str, user: dict = Depends(get_current_user)) -> dict:
    _ = user
    k8s = K8sClient()
    profile = k8s.get_app_profile(profile_name)
    spec = profile.get("spec", {})
    return {
        "name": profile_name,
        "displayName": spec.get("displayName", profile_name),
        "description": spec.get("description", ""),
        "logo": resolve_tile_logo(spec),
        "chartVersion": spec.get("chart", {}).get("version"),
        "kernelRequirements": spec.get("kernelRequirements"),
        "resources": spec.get("extraValues", {}).get("resources") if spec.get("extraValues") else None,
    }
