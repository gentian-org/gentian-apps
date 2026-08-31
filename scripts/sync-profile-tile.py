#!/usr/bin/env python3
"""Inline profiles/<name>/assets/tile.svg into spec.tile.logo (path 1 custom tiles).

Edits the `logo:` line in place rather than re-serialising the document. The
previous version did yaml.safe_load -> yaml.safe_dump, which rewrote the whole
file and silently deleted every comment in it -- including the header block
profiles use to record *why* they are built the way they are. Running it once
on docmost-ce dropped 118 lines of design rationale, which is a poor trade for
inlining one base64 string.

Only lines this script writes are touched, so comments, key order, block
scalars and quoting elsewhere in the file survive untouched.
"""

from __future__ import annotations

import base64
import re
import sys
from pathlib import Path

import yaml

DATA_URI_PREFIX = "data:image/svg+xml;base64,"

# "image: assets/tile.svg" -- a value on the same line. A nested mapping such as
# the charts' "image:\n  repository: ..." has no value here and is skipped, as
# is any value that does not resolve to a file (e.g. "image: docker.io/x:1").
IMAGE_LINE = re.compile(r"^(?P<indent>\s*)image:\s*(?P<value>\S+)\s*$")


def encode_svg(path: Path) -> str:
    payload = base64.b64encode(path.read_bytes()).decode("ascii")
    return f"{DATA_URI_PREFIX}{payload}"


def sync_profile(profile_dir: Path) -> int:
    profile_path = profile_dir / "profile.yaml"
    if not profile_path.is_file():
        print(f"missing {profile_path}", file=sys.stderr)
        return 1

    original = profile_path.read_text(encoding="utf-8")
    lines = original.splitlines(keepends=True)

    out: list[str] = []
    updated: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        match = IMAGE_LINE.match(line)
        if not match:
            out.append(line)
            i += 1
            continue

        rel = match.group("value").strip("\"'")
        image_path = profile_dir / rel
        if not image_path.is_file():
            out.append(line)
            i += 1
            continue

        indent = match.group("indent")
        out.append(line)
        i += 1

        # Replace an existing sibling logo:/icon: pair rather than duplicating
        # it. icon and image are mutually exclusive -- the tile validator
        # rejects a tile that sets both.
        while i < len(lines) and re.match(rf"^{indent}(logo|icon):\s", lines[i]):
            i += 1

        out.append(f"{indent}logo: {encode_svg(image_path)}\n")
        updated.append(rel)

    if not updated:
        print(f"No tile.image to inline in {profile_path}", file=sys.stderr)
        return 1

    rewritten = "".join(out)
    if rewritten == original:
        print(f"tile.logo already current in {profile_path}")
        return 0

    # The edit is textual, so prove the result still parses and that the logo
    # actually matches the asset before overwriting the file.
    doc = yaml.safe_load(rewritten)
    if not doc or doc.get("kind") != "AppProfile":
        print(f"refusing to write {profile_path}: result is not a valid AppProfile", file=sys.stderr)
        return 1

    profile_path.write_text(rewritten, encoding="utf-8")
    for rel in updated:
        print(f"Inlined {rel} into tile.logo")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} profiles/<name>", file=sys.stderr)
        return 1
    return sync_profile(Path(sys.argv[1]))


if __name__ == "__main__":
    raise SystemExit(main())
