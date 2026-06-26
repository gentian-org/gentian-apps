from __future__ import annotations

import base64
import json
from functools import lru_cache
from pathlib import Path
from typing import Any

CATALOGUE_PATH = Path(__file__).resolve().parent.parent / "data" / "tile-catalogue.json"
DATA_URI_PREFIX = "data:image/svg+xml;base64,"
DEFAULT_ICON = "app"


@lru_cache(maxsize=1)
def _catalogue() -> dict[str, Any]:
    return json.loads(CATALOGUE_PATH.read_text(encoding="utf-8"))


def resolve_tile_logo(spec: dict[str, Any]) -> str | None:
    """Resolve AppProfile.spec to a portal tile data URI."""
    tile = spec.get("tile") or {}
    logo = tile.get("logo")
    if logo:
        return logo if logo.startswith(DATA_URI_PREFIX) else f"{DATA_URI_PREFIX}{logo}"

    icon_id = tile.get("icon")
    if icon_id:
        entry = _catalogue()["tiles"].get(icon_id)
        if entry and entry.get("dataUri"):
            return entry["dataUri"]

    legacy = spec.get("logo")
    if legacy:
        return legacy if legacy.startswith(DATA_URI_PREFIX) else f"{DATA_URI_PREFIX}{legacy}"

    default = _catalogue()["tiles"].get(DEFAULT_ICON, {})
    return default.get("dataUri")


def encode_custom_svg(svg_path: Path) -> str:
    payload = base64.b64encode(svg_path.read_bytes()).decode("ascii")
    return f"{DATA_URI_PREFIX}{payload}"
