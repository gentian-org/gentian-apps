#!/usr/bin/env python3
"""Inline each tile's PNG into the tile's logo, which is what the cluster reads.

    sync-profile-tile.py profiles/<name>              # its profile.yaml
    sync-profile-tile.py profiles/<family>/packages/<preset>.yaml

A tile names its picture twice: `image`, the profile-relative path of the PNG
committed beside the profile (the author's copy, which a reviewer sees in the
diff), and `logo`, the same bytes as a data:image/png;base64 URI. This script
writes the second from the first, for every tile in the file whose `image`
names a file -- an exposure's tile, package.api's tile, an AppPackage's tile.
A default tile is drawn by scripts/render-default-tile.py.

Edits the `logo:` line in place rather than re-serialising the document, so
comments, key order, block scalars and quoting elsewhere in the file survive
untouched. A round trip through a YAML library would drop every comment, and
the comments are where a profile records why it is built the way it is.
"""

from __future__ import annotations

import base64
import re
import sys
from pathlib import Path

import yaml

DATA_URI_PREFIX = "data:image/png;base64,"
PNG_SIGNATURE = b"\x89PNG\r\n\x1a\n"
# The cluster's limit on tile.logo, the data URI included.
MAX_LOGO = 65536

# "image: assets/tile.png" -- a value on the same line. A nested mapping such as
# a chart's "image:\n  repository: ..." has no value here and is skipped, as is
# any value that does not resolve to a file (e.g. "image: docker.io/x:1").
IMAGE_LINE = re.compile(r"^(?P<indent>\s*)image:\s*(?P<value>\S+)\s*$")


def encode_png(path: Path) -> str:
    data = path.read_bytes()
    if not data.startswith(PNG_SIGNATURE):
        raise ValueError(f"{path} is not a PNG")
    uri = DATA_URI_PREFIX + base64.b64encode(data).decode("ascii")
    if len(uri) > MAX_LOGO:
        raise ValueError(f"{path} is {len(uri)} characters inline; a tile.logo holds at most {MAX_LOGO}")
    return uri


def siblings(lines: list[str], at: int, indent: str) -> range:
    """The lines of the mapping the line at `at` belongs to: every neighbor
    indented at least as far, up to the first line indented less."""

    def inside(line: str) -> bool:
        stripped = line.strip()
        if not stripped or stripped.startswith("#"):
            return True
        return len(line) - len(line.lstrip(" ")) >= len(indent)

    start = at
    while start > 0 and inside(lines[start - 1]):
        start -= 1
    end = at + 1
    while end < len(lines) and inside(lines[end]):
        end += 1
    return range(start, end)


def sync(path: Path) -> int:
    if path.is_dir():
        path = path / "profile.yaml"
    if not path.is_file():
        print(f"missing {path}", file=sys.stderr)
        return 1

    original = path.read_text(encoding="utf-8")
    lines = original.splitlines(keepends=True)
    updated: list[str] = []

    i = 0
    while i < len(lines):
        match = IMAGE_LINE.match(lines[i])
        rel = match.group("value").strip("\"'") if match else ""
        image = path.parent / rel
        if not match or not image.is_file():
            i += 1
            continue
        indent = match.group("indent")
        if image.suffix != ".png":
            print(f"{path}: tile.image {rel} is not a .png; draw one with scripts/render-default-tile.py", file=sys.stderr)
            return 1
        try:
            logo = f"{indent}logo: {encode_png(image)}\n"
        except ValueError as exc:
            print(f"{path}: {exc}", file=sys.stderr)
            return 1

        # Replace the sibling logo: wherever it sits in the mapping, and drop a
        # sibling icon:, which a tile with its own picture does not also name.
        block = siblings(lines, i, indent)
        own = [j for j in block if re.match(rf"^{indent}(logo|icon):(\s|$)", lines[j])]
        logos = [j for j in own if lines[j].lstrip().startswith("logo:")]
        if logos:
            lines[logos[0]] = logo
            drop = [j for j in own if j != logos[0]]
        else:
            lines.insert(i + 1, logo)
            drop = [j + 1 if j > i else j for j in own]
        for j in sorted(drop, reverse=True):
            del lines[j]
            if j < i:
                i -= 1
        updated.append(rel)
        i += 1

    if not updated:
        print(f"No tile.image to inline in {path}", file=sys.stderr)
        return 1

    rewritten = "".join(lines)
    if rewritten == original:
        print(f"tile.logo already current in {path}")
        return 0

    # The edit is textual, so prove the result still parses before writing it.
    try:
        doc = yaml.safe_load(rewritten)
    except yaml.YAMLError as exc:
        print(f"refusing to write {path}: the result does not parse: {exc}", file=sys.stderr)
        return 1
    if not isinstance(doc, dict) or not doc.get("kind"):
        print(f"refusing to write {path}: the result is not a Kubernetes object", file=sys.stderr)
        return 1

    path.write_text(rewritten, encoding="utf-8")
    for rel in updated:
        print(f"Inlined {rel} into tile.logo")
    return 0


def main() -> int:
    if len(sys.argv) != 2:
        print(f"usage: {sys.argv[0]} profiles/<name> | profiles/<family>/packages/<preset>.yaml", file=sys.stderr)
        return 1
    return sync(Path(sys.argv[1]))


if __name__ == "__main__":
    raise SystemExit(main())
