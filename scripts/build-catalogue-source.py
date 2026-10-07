#!/usr/bin/env python3
"""Build the catalogue source a cluster fetches from.

    build-catalogue-source.py [--out dist/catalogue] [--check]

This repository stores a profile as a BUNDLE — ``profiles/[<family>/]<name>/``
holding ``profile.yaml``, ``listing.yaml`` and whatever else it needs — because
that is what Argo CD's ApplicationSet syncs, one Application per directory.

A catalogue SOURCE is the other shape: a flat directory served over https,
holding ``profiles/<name>.yaml``, ``listings/<name>.yaml``,
``packages/<name>.yaml`` and ``index.yaml``.
That is what a director materialises an entry from (AD-3) and what the App
Store ingests. The two shapes exist for two different consumers and neither is
a mistake; this script turns the first into the second.

``index.yaml`` is why it matters. An https server does not list a directory,
so without an index a cluster can install from this catalogue by name but
cannot say what is in it — which is the whole of a cluster's own catalogue
screen (AD-14). The index is the technical half and nothing else: name,
version, edition, trust tier, digest. Presentation belongs to the App Store,
which keeps it current; a cluster copying it would go stale.

One profile, one file, one fingerprint. ``profiles/<name>.yaml`` is the
profile's whole bundle: the ComponentProfile first and, after it, every other
object the app needs on a cluster -- its Composition, its OIDC pack, the
ConfigMaps its composition reads, its customization records. They are the
profile's COMPANIONS. A profile with none is published byte for byte as its
profile.yaml, as it always was.

What goes in is what the bundle's ``kustomization.yaml`` lists: its
``resources`` (one document a file) and its ``configMapGenerator``. What may go
in is decided on the cluster, which refuses a bundle holding anything else
(docs/profile-bundles.md here; gentian-os docs/custom-catalogues.md): a short
list of kinds, each named after the profile so that no two bundles can claim
one object. This script holds every bundle to the same rules, so that what is
refused there is refused here first.

The digest is the sha256 of the bundle file AS PUBLISHED, companions and all.
It has to be taken here, on the assembled file, because that is the byte
sequence a director fetches and hashes. The assembly is deterministic --
profile.yaml unchanged, then the companions by kind and name, each source file
unchanged -- so the same tree always gives the same digest.

The format is the contract, and its reader is the authority:
gentian-os ``internal/director/catalogue/index.go`` for the index and
``internal/profilebundle/bundle.go`` for a bundle. gentian-os also ships
``scripts/tools/build-catalogue-index.py``, which indexes a catalogue
directory somebody else assembled — it does not know about this repository's
bundle layout, which is why the flattening lives here.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
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


# ── Bundles ──────────────────────────────────────────────────────────────────
#
# The rules below are the cluster's, restated: gentian-os
# internal/profilebundle/bundle.go is the authority, and a bundle that passes
# here and fails there is a bug in this copy. gentian-os tests the bundles
# this script builds against its own checks.

# The largest bundle a cluster carries: it rides on the profile as an
# annotation, base64, and an object's annotations may total 256 KiB.
MAX_BUNDLE = 180 << 10

PROFILE_LABEL = "gentianos.io/profile-name"
ASSET_LABEL = "gentianos.io/asset"

# The companion kinds, in the order they are written.
COMPOSITION = ("apiextensions.crossplane.io/v1", "Composition")
CONFIGMAP = ("v1", "ConfigMap")
CUSTOMIZATION = ("gentianos.io/v1alpha1", "Customization")
OIDC_PACKS = ("gentianos.io/v1alpha1", "OIDCPackCatalog")
COMPANION_KINDS = (COMPOSITION, CONFIGMAP, CUSTOMIZATION, OIDC_PACKS)

DNS_LABEL = re.compile(r"^[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$")

# What a bundle's kustomization.yaml may say. It is read here, not run: the
# published profile has to be profile.yaml's own bytes, and kustomize would
# re-serialise it.
KUSTOMIZATION_KEYS = {"apiVersion", "kind", "resources", "configMapGenerator", "generatorOptions"}


def scalar(value: str) -> str:
    """A string as a YAML scalar that reads back as exactly that string.

    JSON's quoting, which YAML reads, rather than a YAML library's: what a
    library emits changes with its version, and these bytes are hashed.
    """
    return json.dumps(value, ensure_ascii=False)


def render_configmap(name: str, labels: dict, data: dict) -> str:
    out = ["apiVersion: v1", "kind: ConfigMap", "metadata:", f"  name: {scalar(name)}", "  labels:"]
    out += [f"    {scalar(k)}: {scalar(v)}" for k, v in sorted(labels.items())]
    out.append("data:")
    out += [f"  {scalar(k)}: {scalar(v)}" for k, v in sorted(data.items())]
    return "\n".join(out) + "\n"


def strings_at(value, keys: tuple) -> set:
    """Every string found under one of keys, anywhere in value."""
    found: set = set()
    if isinstance(value, dict):
        for k, v in value.items():
            if k in keys and isinstance(v, str) and v:
                found.add(v)
            found |= strings_at(v, keys)
    elif isinstance(value, list):
        for v in value:
            found |= strings_at(v, keys)
    return found


def check_companion(profile_name: str, profile: dict, doc: dict) -> list:
    """Why a companion may not travel with this profile; empty when it may."""
    gvk = (doc.get("apiVersion"), doc.get("kind"))
    if gvk not in COMPANION_KINDS:
        return [f"a {doc.get('kind')!r} ({doc.get('apiVersion')}) is not a kind a bundle may hold"]
    meta = doc.get("metadata") or {}
    name = str(meta.get("name") or "")
    what = f"{gvk[1]} {name!r}"
    problems = []

    body = {"data"} if gvk == CONFIGMAP else {"spec"}
    extra = set(doc) - {"apiVersion", "kind", "metadata"} - body
    if extra:
        problems.append(f"{what} states {', '.join(sorted(extra))}, which a companion may not")
    extra = set(meta) - {"name", "labels"}
    if extra:
        problems.append(
            f"{what} states metadata.{', metadata.'.join(sorted(extra))}; "
            "a companion states its name and labels and nothing else, no namespace"
        )

    labels = meta.get("labels") or {}
    wanted = {PROFILE_LABEL: profile_name}
    spec = doc.get("spec") or {}
    if gvk == COMPOSITION:
        if name != f"app-{profile_name}":
            problems.append(f"{what} must be named app-{profile_name}")
        ref = spec.get("compositeTypeRef") or {}
        if (ref.get("apiVersion"), ref.get("kind")) != ("gentianos.io/v1alpha1", "XApp"):
            problems.append(f"{what} composes {ref.get('kind')!r}, and a bundle's Composition composes XApp only")
        stated = ((profile.get("spec") or {}).get("package") or {}).get("composition")
        if stated != name:
            problems.append(f"{what} is not the composition the profile names (spec.package.composition: {stated!r})")
    elif gvk == OIDC_PACKS:
        if name != f"{profile_name}-oidc":
            problems.append(f"{what} must be named {profile_name}-oidc")
        clients = strings_at(profile.get("spec") or {}, ("clientId", "oidcPackRef"))
        for key, pack in sorted((spec.get("packs") or {}).items()):
            if key not in clients:
                problems.append(f"{what} holds a pack for {key!r}, which is not a client this profile declares")
            if (pack or {}).get("serviceClient"):
                problems.append(f"{what}: pack {key!r} is a serviceClient, which is the platform's to declare")
    elif gvk == CONFIGMAP:
        asset = str(labels.get(ASSET_LABEL) or "")
        if not DNS_LABEL.match(asset):
            problems.append(f"{what} needs the label {ASSET_LABEL}, a short lower-case name")
        wanted[ASSET_LABEL] = asset
        if name != f"{profile_name}.{asset}":
            problems.append(f"{what} must be named {profile_name}.{asset}")
        data = doc.get("data") or {}
        if not all(isinstance(v, str) for v in data.values()):
            problems.append(f"{what}: every value under data is a string")
    elif gvk == CUSTOMIZATION:
        prefix, _, record = name.partition(".")
        if prefix != profile_name or not DNS_LABEL.match(record):
            problems.append(f"{what} must be named {profile_name}.<record>")
        if (spec.get("target") or {}).get("profile") != profile_name:
            problems.append(f"{what} must target this profile (spec.target.profile)")
        if spec.get("scope") != "profile":
            problems.append(f"{what} must have scope: profile; a record of another scope is not a profile's to carry")
    if labels != wanted:
        said = ", ".join(f"{k}: {v}" for k, v in sorted(wanted.items()))
        problems.append(f"{what} must carry exactly these labels: {said}")
    return problems


def companions(directory: Path, profile_name: str, profile: dict) -> tuple:
    """The companions a bundle's kustomization.yaml lists, as (kind, name, text)."""
    listing = directory / "kustomization.yaml"
    if not listing.exists():
        return [], []
    try:
        k = load(listing)
    except yaml.YAMLError as exc:
        return [], [f"kustomization.yaml does not parse: {exc}"]
    problems = []
    unknown = set(k) - KUSTOMIZATION_KEYS
    if unknown:
        problems.append(
            f"kustomization.yaml uses {', '.join(sorted(unknown))}; a bundle is assembled from "
            "resources and configMapGenerator only"
        )
    found = []
    for entry in k.get("resources") or []:
        if entry == "profile.yaml":
            continue
        source = directory / str(entry)
        if ".." in Path(str(entry)).parts or not source.is_file():
            problems.append(f"resource {entry!r} is not a file of this bundle")
            continue
        text = source.read_text()
        try:
            docs = [d for d in yaml.safe_load_all(text) if d is not None]
        except yaml.YAMLError as exc:
            problems.append(f"{entry} does not parse: {exc}")
            continue
        if len(docs) != 1 or not isinstance(docs[0], dict):
            problems.append(f"{entry} holds {len(docs)} documents; a companion's source is one object a file")
            continue
        # The file as it is, comments and all. Only a leading document
        # marker goes: the separator is written between companions here.
        lines = text.splitlines(keepends=True)
        while lines and lines[0].strip() in ("---", ""):
            lines.pop(0)
        text = "".join(lines)
        found.append((docs[0], text if text.endswith("\n") else text + "\n"))

    options = k.get("generatorOptions") or {}
    labels = {str(a): str(b) for a, b in (options.get("labels") or {}).items()}
    for gen in k.get("configMapGenerator") or []:
        unknown = set(gen) - {"name", "files"}
        if unknown:
            problems.append(
                f"configMapGenerator {gen.get('name')!r} uses {', '.join(sorted(unknown))}; "
                "it states a name and files, and no namespace"
            )
            continue
        data = {}
        for item in gen.get("files") or []:
            key, sep, rel = str(item).partition("=")
            if not sep:
                key, rel = Path(key).name, key
            source = directory / rel
            if ".." in Path(rel).parts or not source.is_file():
                problems.append(f"configMapGenerator {gen.get('name')!r}: {rel!r} is not a file of this bundle")
                continue
            try:
                data[key] = source.read_text(encoding="utf-8")
            except UnicodeDecodeError:
                problems.append(f"configMapGenerator {gen.get('name')!r}: {rel} is not text")
        text = render_configmap(str(gen.get("name") or ""), labels, data)
        found.append((yaml.safe_load(text), text))

    out = []
    for doc, text in found:
        problems += check_companion(profile_name, profile, doc)
        out.append((doc.get("kind") or "", (doc.get("metadata") or {}).get("name") or "", doc, text))
    names = [(kind, name) for kind, name, _, _ in out]
    for pair in sorted({p for p in names if names.count(p) > 1}):
        problems.append(f"{pair[0]} {pair[1]!r} is listed twice")
    # By kind and name, so the bytes do not depend on the order of a list
    # somebody edited.
    out.sort(key=lambda c: (c[0], c[1]))
    return out, problems


def assemble(directory: Path, profile_name: str, profile: dict) -> tuple:
    """A profile's published bundle, and why it cannot be published."""
    body = (directory / "profile.yaml").read_bytes()
    found, problems = companions(directory, profile_name, profile)
    meta = profile.get("metadata") or {}
    for key in list(meta.get("annotations") or {}) + list(meta.get("labels") or {}):
        if str(key).startswith("argocd.argoproj.io/"):
            problems.append(f"the profile states {key}, which is not a catalogue's to set")
    stated = (meta.get("labels") or {}).get(PROFILE_LABEL)
    if stated not in (None, profile_name):
        problems.append(f"the profile carries the label {PROFILE_LABEL}: {stated}, which is another profile's name")
    if found:
        if len(list(yaml.safe_load_all(body))) != 1:
            problems.append("profile.yaml holds more than one document")
        if not body.endswith(b"\n"):
            body += b"\n"
        for _, _, _, text in found:
            body += b"---\n" + text.encode()
    if len(body) > MAX_BUNDLE:
        problems.append(f"the bundle is {len(body)} bytes and a cluster carries at most {MAX_BUNDLE}")
    return body, [(kind, name, doc) for kind, name, doc, _ in found], problems


def build(out: Path) -> tuple[list[dict], list[str]]:
    profiles_dir = out / "profiles"
    listings_dir = out / "listings"
    packages_dir = out / "packages"
    for d in (profiles_dir, listings_dir, packages_dir):
        d.mkdir(parents=True, exist_ok=True)

    # Presets: a named selection of one family's add-ons. Not installable and
    # not in the index -- a director never materialises one. Published because
    # the App Store offers them in a base's add-on window, and the store runs
    # outside the cluster: what it is to show has to be where it can read it.
    for preset in sorted(REPO.glob("profiles/**/packages/*.yaml")):
        if preset.name == "kustomization.yaml":
            continue
        try:
            doc = load(preset)
        except yaml.YAMLError:
            continue
        name = (doc.get("metadata") or {}).get("name")
        if doc.get("kind") == "AppPackage" and name:
            shutil.copyfile(preset, packages_dir / f"{name}.yaml")

    entries: list[dict] = []
    complaints: list[str] = []
    seen: dict[str, Path] = {}
    claimed: dict[tuple, str] = {}

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

        body, held, problems = assemble(directory, name, profile)
        # One object, one bundle, across the catalogue. The names make that
        # so for the objects; a pack is found by its client's id, which two
        # profiles could both declare.
        for kind, companion, doc in held:
            claims = [(kind, companion)]
            if kind == "OIDCPackCatalog":
                claims += [("OIDC pack", key) for key in ((doc.get("spec") or {}).get("packs") or {})]
            for claim in claims:
                if claim in claimed and claimed[claim] != name:
                    problems.append(f"{claim[0]} {claim[1]!r} is also in the bundle of {claimed[claim]}")
                claimed.setdefault(claim, name)
        if problems:
            complaints += [f"{name}: {problem}" for problem in problems]
            continue

        published = profiles_dir / f"{name}.yaml"
        published.write_bytes(body)
        if listing_path.exists():
            shutil.copyfile(listing_path, listings_dir / f"{name}.yaml")

        entry = {
            "name": name,
            "version": str(spec.get("version") or "0.0.0"),
            "edition": edition,
            # Taken on the published file, which is the one a director
            # fetches: the profile and its companions, one fingerprint.
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
 <li><code>profiles/&lt;name&gt;.yaml</code> — the profile's bundle: the ComponentProfile and what travels with it</li>
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
