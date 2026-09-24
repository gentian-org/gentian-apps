"""Credentials, which the credential manager answers for.

Not yet relayed. The credential manager is a kernel service the desktop
reached by a URL the platform handed it; this component has not been given
one yet, because that is a platform fact the profile mapping does not carry.
Until it does, every route here says so rather than guessing a host.
"""

from fastapi import APIRouter, Depends, HTTPException, Request

from app.core.auth import get_current_user

router = APIRouter(prefix="/credentials", tags=["credentials"])


@router.api_route("/{rest:path}", methods=["GET", "PUT", "DELETE"])
@router.api_route("", methods=["GET"])
async def not_yet_relayed(request: Request, rest: str = "", _user: dict = Depends(get_current_user)) -> None:
    raise HTTPException(
        status_code=501,
        detail="The Credentials screen is not yet a client of the director. "
        "It is being re-pointed from the desktop's backend.",
    )
