#!/usr/bin/env python3
"""Check that every image a profile names exists, and that an image built here
is asked for at the tag this repository builds.

Each images/<name>/versions.env pins an IMAGE_TAG, and CI pushes
ghcr.io/gentian-org/<name>:$IMAGE_TAG. A profile naming any other tag either
pulls a stale image or fails to pull at all — and a stale one is worse, because
everything reports healthy while the container is simply the wrong build. That
is what happened to Nextcloud: collapsing four bundle images into one left the
profile asking for the old "33.0.6-base-gentian5", so no addon could be enabled.
And a profile renamed to its edition (xwiki -> xwiki-ce) asked for
ghcr.io/gentian-org/xwiki-ce, which nothing builds.

Where a profile names images:

  spec.package.extraValues, spec.extensions[].extraValues
      any `image` value, at any depth: a full reference as a string, or a map
      in one of the shapes charts use — {name, tag} (name is the full
      reference: XWiki), {repository, tag} (repository carries the registry),
      {registry, repository, tag}. A map that leaves the repository to the
      chart ({tag: ...} alone: Open WebUI) is completed from the chart's own
      values.yaml at the same path.
  anywhere else in spec (hooks, provisioning Jobs, ...)
      any `image` string. spec.expose[].tile.image is a picture, not an image.

What is checked:

  ghcr.io/gentian-org/<name>   CI must build <name> (a ref in
      .github/workflows/apps-ci.yaml). If images/<name>/versions.env pins an
      IMAGE_TAG, the tag must be it. Otherwise the registry must hold the tag.
  any other image              the registry must hold a manifest for it, asked
      anonymously as a cluster without pull secrets would. Docker Hub, which
      answers an unknown repository with 401, is asked through its own API.

A definite "not there" fails. A registry that cannot be reached, rate-limits,
or wants credentials before it says anything is a warning: an outage must not
fail a pull request, and a private registry cannot be checked without its
credentials. VALIDATE_OFFLINE=1 skips the network.
"""

from __future__ import annotations

import pathlib
import re
import sys

import yaml

from _artefacts import FOUND, MISSING, OFFLINE, chart_uses, helm_chart_values, image_exists, parse_image

REPO = pathlib.Path(__file__).resolve().parent.parent
OWN = "ghcr.io/gentian-org/"
WORKFLOW = REPO / ".github/workflows/apps-ci.yaml"


def built_tags() -> dict[str, str]:
    """image name -> IMAGE_TAG, for every images/<name>/versions.env."""
    tags: dict[str, str] = {}
    for env in REPO.glob("images/*/versions.env"):
        for line in env.read_text().splitlines():
            line = line.strip()
            if line.startswith("IMAGE_TAG="):
                tags[env.parent.name] = line.split("=", 1)[1].strip().strip("\"'")
    return tags


def images_ci_builds() -> set[str]:
    """Every <name> CI pushes as ${REGISTRY}/${IMAGE_ORG}/<name>:<tag>."""
    text = WORKFLOW.read_text()
    return set(re.findall(r"\$\{\{\s*env\.IMAGE_ORG\s*\}\}/([a-z0-9][a-z0-9._/-]*):", text))


def local_chart_values(name: str) -> dict | None:
    for pattern in ("charts/*/Chart.yaml", "images/*/chart/Chart.yaml", "apps/*/chart/Chart.yaml"):
        for path in REPO.glob(pattern):
            if (yaml.safe_load(path.read_text()) or {}).get("name") == name:
                values = path.parent / "values.yaml"
                return (yaml.safe_load(values.read_text()) or {}) if values.exists() else None
    return None


def compose(image: dict) -> str | None:
    """A full reference from a chart-style image map, or None if it has none."""
    tag = image.get("tag")
    digest = image.get("digest")
    if image.get("name"):
        base = str(image["name"])
    elif image.get("repository"):
        base = str(image["repository"])
        registry = str(image.get("registry") or "")
        if registry and not base.startswith(registry.rstrip("/") + "/"):
            base = f"{registry.rstrip('/')}/{base}"
    else:
        return None
    if digest:
        return f"{base}@{digest}"
    if tag in (None, ""):
        return None
    return f"{base}:{tag}"


def at_path(tree, path: list[str]):
    for key in path:
        if not isinstance(tree, dict) or key not in tree:
            return None
        tree = tree[key]
    return tree


def values_images(values, path: list[str], defaults_for):
    """(where, reference or None, why) for every image in a values tree."""
    if isinstance(values, dict):
        for key, value in values.items():
            here = path + [str(key)]
            if key == "image" and isinstance(value, str):
                yield ".".join(here), value, ""
            elif key == "image" and isinstance(value, dict):
                ref = compose(value)
                if ref is None and not (value.get("name") or value.get("repository")):
                    default = at_path(defaults_for(), here)
                    if isinstance(default, dict):
                        ref = compose({**default, **value})
                yield ".".join(here), ref, "the chart chooses the repository or tag" if ref is None else ""
            else:
                yield from values_images(value, here, defaults_for)
    elif isinstance(values, list):
        for i, value in enumerate(values):
            yield from values_images(value, path + [str(i)], defaults_for)


def other_images(node, path: list[str]):
    """`image` strings outside the chart values, skipping tiles."""
    if isinstance(node, dict):
        for key, value in node.items():
            if key == "tile":
                continue
            here = path + [str(key)]
            if key == "image" and isinstance(value, str):
                yield ".".join(here), value
            else:
                yield from other_images(value, here)
    elif isinstance(node, list):
        for i, value in enumerate(node):
            yield from other_images(value, path + [f"[{i}]"])


def profile_images(spec: dict):
    for where, chart, extra in chart_uses(spec):
        prefix = where.rsplit(".chart", 1)[0] + ".extraValues"
        cache: dict = {}

        def defaults_for(chart=chart, cache=cache):
            if "v" not in cache:
                name = str(chart.get("name") or "")
                repo = str(chart.get("repository") or "").rstrip("/")
                cache["v"] = (local_chart_values(name) if repo == "oci://ghcr.io/gentian-org/charts" else None) or (
                    helm_chart_values(repo, name, str(chart.get("version") or "")) or {}
                )
            return cache["v"]

        for sub, ref, why in values_images(extra, [], defaults_for):
            yield f"{prefix}.{sub}", ref, why
    rest = {k: v for k, v in spec.items() if k not in ("package", "extensions")}
    rest["package"] = {k: v for k, v in (spec.get("package") or {}).items() if k != "extraValues"}
    rest["extensions"] = [
        {k: v for k, v in e.items() if k != "extraValues"} if isinstance(e, dict) else e
        for e in spec.get("extensions") or []
    ]
    for where, ref in other_images(rest, ["spec"]):
        yield where, ref, ""


def main() -> int:
    tags = built_tags()
    built = images_ci_builds()
    errors: list[str] = []
    warnings: list[str] = []
    checked = 0
    seen: dict[str, object] = {}

    for path in sorted(REPO.glob("profiles/**/profile.yaml")):
        doc = yaml.safe_load(path.read_text()) or {}
        rel = path.relative_to(REPO)
        for where, ref_text, why in profile_images(doc.get("spec") or {}):
            at = f"{rel}: {where}"
            if ref_text is None:
                warnings.append(f"{at}: not checked, {why}")
                continue
            ref = parse_image(ref_text)
            if ref is None:
                warnings.append(f"{at}: not checked, {ref_text!r} is filled in at install time")
                continue
            checked += 1
            full = f"{ref.registry}/{ref.repository}"

            if full.startswith(OWN):
                name = full[len(OWN) :]
                if name not in built:
                    errors.append(
                        f"{at} asks for {ref_text}, but CI builds no image {OWN}{name}. "
                        f"Built: {', '.join(sorted(built))}"
                    )
                    continue
                if name in tags:
                    if ref.reference != tags[name]:
                        errors.append(
                            f"{at} asks for {ref_text}, but images/{name}/versions.env builds "
                            f"IMAGE_TAG={tags[name]}. The tenant would run a different build than "
                            f"the one this repo produces."
                        )
                    continue

            key = f"{full}:{ref.reference}"
            if key not in seen:
                seen[key] = image_exists(ref, owned=full.startswith(OWN))
            answer = seen[key]
            if answer.state == MISSING:
                errors.append(f"{at} asks for {ref_text}, which does not exist: {answer.detail}")
            elif answer.state != FOUND:
                warnings.append(f"{at}: could not confirm {ref_text}: {answer.detail}")

    for warning in warnings:
        print(f"::warning::{warning}" if not OFFLINE else f"warning: {warning}")
    if errors:
        print("Image reference errors:\n")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(
        f"Checked {checked} image reference(s): every one exists, and every image built here is "
        f"asked for at the tag it is built with"
        + (f" ({len(warnings)} not confirmed, see warnings)" if warnings else "")
        + "."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
