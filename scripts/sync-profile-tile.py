#!/usr/bin/env python3
"""Inline profiles/<name>/assets/tile.svg into spec.tile.logo (path 1 custom tiles)."""

from __future__ import annotations

import base64
import sys
from pathlib import Path

import yaml

DATA_URI_PREFIX = "data:image/svg+xml;base64,"


def encode_svg(path: Path) -> str:
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"{DATA_URI_PREFIX}{payload}"


def sync_profile(profile_dir: Path) -> int:
    profile_path = profile_dir / "profile.yaml"
    if not profile_path.is_file():
        print(f"missing {profile_path}", file=sys.stderr)
        return 1

    doc = yaml.safe_load(profile_path.read_text(encoding="utf-8"))
    spec = doc.setdefault("spec", {})
    tile = spec.setdefault("tile", {})
    image_rel = tile.get("image")
    if not image_rel:
        print(f"{profile_dir}: spec.tile.image not set", file=sys.stderr)
        return 1

    image_path = profile_dir / image_rel
    if not image_path.is_file():
        print(f"missing {image_path}", file=sys.stderr)
        return 1

    tile["logo"] = encode_svg(image_path)
    tile.pop("icon", None)
    profile_path.write_text(yaml.safe_dump(doc, sort_keys=False), encoding="utf-8")
    print(f"Updated {profile_path} tile.logo from {image_rel}")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} profiles/<name>", file=sys.stderr)
        return 1
    return sync_profile(Path(sys.argv[1]))


if __name__ == "__main__":
    raise SystemExit(main())
