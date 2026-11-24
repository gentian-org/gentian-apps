from fastapi import APIRouter, Depends

from app.core.auth import get_current_user
from app.core.config import get_settings
from app.core.roles import require_role
from app.db.session import get_tenant_session

router = APIRouter(prefix="/items", tags=["items"])

# Who may administer this app's items: holders of its admin role.
require_admin = require_role("admin")


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
    user: dict = Depends(require_admin),
) -> dict:
    """An administrative route: only a holder of the app's admin role (M22).

    An app that decides per item instead (who may delete which item) declares
    an authorization store and asks it with app.core.authz.check_permission.
    """
    return {"deleted": item_id}
