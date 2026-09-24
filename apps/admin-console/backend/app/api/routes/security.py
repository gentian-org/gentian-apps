"""The realm policy a tenant runs under.

How strong a password has to be, how long a session lasts, what happens after
repeated failures. This screen used to reach Keycloak's admin API through the
desktop's backend, with a credential that could read and write the whole
realm. It does not now: the policy is declared in the deployments repository,
the director commits it, and the tenant composition turns it into the realm's
own fields. Nothing in this path holds a Keycloak credential.

The screen's shape is flat — `passwordMinLength`, `ssoSessionIdleMinutes` —
and the director's is the shape of the thing it commits. Translating between
them is this module's whole job, and it belongs here: the API should look like
the resource it writes, and the screen should keep the form its users know.
"""

import json

from fastapi import APIRouter, Depends, HTTPException, Query, Response
from fastapi.security import HTTPAuthorizationCredentials, HTTPBearer

from app.core import director
from app.core.auth import bearer_of, get_current_user
from app.core.config import Settings, get_settings

router = APIRouter(prefix="/admin", tags=["security"])
_bearer = HTTPBearer(auto_error=False)

# Requiring a second factor is not settable yet. Keycloak expresses "this
# group must use TOTP" as a conditional authentication sub-flow, not as a
# realm field, so it cannot be declared the way the rest of this policy is.
# The screen still shows the two controls; a request that tries to change
# them is refused with the reason rather than accepted and dropped.
TOTP_NOT_SETTABLE = (
    "Requiring a second factor is not settable here yet: Keycloak expresses it "
    "as a conditional authentication flow rather than a realm setting, so it "
    "cannot be declared the way the rest of this policy is. Configure it in "
    "the Identity console until this lands."
)


def _tenant(settings: Settings, tenant: str | None) -> str:
    return tenant or settings.tenant_id


def _flat(policy: dict, defaults: dict) -> dict:
    """The director's answer, as the screen reads it.

    A field the tenant does not declare is reported as what the realm will
    actually do — the composition's default where there is one, and otherwise
    the value that means "not imposed". Reporting a zero instead would read as
    "no minimum length" when the truth is "Keycloak's own".
    """
    password = policy.get("password") or {}
    session = policy.get("session") or {}
    brute = policy.get("bruteForce") or {}
    default_session = (defaults.get("session") or {}) if defaults else {}
    return {
        "passwordMinLength": password.get("minLength", 0),
        "passwordRequireDigits": password.get("requireDigits", False),
        "passwordRequireLowercase": password.get("requireLowercase", False),
        "passwordRequireUppercase": password.get("requireUppercase", False),
        "passwordRequireSpecialChars": password.get("requireSpecialChars", False),
        "passwordHistoryCount": password.get("historyCount", 0),
        "passwordMaxAgeDays": password.get("maxAgeDays", 0),
        "ssoSessionIdleMinutes": session.get("idleMinutes", default_session.get("idleMinutes", 0)),
        "ssoSessionMaxHours": session.get("maxHours", default_session.get("maxHours", 0)),
        "rememberMe": session.get("rememberMe", False),
        "bruteForceProtected": brute.get("enabled", False),
        "maxLoginFailures": brute.get("maxLoginFailures", 0),
        "lockoutDurationSeconds": brute.get("lockoutDurationSeconds", 0),
        # Reported as they are, which is off, because nothing here can set
        # them. See TOTP_NOT_SETTABLE.
        "requireTotpAdmins": False,
        "requireTotpMembers": "none",
    }


def _nested(body: dict) -> dict:
    """The screen's form, as the thing the director commits.

    Only what is asked for: a field left at zero or false is left out
    entirely, so the realm keeps the composition's default rather than having
    a zero written over it.
    """
    password = {
        key: body[flat]
        for key, flat in (
            ("minLength", "passwordMinLength"),
            ("requireDigits", "passwordRequireDigits"),
            ("requireLowercase", "passwordRequireLowercase"),
            ("requireUppercase", "passwordRequireUppercase"),
            ("requireSpecialChars", "passwordRequireSpecialChars"),
            ("historyCount", "passwordHistoryCount"),
            ("maxAgeDays", "passwordMaxAgeDays"),
        )
        if body.get(flat)
    }
    session = {
        key: body[flat]
        for key, flat in (
            ("idleMinutes", "ssoSessionIdleMinutes"),
            ("maxHours", "ssoSessionMaxHours"),
            ("rememberMe", "rememberMe"),
        )
        if body.get(flat)
    }
    brute: dict = {}
    if body.get("bruteForceProtected"):
        brute["enabled"] = True
        for key, flat in (
            ("maxLoginFailures", "maxLoginFailures"),
            ("lockoutDurationSeconds", "lockoutDurationSeconds"),
        ):
            if body.get(flat):
                brute[key] = body[flat]

    out = {}
    if password:
        out["password"] = password
    if session:
        out["session"] = session
    if brute:
        out["bruteForce"] = brute
    return out


@router.get("/security-policies")
async def security_policies(
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """A READ of state: what this tenant declares, and what applies where it
    declares nothing."""
    answer = await director.forward(
        settings,
        "GET",
        f"/v1/tenants/{_tenant(settings, tenant)}/security-policy",
        bearer_of(credentials),
    )
    if answer.status_code != 200:
        return answer
    body = json.loads(answer.body)
    flat = _flat(body.get("policy") or {}, body.get("defaults") or {})
    return Response(content=json.dumps(flat), status_code=200, media_type="application/json")


@router.put("/security-policies")
async def set_security_policies(
    body: dict,
    tenant: str | None = Query(default=None),
    credentials: HTTPAuthorizationCredentials | None = Depends(_bearer),
    _user: dict = Depends(get_current_user),
    settings: Settings = Depends(get_settings),
) -> Response:
    """A WRITE of declared state: answers a commit, not a save. Argo CD
    applies it and the composition writes it onto the realm."""
    if body.get("requireTotpAdmins") or body.get("requireTotpMembers", "none") != "none":
        raise HTTPException(status_code=400, detail=TOTP_NOT_SETTABLE)
    return await director.forward(
        settings,
        "PUT",
        f"/v1/tenants/{_tenant(settings, tenant)}/security-policy",
        bearer_of(credentials),
        json_body=_nested(body),
    )
