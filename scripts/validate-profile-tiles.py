#!/usr/bin/env python3
"""Validate AppProfile tile specs in gentian-apps profiles."""

from __future__ import annotations

import json
import re
import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PROFILES = ROOT / "profiles"
CATALOGUE = Path(__file__).resolve().parent / "data" / "tile-catalogue.json"
DATA_URI_RE = re.compile(r"^data:image/svg\+xml;base64,[A-Za-z0-9+/]+=*$")


def load_catalogue_ids() -> set[str]:
    data = json.loads(CATALOGUE.read_text(encoding="utf-8"))
    return set(data.get("tiles", {}).keys())


def validate_profile(path: Path, catalogue_ids: set[str]) -> list[str]:
    errors: list[str] = []
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not doc or doc.get("kind") != "AppProfile":
        return errors

    spec = doc.get("spec") or {}
    rel = path.relative_to(ROOT)
    profile_tile = spec.get("tile") or {}

    def check_tile(tile: dict, label: str) -> None:
        if not tile:
            return
        icon = tile.get("icon")
        logo = tile.get("logo")
        image = tile.get("image")
        if icon and (logo or image):
            errors.append(f"{rel} {label}: set either tile.icon or tile.image/tile.logo, not both")
            return
        if icon and icon not in catalogue_ids:
            errors.append(f"{rel} {label}: unknown tile.icon {icon!r}")
        if logo and not DATA_URI_RE.match(logo):
            errors.append(f"{rel} {label}: tile.logo must be a data:image/svg+xml;base64,... URI")
        if image:
            image_path = path.parent / image
            if not image_path.is_file():
                errors.append(f"{rel} {label}: tile.image missing file {image}")
            elif not tile.get("logo"):
                errors.append(
                    f"{rel} {label}: tile.image set without tile.logo — run scripts/sync-profile-tile.py"
                )

    check_tile(profile_tile, "spec.tile")

    if not profile_tile and not spec.get("logo"):
        errors.append(f"{rel}: set spec.tile.icon (catalogue) or spec.tile.logo (custom)")

    for portal_tile in spec.get("portalTiles") or []:
        name = portal_tile.get("name", "?")
        check_tile(portal_tile.get("tile") or {}, f"portalTiles[{name}].tile")

    return errors


def main() -> int:
    if not CATALOGUE.is_file():
        print(f"missing tile catalogue: {CATALOGUE}", file=sys.stderr)
        return 1

    catalogue_ids = load_catalogue_ids()
    all_errors: list[str] = []

    for profile_path in sorted(PROFILES.glob("**/profile.yaml")):
        all_errors.extend(validate_profile(profile_path, catalogue_ids))

    if all_errors:
        for err in all_errors:
            print(err, file=sys.stderr)
        return 1

    print(f"Validated tiles for {len(list(PROFILES.glob('**/profile.yaml')))} profiles")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
