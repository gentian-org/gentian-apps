from __future__ import annotations

from fastapi import APIRouter, Depends

from app.core.auth import get_current_user
from app.core.config import get_settings
from app.services.k8s_client import K8sClient
from app.services.tenant_quota import summarize_quota

router = APIRouter(prefix="/tenant", tags=["tenant-quota"])


@router.get("/quota")
def get_tenant_quota(user: dict = Depends(get_current_user)) -> dict:
    """Headroom for this tenant, for the store header.

    Scoped to the workload's own namespace like every other handler here — the
    quota of another tenant is not something this store can be asked for.
    """
    settings = get_settings()
    quota = K8sClient().get_resource_quota(settings.tenant_namespace)
    return summarize_quota(quota)
