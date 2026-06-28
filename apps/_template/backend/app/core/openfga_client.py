"""OpenFGA / AuthZEN PDP client stub (M22, S1).

Replace the no-op path with a real Check call when OPENFGA_API_URL is set.
See gentian-os/docs/design/new-security-architecture.md §2.2.
"""

from typing import Any

import httpx

from app.core.config import Settings


class OpenFGAClient:
    def __init__(self, settings: Settings) -> None:
        self._settings = settings
        self._enabled = bool(settings.openfga_api_url and settings.openfga_store_id)

    @property
    def enabled(self) -> bool:
        return self._enabled

    async def check(
        self,
        *,
        user: str,
        relation: str,
        object_type: str,
        object_id: str,
    ) -> bool:
        """Return True if user has relation on object_type:object_id."""
        if not self._enabled:
            # Stage 1: OIDC + tenant MAC isolation only
            return True

        url = (
            f"{self._settings.openfga_api_url.rstrip('/')}"
            f"/stores/{self._settings.openfga_store_id}/check"
        )
        payload: dict[str, Any] = {
            "tuple_key": {
                "user": user,
                "relation": relation,
                "object": f"{object_type}:{object_id}",
            },
        }
        async with httpx.AsyncClient(timeout=5.0) as client:
            resp = await client.post(url, json=payload)
            resp.raise_for_status()
            return bool(resp.json().get("allowed"))
