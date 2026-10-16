#!/usr/bin/env python3
"""Draw a profile's default tile: a platform glyph on the neutral square, as PNG.

    render-default-tile.py <glyph> <profile-dir>/assets/tile.png
    render-default-tile.py --list

Every default tile looks the same way on purpose -- one glyph, one frame, one
colour -- so that it reads as "this app has not brought its own picture" rather
than as anybody's logo. An app's own logo is the App Store's to show.

The glyphs are scripts/data/tile-catalogue.json, a copy of gentian-os
internal/tiles/catalogue.json: the same set the desktop draws its own tiles
from. Refresh the copy from there rather than editing it here.

PNG rather than SVG because a PNG is an image a browser only paints, where an
SVG is a document that may carry script or fetch from elsewhere; the cluster
accepts a tile only as data:image/png. The drawing happens here, when the tile
is authored and committed -- never on a cluster or in CI. Then inline it:

    scripts/sync-profile-tile.py <profile-dir>

Needs cairosvg (pip install cairosvg) or, failing that, rsvg-convert.
"""

from __future__ import annotations

import base64
import json
import shutil
import subprocess
import sys
from pathlib import Path

CATALOGUE = Path(__file__).resolve().parent / "data" / "tile-catalogue.json"
SVG_PREFIX = "data:image/svg+xml;base64,"
SIZE = 128
# The cluster's limit on tile.logo, the data URI included.
MAX_LOGO = 65536


def glyphs() -> dict[str, bytes]:
    tiles = json.loads(CATALOGUE.read_text(encoding="utf-8"))["tiles"]
    out = {}
    for name, tile in tiles.items():
        uri = tile["dataUri"]
        if not uri.startswith(SVG_PREFIX):
            raise SystemExit(f"{CATALOGUE}: glyph {name!r} is not an SVG data URI")
        out[name] = base64.b64decode(uri[len(SVG_PREFIX) :])
    return out


def draw(svg: bytes) -> bytes:
    try:
        import cairosvg
    except ImportError:
        cairosvg = None
    if cairosvg is not None:
        return cairosvg.svg2png(bytestring=svg, output_width=SIZE, output_height=SIZE)
    if shutil.which("rsvg-convert"):
        return subprocess.run(
            ["rsvg-convert", "--width", str(SIZE), "--height", str(SIZE), "--format", "png"],
            input=svg,
            capture_output=True,
            check=True,
        ).stdout
    raise SystemExit("needs cairosvg (pip install cairosvg) or rsvg-convert")


def main() -> int:
    args = sys.argv[1:]
    available = glyphs()
    if args == ["--list"]:
        print("\n".join(sorted(available)))
        return 0
    if len(args) != 2:
        print(__doc__.split("\n\n")[1], file=sys.stderr)
        return 1
    glyph, out = args[0], Path(args[1])
    if glyph not in available:
        print(f"unknown glyph {glyph!r}; one of: {', '.join(sorted(available))}", file=sys.stderr)
        return 1
    if out.suffix != ".png":
        print(f"{out}: a tile is written as .png", file=sys.stderr)
        return 1
    png = draw(available[glyph])
    logo = len("data:image/png;base64,") + len(base64.b64encode(png))
    if logo > MAX_LOGO:
        print(f"{glyph}: the tile is {logo} characters inline, over {MAX_LOGO}", file=sys.stderr)
        return 1
    out.parent.mkdir(parents=True, exist_ok=True)
    out.write_bytes(png)
    print(f"Drew {glyph} into {out} ({len(png)} bytes)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
