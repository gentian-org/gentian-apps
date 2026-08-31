#!/usr/bin/env python3
"""Render Nextcloud app logos into Gentian portal tiles.

The portal's shared tile catalogue only carries generic Lucide glyphs, so every
Nextcloud addon used to show a stand-in — a "wiki" page for Collectives, a "chat"
bubble for Talk. These are the real upstream app icons instead, taken from the
same release tarballs images/nextcloud/Dockerfile installs, so a tile cannot
drift from the app it names.

Upstream ships them white, sized for Nextcloud's own dark header. Here they go on
the catalogue frame in Nextcloud blue, which keeps the tiles legible next to
every other app in the portal and still groups the family by colour.

Sources are pinned by images/nextcloud/versions.env. Re-run after bumping it:

    scripts/build-nextcloud-tiles.py            # fetch, render, inline
    scripts/build-nextcloud-tiles.py --check    # CI: fail if a tile is stale
"""

from __future__ import annotations

import argparse
import base64
import io
import re
import subprocess
import sys
import tarfile
import urllib.request
import xml.etree.ElementTree as ET
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
PROFILES = ROOT / "profiles" / "nextcloud"
VERSIONS = ROOT / "images" / "nextcloud" / "versions.env"

# Nextcloud brand blue, on the catalogue frame (scripts/data/tile-catalogue.json).
GLYPH = "#0082C9"
BG = "#ECE8DF"
BORDER = "rgba(20, 21, 46, 0.08)"
SIZE, RADIUS, GLYPH_SIZE, GLYPH_INSET = 52, 10, 24, 14

SVG_NS = "http://www.w3.org/2000/svg"
NEXTCLOUD_SERVER_TAG = "v33.0.6"

# Where each logo comes from. Addon logos ride the release tarball so they match
# the installed app version; Files and the three office mimetypes are core, and
# core is not worth a 200MB server download for four files.
TARBALLS = {
    "richdocuments": "https://github.com/nextcloud-releases/richdocuments/releases/download/v{RICHDOCUMENTS_VERSION}/richdocuments-v{RICHDOCUMENTS_VERSION}.tar.gz",
    "forms": "https://github.com/nextcloud-releases/forms/releases/download/v{FORMS_VERSION}/forms-v{FORMS_VERSION}.tar.gz",
    "mail": "https://github.com/nextcloud-releases/mail/releases/download/v{MAIL_VERSION}/mail-v{MAIL_VERSION}.tar.gz",
    "calendar": "https://github.com/nextcloud-releases/calendar/releases/download/v{CALENDAR_VERSION}/calendar-v{CALENDAR_VERSION}.tar.gz",
    "contacts": "https://github.com/nextcloud-releases/contacts/releases/download/v{CONTACTS_VERSION}/contacts-v{CONTACTS_VERSION}.tar.gz",
    "tasks": "https://github.com/nextcloud/tasks/releases/download/v{TASKS_VERSION}/tasks.tar.gz",
    "deck": "https://github.com/nextcloud-releases/deck/releases/download/v{DECK_VERSION}/deck-v{DECK_VERSION}.tar.gz",
    "collectives": "https://github.com/nextcloud/collectives/releases/download/v{COLLECTIVES_VERSION}/collectives-{COLLECTIVES_VERSION}.tar.gz",
    "spreed": "https://github.com/nextcloud-releases/spreed/releases/download/v{SPREED_VERSION}/spreed-v{SPREED_VERSION}.tar.gz",
}

CORE_RAW = "https://raw.githubusercontent.com/nextcloud/server/" + NEXTCLOUD_SERVER_TAG + "/{path}"

# tile name -> (source app, member path within the tarball). A None app reads
# the core raw file; "@repo" reads a path in this repository.
LOGOS = {
    "nextcloud": ("@repo", "icons/nextcloud.svg"),
    "files": (None, "apps/files/img/app.svg"),
    "document": (None, "core/img/filetypes/x-office-document.svg"),
    "spreadsheet": (None, "core/img/filetypes/x-office-spreadsheet.svg"),
    "presentation": (None, "core/img/filetypes/x-office-presentation.svg"),
    "office": ("richdocuments", "img/app.svg"),
    "forms": ("forms", "img/forms.svg"),
    "mail": ("mail", "img/mail.svg"),
    "calendar": ("calendar", "img/calendar.svg"),
    "contacts": ("contacts", "img/app.svg"),
    "tasks": ("tasks", "img/tasks.svg"),
    "deck": ("deck", "img/deck.svg"),
    "collectives": ("collectives", "img/collectives.svg"),
    "talk": ("spreed", "img/app.svg"),
}

# Which tile each profile gets. A profile may carry the main spec.tile and, for
# richdocuments, one tile per portalTiles entry.
#   profile dir -> {"tile": name, "portalTiles": {portal tile name: tile name}}
ASSIGNMENTS = {
    "base/base-ce": {"tile": "files", "portalTiles": {"nextcloud-base-ce": "files"}},
    "base/base-od": {"tile": "files"},
    "addons/collectives-ce": {"tile": "collectives"},
    "addons/spreed-ce": {"tile": "talk"},
    "addons/calendar-ce": {"tile": "calendar"},
    "addons/contacts-ce": {"tile": "contacts"},
    "addons/mail-ce": {"tile": "mail"},
    "addons/tasks-ce": {"tile": "tasks"},
    "addons/deck-ce": {"tile": "deck"},
    "addons/forms-ce": {"tile": "forms"},
    "addons/richdocuments-ce": {
        "tile": "office",
        "portalTiles": {
            "document": "document",
            "spreadsheet": "spreadsheet",
            "presentation": "presentation",
        },
    },
}

# AppPackages are presets, not profiles, but they show the same tile in the same
# grid. The suite preset gets the Nextcloud mark rather than one app's logo.
PACKAGE_ASSIGNMENTS = {
    "packages/nextcloud-suite.yaml": "nextcloud",
    "packages/nextcloud-office.yaml": "office",
}


def load_versions() -> dict[str, str]:
    versions = {}
    for line in VERSIONS.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, _, value = line.partition("=")
        versions[key.strip()] = value.strip()
    return versions


def fetch_logos(versions: dict[str, str]) -> dict[str, str]:
    """Return tile name -> raw upstream SVG text."""
    wanted: dict[str, list[tuple[str, str]]] = {}
    raw: dict[str, str] = {}
    for name, (app, member) in LOGOS.items():
        if app == "@repo":
            raw[name] = (ROOT / member).read_text(encoding="utf-8")
        elif app is None:
            url = CORE_RAW.format(path=member)
            with urllib.request.urlopen(url, timeout=60) as resp:
                raw[name] = resp.read().decode("utf-8")
        else:
            wanted.setdefault(app, []).append((name, member))

    for app, members in wanted.items():
        url = TARBALLS[app].format(**versions)
        with urllib.request.urlopen(url, timeout=180) as resp:
            payload = resp.read()
        with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as tar:
            for name, member in members:
                path = f"{app}/{member}"
                extracted = tar.extractfile(path)
                if extracted is None:
                    raise SystemExit(f"{path} missing from {url}")
                raw[name] = extracted.read().decode("utf-8")
    return raw


def recolour(element: ET.Element) -> None:
    """Repaint upstream white to the tile glyph colour, in place.

    Every explicit fill is rewritten rather than dropped in favour of an
    inherited one: `fill="none"` is load-bearing (the office mimetype icons draw
    a transparent bounding rect first) and would become a solid blue square.
    """
    fill = element.get("fill")
    if fill is not None and fill.strip().lower() != "none":
        element.set("fill", GLYPH)
    style = element.get("style")
    if style:
        style = re.sub(
            r"fill\s*:\s*(?!none)[^;]+",
            f"fill:{GLYPH}",
            style,
            flags=re.IGNORECASE,
        )
        element.set("style", style)
    for child in element:
        recolour(child)


def render_tile(name: str, source: str) -> str:
    ET.register_namespace("", SVG_NS)
    root = ET.fromstring(source)
    view_box = root.get("viewBox")
    if not view_box:
        width, height = root.get("width", "16"), root.get("height", "16")
        view_box = f"0 0 {width.rstrip('px')} {height.rstrip('px')}"

    glyph = ET.Element(f"{{{SVG_NS}}}svg")
    glyph.set("x", str(GLYPH_INSET))
    glyph.set("y", str(GLYPH_INSET))
    glyph.set("width", str(GLYPH_SIZE))
    glyph.set("height", str(GLYPH_SIZE))
    glyph.set("viewBox", view_box)
    # Some logos paint from the root element rather than from each path — core's
    # Files icon is a single unfilled path under fill="#fff" — so the root's own
    # paint has to come along or the glyph renders in the default black.
    for attribute in ("fill", "style"):
        value = root.get(attribute)
        if value:
            glyph.set(attribute, value)
    # Upstream logos are drawn to fill their own viewBox edge to edge; the frame
    # inset already provides the padding the catalogue glyphs have baked in.
    for child in root:
        glyph.append(child)
    recolour(glyph)

    body = ET.tostring(glyph, encoding="unicode")
    body = body.replace(f' xmlns="{SVG_NS}"', "", 1)
    return (
        f'<svg xmlns="{SVG_NS}" width="{SIZE}" height="{SIZE}" '
        f'viewBox="0 0 {SIZE} {SIZE}" role="img">\n'
        f'  <rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="{BG}"/>\n'
        f'  <rect width="{SIZE}" height="{SIZE}" rx="{RADIUS}" fill="none" '
        f'stroke="{BORDER}" stroke-width="1"/>\n'
        f"  {body}\n"
        f"</svg>\n"
    )


def data_uri(svg: str) -> str:
    return "data:image/svg+xml;base64," + base64.b64encode(svg.encode("utf-8")).decode("ascii")


TILE_KEY_RE = re.compile(r"^(\s*)tile:\s*$")
SEQ_NAME_RE = re.compile(r"^(\s*)-\s+name:\s*(\S+)\s*$")


def patch_tile_blocks(text: str, resolve) -> str:
    """Rewrite every `tile:` mapping resolve() claims, leaving the rest byte-identical.

    A YAML round-trip would be shorter, but ruamel re-indents sequences it did not
    write, so a two-line tile change arrived as a 56-line diff across blocks that
    have nothing to do with tiles. These files are read far more often than this
    script runs; the diff is the product.
    """
    lines = text.splitlines(keepends=True)
    out: list[str] = []
    index = 0
    while index < len(lines):
        match = TILE_KEY_RE.match(lines[index])
        if not match:
            out.append(lines[index])
            index += 1
            continue

        indent = match.group(1)
        end = index + 1
        while end < len(lines):
            line = lines[end]
            if not line.strip():
                break
            if len(line) - len(line.lstrip()) <= len(indent):
                break
            end += 1

        # spec.tile sits directly under spec; anything deeper belongs to the
        # portalTiles entry whose `- name:` is the nearest one above it.
        if len(indent) == 2:
            key = None
        else:
            key = next(
                (
                    SEQ_NAME_RE.match(lines[back]).group(2)
                    for back in range(index - 1, -1, -1)
                    if SEQ_NAME_RE.match(lines[back])
                ),
                None,
            )

        replacement = resolve(key)
        if replacement is None:
            out.extend(lines[index:end])
        else:
            rel, uri = replacement
            out.append(lines[index])
            out.append(f"{indent}  image: {rel}\n")
            out.append(f"{indent}  logo: {uri}\n")
        index = end
    return "".join(out)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--check", action="store_true", help="fail instead of writing")
    args = parser.parse_args()

    versions = load_versions()
    raw = fetch_logos(versions)
    tiles = {name: render_tile(name, source) for name, source in raw.items()}

    stale: list[str] = []

    def write_asset(profile_dir: Path, tile_name: str) -> str:
        rel = f"assets/tile-{tile_name}.svg"
        path = profile_dir / rel
        svg = tiles[tile_name]
        current = path.read_text(encoding="utf-8") if path.is_file() else None
        if current != svg:
            stale.append(str(path.relative_to(ROOT)))
            if not args.check:
                path.parent.mkdir(parents=True, exist_ok=True)
                path.write_text(svg, encoding="utf-8")
        return rel

    def patch(path: Path, wanted: dict[str | None, str]) -> None:
        def resolve(key):
            tile_name = wanted.get(key)
            if tile_name is None:
                return None
            return write_asset(path.parent, tile_name), data_uri(tiles[tile_name])

        before = path.read_text(encoding="utf-8")
        after = patch_tile_blocks(before, resolve)
        if before != after:
            stale.append(str(path.relative_to(ROOT)))
            if not args.check:
                path.write_text(after, encoding="utf-8")

    for rel_dir, assignment in ASSIGNMENTS.items():
        wanted: dict[str | None, str] = {None: assignment["tile"]}
        wanted.update(assignment.get("portalTiles") or {})
        patch(PROFILES / rel_dir / "profile.yaml", wanted)

    for rel_path, tile_name in PACKAGE_ASSIGNMENTS.items():
        patch(PROFILES / rel_path, {None: tile_name})

    if args.check and stale:
        print("stale Nextcloud tiles — run scripts/build-nextcloud-tiles.py:", file=sys.stderr)
        for item in sorted(set(stale)):
            print(f"  {item}", file=sys.stderr)
        return 1

    print(f"Rendered {len(tiles)} Nextcloud tiles in {GLYPH}; touched {len(set(stale))} file(s)")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
