from fastapi import APIRouter, Depends

from app.core.auth import get_current_user
from app.core.authz import check_permission
from app.core.config import Settings, get_settings
from app.db.session import get_tenant_session

router = APIRouter(prefix="/items", tags=["items"])


@router.get("/")
def list_items(user: dict = Depends(get_current_user)) -> dict:
    settings = get_settings()
    tenant_id = user.get("tenant") or settings.tenant_id

    with get_tenant_session(tenant_id, settings) as db:
        # All queries must go through tenant-scoped session (M26)
        scoped = db.query(dict, tenant_id=tenant_id)

    return {
        "tenant": tenant_id,
        "user": user.get("sub"),
        "items": scoped,
        "message": "Replace with your app domain logic.",
    }


@router.delete("/{item_id}")
async def delete_item(
    item_id: str,
    user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> dict:
    """Example admin/destructive route with ReBAC check (M22)."""
    await check_permission(
        user=user,
        relation="can_delete",
        object_type="item",
        object_id=item_id,
        settings=settings,
    )
    return {"deleted": item_id, "note": "OpenFGA check stub — wire PDP when available"}
