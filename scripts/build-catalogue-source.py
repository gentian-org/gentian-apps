#!/usr/bin/env python3
"""Build the catalogue source a cluster fetches from.

    build-catalogue-source.py [--out dist/catalogue] [--check]

This repository stores a profile as a BUNDLE — ``profiles/[<family>/]<name>/``
holding ``profile.yaml``, ``listing.yaml`` and whatever else it needs — because
that is what Argo CD's ApplicationSet syncs, one Application per directory.

A catalogue SOURCE is the other shape: a flat directory served over https,
holding ``profiles/<name>.yaml``, ``listings/<name>.yaml`` and ``index.yaml``.
That is what a director materialises an entry from (AD-3) and what the App
Store ingests. The two shapes exist for two different consumers and neither is
a mistake; this script turns the first into the second.

``index.yaml`` is why it matters. An https server does not list a directory,
so without an index a cluster can install from this catalogue by name but
cannot say what is in it — which is the whole of a cluster's own catalogue
screen (AD-14). The index is the technical half and nothing else: name,
version, edition, trust tier, digest. Presentation belongs to the App Store,
which keeps it current; a cluster copying it would go stale.

The digest is the sha256 of the profile file AS PUBLISHED. It has to be taken
here, on the flattened file, because that is the byte sequence a director
fetches and hashes. Taking it on the bundle's own profile.yaml would name a
number nothing serves.

The format is the contract, and its reader is the authority:
gentian-os ``internal/director/catalogue/index.go``. gentian-os also ships
``scripts/tools/build-catalogue-index.py``, which indexes a catalogue
directory somebody else assembled — it does not know about this repository's
bundle layout, which is why the flattening lives here.
"""

from __future__ import annotations

import argparse
import hashlib
import shutil
import sys
from pathlib import Path

import yaml

REPO = Path(__file__).resolve().parent.parent

# The editions an entry may declare. Mirrors gentian-os's api/v1alpha1
# Edition: community, private, maintained, enterprise. A cluster lists ce and
# pe from its own sources and sends people to the App Store for the other two,
# so a typo here would quietly decide where an entry can be seen.
EDITIONS = ("ce", "pe", "me", "ee")


def edition_of(name: str, listing: dict) -> str:
    """The listing's edition, or the one the bundle's own name ends in."""
    declared = str(listing.get("edition") or "").strip().lower()
    if declared:
        return declared
    tail = name.rsplit("-", 1)[-1].lower()
    return tail if tail in EDITIONS else "ce"


def load(path: Path) -> dict:
    return yaml.safe_load(path.read_text()) or {}


def build(out: Path) -> tuple[list[dict], list[str]]:
    profiles_dir = out / "profiles"
    listings_dir = out / "listings"
    for d in (profiles_dir, listings_dir):
        d.mkdir(parents=True, exist_ok=True)

    entries: list[dict] = []
    complaints: list[str] = []
    seen: dict[str, Path] = {}

    for bundle in sorted(REPO.glob("profiles/**/profile.yaml")):
        directory = bundle.parent
        rel = directory.relative_to(REPO)
        try:
            profile = load(bundle)
        except yaml.YAMLError as exc:
            complaints.append(f"{rel}: profile.yaml does not parse: {exc}")
            continue

        name = (profile.get("metadata") or {}).get("name") or ""
        if not name:
            complaints.append(f"{rel}: profile.yaml has no metadata.name")
            continue
        # The same rule the ApplicationSet lives by: Applications are named
        # after metadata.name, and so are the files here, so two bundles
        # sharing a name would overwrite each other rather than collide
        # visibly.
        if name in seen:
            complaints.append(f"{name}: declared by both {seen[name]} and {rel}")
            continue
        seen[name] = rel

        kind = profile.get("kind")
        if kind != "ComponentProfile":
            # AD-4 leaves one catalogue kind. A bundle still shipping the old
            # one would be published and then refused by the API server on the
            # far side, which is a worse place to find out.
            complaints.append(f"{name}: kind is {kind!r}, not ComponentProfile")
            continue

        spec = profile.get("spec") or {}
        # Only what a tenant can install. A system profile is part of the
        # kernel and nobody installs one from a catalogue screen.
        if "tenant" not in (spec.get("tenancy") or ["tenant"]):
            continue

        listing = {}
        listing_path = directory / "listing.yaml"
        if listing_path.exists():
            try:
                listing = load(listing_path)
            except yaml.YAMLError as exc:
                complaints.append(f"{name}: listing.yaml does not parse: {exc}")

        edition = edition_of(name, listing)
        if edition not in EDITIONS:
            complaints.append(
                f"{name}: edition {edition!r} is not one of {', '.join(EDITIONS)}"
            )
            continue

        published = profiles_dir / f"{name}.yaml"
        shutil.copyfile(bundle, published)
        if listing_path.exists():
            shutil.copyfile(listing_path, listings_dir / f"{name}.yaml")

        entry = {
            "name": name,
            "version": str(spec.get("version") or "0.0.0"),
            "edition": edition,
            # Taken on the published file, which is the one a director fetches.
            "digest": "sha256:" + hashlib.sha256(published.read_bytes()).hexdigest(),
        }
        if spec.get("trustTier"):
            entry["trustTier"] = str(spec["trustTier"])
        entries.append(entry)

    entries.sort(key=lambda e: e["name"])
    return entries, complaints


def render(entries: list[dict]) -> str:
    return (
        "# Generated by scripts/build-catalogue-source.py. Do not edit.\n"
        "# The technical half of this catalogue. Presentation is the App Store's.\n"
        + yaml.safe_dump({"entries": entries}, sort_keys=False, width=100)
    )


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__)
    ap.add_argument("--out", type=Path, default=REPO / "dist" / "catalogue")
    ap.add_argument(
        "--check",
        action="store_true",
        help="build into a temporary directory and report, writing nothing lasting",
    )
    ap.add_argument(
        "--with-landing-page",
        action="store_true",
        help="also write index.html, so a person who opens the site sees what it is",
    )
    args = ap.parse_args()

    out = args.out
    if out.exists():
        shutil.rmtree(out)
    entries, complaints = build(out)

    for complaint in complaints:
        print(f"  REFUSED  {complaint}", file=sys.stderr)

    (out / "index.yaml").write_text(render(entries))

    by_edition: dict[str, int] = {}
    for e in entries:
        by_edition[e["edition"]] = by_edition.get(e["edition"], 0) + 1
    shown = ", ".join(f"{n} {ed}" for ed, n in sorted(by_edition.items()))
    print(f"Catalogue source at {out}: {len(entries)} entries ({shown or 'none'})")
    local = by_edition.get("ce", 0) + by_edition.get("pe", 0)
    print(
        f"  a cluster browsing this source lists {local}; "
        f"the other {len(entries) - local} are the App Store's to present."
    )

    if args.with_landing_page:
        # Served over https for machines, so the root would otherwise be a 404
        # for the person who follows the URL to find out what it is.
        rows = "\n".join(
            f'      <tr><td><code>{e["name"]}</code></td><td>{e["version"]}</td>'
            f'<td>{e["edition"]}</td></tr>'
            for e in entries
        )
        (out / "index.html").write_text(f"""<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Gentian catalogue</title>
<style>
 body {{ font: 15px/1.5 system-ui, sans-serif; margin: 2rem auto; max-width: 52rem; padding: 0 1rem; }}
 table {{ border-collapse: collapse; width: 100%; }}
 td, th {{ text-align: left; padding: .3rem .6rem; border-bottom: 1px solid #ddd; }}
 code {{ font-size: .9em; }}
</style></head><body>
<h1>Gentian catalogue</h1>
<p>A catalogue source: profile bundles a Gentian cluster installs from. Name it on
a Cluster claim under <code>spec.catalogue.sources</code>; the director fetches an
entry at the digest the App Store states and refuses anything else.</p>
<ul>
 <li><a href="index.yaml">index.yaml</a> — what is here, at which version and digest</li>
 <li><code>profiles/&lt;name&gt;.yaml</code> — the ComponentProfile</li>
 <li><code>listings/&lt;name&gt;.yaml</code> — how the App Store presents it</li>
</ul>
<p>{len(entries)} entries.</p>
<table><thead><tr><th>Name</th><th>Version</th><th>Edition</th></tr></thead>
<tbody>
{rows}
</tbody></table>
</body></html>
""")

    if args.check:
        shutil.rmtree(out, ignore_errors=True)
    # A refusal fails the build. An entry that cannot be published is an entry
    # that silently disappears from every cluster's catalogue, and a green
    # build that quietly ships fewer apps is worse than a red one.
    return 1 if complaints else 0


if __name__ == "__main__":
    raise SystemExit(main())
