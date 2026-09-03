from __future__ import annotations

from typing import Any

import httpx

from app.core.config import get_settings


class LifecycleError(Exception):
    pass


class LifecycleClient:
    def __init__(self, base_url: str, tenant_id: str) -> None:
        self._base = base_url.rstrip("/")
        self._tenant = tenant_id

    def _url(self, profile: str | None = None) -> str:
        if profile:
            return f"{self._base}/v1/tenants/{self._tenant}/apps/{profile}"
        return f"{self._base}/v1/tenants/{self._tenant}/apps"

    def _headers(self, actor: str) -> dict[str, str]:
        return {"X-Gentian-Actor": actor}

    def list_installed(self, timeout: float = 3.0) -> list[dict[str, Any]]:
        try:
            with httpx.Client(timeout=timeout) as client:
                res = client.get(self._url(), headers=self._headers("app-store"))
        except httpx.TimeoutException as exc:
            raise LifecycleError("App lifecycle API timed out") from exc
        except httpx.TransportError as exc:
            raise LifecycleError("App lifecycle API is unreachable") from exc
        if not res.is_success:
            raise LifecycleError(_detail(res))
        data = res.json()
        return data.get("apps", [])

    def install(self, profile: str, actor: str, provision: bool = False) -> dict[str, Any]:
        try:
            with httpx.Client(timeout=120.0) as client:
                res = client.post(
                    self._url(profile),
                    params={"wait": "false", "provision": "true" if provision else "false"},
                    headers=self._headers(actor),
                )
        except httpx.TimeoutException as exc:
            raise LifecycleError("App lifecycle API timed out") from exc
        except httpx.TransportError as exc:
            raise LifecycleError("App lifecycle API is unreachable") from exc
        if not res.is_success:
            raise LifecycleError(_detail(res))
        return res.json()

    def uninstall(self, profile: str, actor: str, purge: bool = False) -> dict[str, Any]:
        params: dict[str, str] = {}
        if purge:
            params["purge"] = "true"
        with httpx.Client(timeout=900.0) as client:
            res = client.delete(
                self._url(profile),
                params=params,
                headers=self._headers(actor),
            )
            if not res.is_success:
                raise LifecycleError(_detail(res))
            return res.json()

    def set_addons(
        self,
        profile: str,
        addons: list[str],
        actor: str,
        provision: bool = False,
        provision_for: list[str] | None = None,
    ) -> dict[str, Any]:
        """Replace the addon selection of an installed app.

        The full selection is sent, so an empty list clears it — that is a real
        choice, not a no-op, because the activation script reconciles.

        provision_for carries the choice per addon, which is how the store asks
        it: Install and Provision are separate buttons on each row. It used to be
        flattened into the provision bool as "did you provision anything at all",
        which was wrong in both directions — provisioning one addon provisioned
        them all, and installing one without provisioning granted none of them,
        leaving a group with the role attribute on it and no members in it.
        """
        try:
            with httpx.Client(timeout=120.0) as client:
                res = client.put(
                    f"{self._url(profile)}/addons",
                    json={
                        "addons": addons,
                        "provision": provision,
                        "provisionFor": provision_for or [],
                    },
                    headers=self._headers(actor),
                )
        except httpx.TimeoutException as exc:
            raise LifecycleError("App lifecycle API timed out") from exc
        except httpx.TransportError as exc:
            raise LifecycleError("App lifecycle API is unreachable") from exc
        if not res.is_success:
            raise LifecycleError(_detail(res))
        return res.json()


def _detail(res: httpx.Response) -> str:
    try:
        body = res.json()
        if isinstance(body, dict) and body.get("detail"):
            return str(body["detail"])
    except Exception:
        pass
    return res.text or res.reason_phrase


def get_lifecycle_client() -> LifecycleClient:
    settings = get_settings()
    if not settings.lifecycle_url:
        raise LifecycleError("GENTIAN_LIFECYCLE_URL is not configured")
    return LifecycleClient(settings.lifecycle_url, settings.tenant_id)
