#!/usr/bin/env python3
"""Check that profiles request the image tag CI actually builds.

Each images/<name>/versions.env pins an IMAGE_TAG, and CI pushes
ghcr.io/gentian-org/<name>:$IMAGE_TAG. A profile naming any other tag either
pulls a stale image or fails to pull at all — and a stale one is worse, because
everything reports healthy while the container is simply the wrong build.

That is exactly what happened to Nextcloud. The old multi-target build tagged
per bundle (33.0.6-base-gentian5, -office-, -officeplus-, -suite-). Collapsing to
a single image left the profile still asking for "33.0.6-base-gentian5", so the
tenant ran the pre-conversion image: no addons staged in custom_apps, and
therefore no addon could ever be enabled.

Only images built in this repo are checked; upstream images are out of scope.
"""

from __future__ import annotations

import pathlib
import sys

import yaml

REPO = pathlib.Path(__file__).resolve().parent.parent
ORG = "gentian-org"


def built_tags() -> dict[str, str]:
    """image name -> IMAGE_TAG, for every images/<name>/versions.env."""
    tags: dict[str, str] = {}
    for env in REPO.glob("images/*/versions.env"):
        for line in env.read_text().splitlines():
            line = line.strip()
            if line.startswith("IMAGE_TAG="):
                tags[env.parent.name] = line.split("=", 1)[1].strip().strip("\"'")
    return tags


def main() -> int:
    tags = built_tags()
    errors: list[str] = []
    checked = 0

    for path in sorted(REPO.glob("profiles/**/profile.yaml")):
        doc = yaml.safe_load(path.read_text()) or {}
        spec = doc.get("spec") or {}
        image = (spec.get("extraValues") or {}).get("image") or {}
        repo, tag = image.get("repository"), image.get("tag")
        if not repo or not tag:
            continue

        prefix = f"{ORG}/"
        if not str(repo).startswith(prefix):
            continue
        name = str(repo)[len(prefix):]
        if name not in tags:
            continue

        checked += 1
        if str(tag) != tags[name]:
            errors.append(
                f"{path.relative_to(REPO)}: profile "
                f"{(doc.get('metadata') or {}).get('name')!r} requests "
                f"{repo}:{tag}, but images/{name}/versions.env builds "
                f"IMAGE_TAG={tags[name]}. The tenant would run a different build "
                f"than the one this repo produces."
            )

    if errors:
        print("Image tag errors:\n")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(f"Checked {checked} first-party image reference(s). All match versions.env.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
