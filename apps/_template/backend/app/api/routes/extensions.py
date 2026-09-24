"""Diagnostics for the app's customization surface.

Answers "what is extending this app, and why is this setting what it is" without
anyone needing to exec into a pod — which is the shortest path to a forbidden
cluster hotfix.
"""

from __future__ import annotations

from fastapi import APIRouter

from app.core.dropins import describe_dropins, dropin_dir
from app.extensions.api import EXTENSION_API_VERSION, SUPPORTED_MAJOR_VERSIONS

router = APIRouter(tags=["extensions"])


@router.get("/extensions")
def list_extensions() -> dict:
    """Report loaded plugins, load failures, and applied config drop-ins."""
    from app.main import extension_registry  # local import avoids a circular import

    return {
        "extensionApi": {
            "version": EXTENSION_API_VERSION,
            "supportedMajors": list(SUPPORTED_MAJOR_VERSIONS),
        },
        "extensions": extension_registry.as_dict(),
        "dropIns": {
            "directory": str(dropin_dir()),
            "applied": describe_dropins(),
        },
    }
