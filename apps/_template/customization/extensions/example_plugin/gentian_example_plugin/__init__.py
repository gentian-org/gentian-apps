"""Reference plugin — the smallest thing that exercises every hook.

Copy this directory, rename it, and delete what you do not need. Every hook is
optional: a plugin that only contributes settings needs neither routes nor events.
"""

from __future__ import annotations

from typing import Any

from fastapi import APIRouter


class ExamplePlugin:
    """Extends the host app from inside, using only the published contract."""

    #: The EXTENSION_API_VERSION this plugin was written against. The loader
    #: refuses to load a plugin whose major is outside the supported range, rather
    #: than letting it half-work.
    api_version = "1.0.0"

    def register_routes(self, router: APIRouter) -> None:
        """Routes are mounted at /api/v1/ext/example/..."""

        @router.get("/greeting")
        def greeting() -> dict[str, str]:
            return {"message": "hello from the example plugin"}

    def register_settings(self) -> dict[str, Any]:
        """Defaults only. These sit below operator and tenant configuration."""
        return {"example": {"greetingEnabled": True}}

    def on_event(self, event: str, payload: dict[str, Any]) -> None:
        """Must not raise — an exception here is logged and swallowed by the host."""
        if event == "item.created":
            pass  # react to the event


__all__ = ["ExamplePlugin"]
