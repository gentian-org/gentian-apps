#!/usr/bin/env python3
"""Validate the tiles of every profile and preset in gentian-apps.

A ComponentProfile carries a tile on an exposure (spec.expose[].tile) or, for
a component that is only a link, on spec.package.api.tile. An AppPackage
preset carries one at spec.tile. Each tile is a PNG: `logo` is the data URI the
cluster reads, `image` the committed file it was inlined from, and the two
must be the same bytes.
"""

from __future__ import annotations

import base64
import json
import re
import struct
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PROFILES = ROOT / "profiles"
CATALOGUE = Path(__file__).resolve().parent / "data" / "tile-catalogue.json"
DATA_URI_PREFIX = "data:image/png;base64,"
DATA_URI_RE = re.compile(r"^data:image/png;base64,[A-Za-z0-9+/]+=*$")
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# The cluster's limit on tile.logo, the data URI included.
MAX_LOGO = 65536
SIZE = 128


def load_catalogue_ids() -> set[str]:
    data = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    return set(data.get("tiles", {}).keys())


def png_size(data: bytes) -> tuple[int, int] | None:
    if not data.startswith(PNG_SIGNATURE) or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


def check_tile(path: Path, tile: dict, label: str, catalogue_ids: set[str], icon_allowed: bool) -> list[str]:
    errors: list[str] = []
    rel = path.relative_to(ROOT)
    icon = tile.get("icon")
    logo = tile.get("logo")
    image = tile.get("image")

    if icon is not None:
        if not icon_allowed:
            errors.append(f"{rel} {label}: this tile has no icon field; draw the glyph with scripts/render-default-tile.py")
        elif logo or image:
            errors.append(f"{rel} {label}: set either tile.icon or tile.image/tile.logo, not both")
        elif icon not in catalogue_ids:
            errors.append(f"{rel} {label}: unknown tile.icon {icon!r}")
        return errors

    if not logo:
        errors.append(f"{rel} {label}: tile.logo is missing — run scripts/sync-profile-tile.py")
        return errors
    if not DATA_URI_RE.match(logo):
        errors.append(f"{rel} {label}: tile.logo must be a data:image/png;base64,... URI")
        return errors
    if len(logo) > MAX_LOGO:
        errors.append(f"{rel} {label}: tile.logo is {len(logo)} characters, over {MAX_LOGO}")
    size = png_size(base64.b64decode(logo[len(DATA_URI_PREFIX) :]))
    if size is None:
        errors.append(f"{rel} {label}: tile.logo does not hold a PNG")
    elif size != (SIZE, SIZE):
        errors.append(f"{rel} {label}: tile.logo is {size[0]}x{size[1]}, not {SIZE}x{SIZE}")

    if not image:
        errors.append(f"{rel} {label}: tile.image is missing — commit the PNG beside the profile and name it here")
        return errors
    image_path = path.parent / image
    if not image_path.is_file():
        errors.append(f"{rel} {label}: tile.image missing file {image}")
    elif image_path.suffix != ".png":
        errors.append(f"{rel} {label}: tile.image {image} is not a .png")
    elif logo != DATA_URI_PREFIX + base64.b64encode(image_path.read_bytes()).decode("ascii"):
        # The cluster only ever sees tile.logo; tile.image is the file the
        # reviewer reads. Redrawing the PNG without re-inlining leaves the two
        # saying different things, and the portal shows the old one.
        errors.append(f"{rel} {label}: tile.logo is stale for {image} — re-run scripts/sync-profile-tile.py")
    return errors


def validate_profile(path: Path, catalogue_ids: set[str]) -> list[str]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not doc or doc.get("kind") != "ComponentProfile":
        return []
    spec = doc.get("spec") or {}
    errors: list[str] = []
    for entry in spec.get("expose") or []:
        tile = (entry or {}).get("tile")
        if tile:
            errors += check_tile(path, tile, f"expose[{entry.get('name', '?')}].tile", catalogue_ids, False)
    api_tile = ((spec.get("package") or {}).get("api") or {}).get("tile")
    if api_tile:
        errors += check_tile(path, api_tile, "package.api.tile", catalogue_ids, False)
    return errors


def validate_preset(path: Path, catalogue_ids: set[str]) -> list[str]:
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not doc or doc.get("kind") != "AppPackage":
        return []
    tile = (doc.get("spec") or {}).get("tile")
    return check_tile(path, tile, "spec.tile", catalogue_ids, True) if tile else []


def main() -> int:
    if not CATALOGUE.is_file():
        print(f"missing tile catalogue: {CATALOGUE}", file=sys.stderr)
        return 1

    catalogue_ids = load_catalogue_ids()
    profiles = sorted(PROFILES.glob("**/profile.yaml"))
    presets = sorted(p for p in PROFILES.glob("**/packages/*.yaml") if p.name != "kustomization.yaml")
    errors: list[str] = []
    for path in profiles:
        errors += validate_profile(path, catalogue_ids)
    for path in presets:
        errors += validate_preset(path, catalogue_ids)

    if errors:
        for err in errors:
            print(err, file=sys.stderr)
        return 1

    print(f"Validated tiles for {len(profiles)} profiles and {len(presets)} presets")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
