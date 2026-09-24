"""The public extension contract for this app.

Everything in this module is **public API**: plugins written against it must keep
working across minor releases. That promise is the whole point — an app whose
extension surface changes without warning forces its consumers back down to
patching or forking, which is exactly what the customization ladder exists to
avoid (see gentian-os/docs/app-customization.md, principle P7).

Versioning policy
-----------------
``EXTENSION_API_VERSION`` is semver:

* **patch** — no contract change.
* **minor** — additive only. Existing plugins keep working.
* **major** — breaking. Announced at least one minor release ahead, and the
  previous two majors stay supported (N-2).

Anything not yet stable lives in ``app.extensions.proposed`` and may change or
disappear in any release. Plugins using proposed API must opt in explicitly and
must not be shipped to tenants.
"""

from __future__ import annotations

from typing import Any, Protocol, runtime_checkable

from fastapi import APIRouter

#: Semver of the contract in this module. Bump deliberately — see the policy above.
EXTENSION_API_VERSION = "1.0.0"

#: Majors this app still loads plugins for (N-2).
SUPPORTED_MAJOR_VERSIONS = (1,)

#: Entry-point group plugins register under. ``<app-id>`` is substituted per app;
#: keeping the app id in the group name stops a plugin for one Gentian app being
#: loaded accidentally by another.
ENTRY_POINT_GROUP_TEMPLATE = "gentian.app.{app_id}.plugins"


@runtime_checkable
class GentianExtension(Protocol):
    """What a plugin must provide.

    Every hook is optional except ``api_version``: a plugin that only contributes
    settings should not have to implement routing.
    """

    #: The ``EXTENSION_API_VERSION`` this plugin was written against.
    api_version: str

    def register_routes(self, router: APIRouter) -> None:
        """Contribute HTTP routes.

        The router is mounted under the app's versioned API prefix, inside a
        per-plugin path segment, so two plugins cannot collide.
        """

    def register_settings(self) -> dict[str, Any]:
        """Contribute configuration defaults.

        Returned values sit *below* every other layer in the precedence chain, so
        a plugin can never override operator or tenant configuration.
        """

    def on_event(self, event: str, payload: dict[str, Any]) -> None:
        """React to an application event.

        Handlers must be side-effect-safe and must not raise: an exception here is
        logged and swallowed, because one bad plugin must not take down the app.
        """


class ExtensionError(RuntimeError):
    """Raised when a plugin cannot be loaded or is incompatible."""


__all__ = [
    "ENTRY_POINT_GROUP_TEMPLATE",
    "EXTENSION_API_VERSION",
    "SUPPORTED_MAJOR_VERSIONS",
    "ExtensionError",
    "GentianExtension",
]
