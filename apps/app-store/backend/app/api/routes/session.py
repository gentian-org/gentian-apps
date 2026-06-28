from fastapi import APIRouter, Depends

from app.core.auth import get_current_user

router = APIRouter(prefix="/session", tags=["session"])


@router.get("/me")
def get_me(user: dict = Depends(get_current_user)) -> dict:
    return {
        "sub": user.get("sub"),
        "username": user.get("preferred_username") or user.get("sub"),
        "name": user.get("name"),
        "email": user.get("email"),
        "tenant": user.get("tenant"),
    }
