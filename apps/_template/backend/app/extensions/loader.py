"""Discover and load plugins registered under this app's entry-point group.

This is the L3 (in-app extension) mechanism for apps built from the Gentian
template. It exists so consumers who need behaviour *inside* the app do not have
to fork it — see gentian-os/docs/app-customization.md.

Two design choices are deliberate:

* **Version gating happens before anything is called.** A plugin written against
  an unsupported major is refused with a clear message rather than half-loaded.
* **A failing plugin never takes down the app.** Load errors are recorded and
  reported through ``/api/v1/extensions``; the app starts regardless. A tenant
  losing one feature is recoverable, a crash-looping pod is not.
"""

from __future__ import annotations

import logging
from dataclasses import dataclass, field
from importlib.metadata import entry_points
from typing import Any

from fastapi import APIRouter

from app.extensions.api import (
    ENTRY_POINT_GROUP_TEMPLATE,
    EXTENSION_API_VERSION,
    SUPPORTED_MAJOR_VERSIONS,
    GentianExtension,
)

logger = logging.getLogger(__name__)


@dataclass
class LoadedExtension:
    """A plugin that loaded successfully."""

    name: str
    api_version: str
    instance: GentianExtension


@dataclass
class ExtensionRegistry:
    """The outcome of a discovery pass — what loaded, and what did not and why."""

    loaded: list[LoadedExtension] = field(default_factory=list)
    failed: dict[str, str] = field(default_factory=dict)

    def names(self) -> list[str]:
        return [extension.name for extension in self.loaded]

    def as_dict(self) -> dict[str, Any]:
        return {
            "apiVersion": EXTENSION_API_VERSION,
            "loaded": [
                {"name": extension.name, "apiVersion": extension.api_version}
                for extension in self.loaded
            ],
            "failed": self.failed,
        }


def _major(version: str) -> int | None:
    try:
        return int(str(version).split(".", 1)[0])
    except (ValueError, AttributeError):
        return None


def discover(app_id: str) -> ExtensionRegistry:
    """Load every plugin registered for ``app_id``."""
    registry = ExtensionRegistry()
    group = ENTRY_POINT_GROUP_TEMPLATE.format(app_id=app_id)

    for entry_point in entry_points(group=group):
        try:
            factory = entry_point.load()
            instance = factory() if callable(factory) else factory

            declared = getattr(instance, "api_version", None)
            if declared is None:
                raise AttributeError(
                    "plugin does not declare api_version — it cannot be version-checked"
                )

            major = _major(declared)
            if major not in SUPPORTED_MAJOR_VERSIONS:
                raise ValueError(
                    f"plugin targets extension API {declared}, but this app supports "
                    f"major version(s) {SUPPORTED_MAJOR_VERSIONS}"
                )

            registry.loaded.append(
                LoadedExtension(name=entry_point.name, api_version=str(declared), instance=instance)
            )
            logger.info("loaded extension %s (api %s)", entry_point.name, declared)
        except Exception as exc:  # noqa: BLE001 — one bad plugin must not stop startup
            registry.failed[entry_point.name] = str(exc)
            logger.error("failed to load extension %s: %s", entry_point.name, exc)

    return registry


def mount_routes(registry: ExtensionRegistry, parent: APIRouter | Any, prefix: str) -> None:
    """Mount each plugin's routes under ``<prefix>/ext/<plugin-name>``.

    Namespacing by plugin name means two plugins cannot claim the same path, and a
    route's origin is obvious from its URL when debugging.
    """
    for extension in registry.loaded:
        register = getattr(extension.instance, "register_routes", None)
        if register is None:
            continue
        router = APIRouter()
        try:
            register(router)
        except Exception as exc:  # noqa: BLE001
            registry.failed[extension.name] = f"register_routes failed: {exc}"
            logger.error("extension %s failed to register routes: %s", extension.name, exc)
            continue
        parent.include_router(router, prefix=f"{prefix}/ext/{extension.name}")


def collect_settings(registry: ExtensionRegistry) -> dict[str, Any]:
    """Merge plugin-contributed settings defaults.

    These sit at the *bottom* of the precedence chain: a plugin may add defaults,
    never override operator or tenant configuration.
    """
    merged: dict[str, Any] = {}
    for extension in registry.loaded:
        contribute = getattr(extension.instance, "register_settings", None)
        if contribute is None:
            continue
        try:
            merged.update(contribute() or {})
        except Exception as exc:  # noqa: BLE001
            registry.failed[extension.name] = f"register_settings failed: {exc}"
            logger.error("extension %s failed to contribute settings: %s", extension.name, exc)
    return merged


def emit(registry: ExtensionRegistry, event: str, payload: dict[str, Any]) -> None:
    """Deliver an application event to every plugin that wants it."""
    for extension in registry.loaded:
        handler = getattr(extension.instance, "on_event", None)
        if handler is None:
            continue
        try:
            handler(event, payload)
        except Exception as exc:  # noqa: BLE001 — handlers must not break the caller
            logger.error("extension %s failed handling %s: %s", extension.name, event, exc)
