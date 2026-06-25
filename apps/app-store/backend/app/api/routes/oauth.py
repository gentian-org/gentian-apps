from __future__ import annotations

import html
import secrets
from urllib.parse import urlencode

import httpx
from fastapi import APIRouter, HTTPException, Request
from fastapi.responses import HTMLResponse, RedirectResponse

from app.core.config import get_settings

router = APIRouter(prefix="/oauth", tags=["oauth"])


def _public_base_url(request: Request) -> str:
    settings = get_settings()
    if settings.public_base_url:
        return settings.public_base_url.rstrip("/")
    proto = request.headers.get("x-forwarded-proto", request.url.scheme)
    host = request.headers.get("x-forwarded-host") or request.headers.get("host")
    return f"{proto}://{host}"


def _redirect_uri(request: Request) -> str:
    return f"{_public_base_url(request)}/oauth/callback"


@router.get("/login")
def oauth_login(request: Request, return_to: str = "/") -> RedirectResponse:
    settings = get_settings()
    if settings.auth_disabled or not settings.oidc_issuer:
        return RedirectResponse(return_to)

    if not settings.oidc_client_id:
        raise HTTPException(status_code=500, detail="OIDC client not configured")

    state = secrets.token_urlsafe(16)
    # return_to is carried in a cookie because Keycloak state should stay opaque.
    response = RedirectResponse(
        f"{settings.oidc_issuer.rstrip('/')}/protocol/openid-connect/auth?"
        + urlencode(
            {
                "client_id": settings.oidc_client_id,
                "redirect_uri": _redirect_uri(request),
                "response_type": "code",
                "scope": "openid profile email",
                "state": state,
            }
        )
    )
    response.set_cookie(
        key="gentian_oauth_state",
        value=state,
        httponly=True,
        secure=request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https",
        samesite="lax",
        max_age=600,
    )
    response.set_cookie(
        key="gentian_oauth_return",
        value=return_to,
        httponly=True,
        secure=request.url.scheme == "https" or request.headers.get("x-forwarded-proto") == "https",
        samesite="lax",
        max_age=600,
    )
    return response


@router.get("/callback")
def oauth_callback(
    request: Request,
    code: str | None = None,
    state: str | None = None,
    error: str | None = None,
    error_description: str | None = None,
) -> HTMLResponse:
    settings = get_settings()
    return_to = request.cookies.get("gentian_oauth_return", "/")
    expected_state = request.cookies.get("gentian_oauth_state")

    if error:
        detail = error_description or error
        raise HTTPException(status_code=400, detail=detail)

    if not code or not state or not expected_state or state != expected_state:
        raise HTTPException(status_code=400, detail="Invalid OAuth state")

    if not settings.oidc_issuer or not settings.oidc_client_id or not settings.oidc_client_secret:
        raise HTTPException(status_code=500, detail="OIDC client not configured")

    token_url = f"{settings.oidc_issuer.rstrip('/')}/protocol/openid-connect/token"
    with httpx.Client(timeout=15.0) as client:
        token_resp = client.post(
            token_url,
            data={
                "grant_type": "authorization_code",
                "code": code,
                "redirect_uri": _redirect_uri(request),
                "client_id": settings.oidc_client_id,
                "client_secret": settings.oidc_client_secret,
            },
            headers={"Content-Type": "application/x-www-form-urlencoded"},
        )
    if token_resp.status_code >= 400:
        raise HTTPException(status_code=502, detail="Token exchange failed")

    access_token = token_resp.json().get("access_token")
    if not access_token:
        raise HTTPException(status_code=502, detail="Token response missing access_token")

    safe_token = html.escape(access_token, quote=True)
    safe_return = html.escape(return_to, quote=True)
    body = f"""<!DOCTYPE html>
<html lang="en">
<head><meta charset="utf-8"><title>Signing in…</title></head>
<body>
<script>
  localStorage.setItem("gentian_access_token", "{safe_token}");
  window.location.replace("{safe_return}");
</script>
</body>
</html>"""
    response = HTMLResponse(content=body)
    response.delete_cookie("gentian_oauth_state")
    response.delete_cookie("gentian_oauth_return")
    return response
