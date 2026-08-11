#!/usr/bin/env python3
"""Check that every profile's spec.chart.name refers to a chart that exists.

A profile that names a chart nobody publishes installs fine in review and fails
only when a tenant clicks Install, because the Helm release is what resolves the
reference. That is far too late to learn about a typo.

This catches the specific failure that motivated the check: renaming a profile
directory to carry an edition suffix (app-store -> app-store-me) and letting the
substitution run through spec.chart.name as well. The chart is still published as
`app-store`; only the catalogue entry moved. It is the same rule as elsewhere in
this repo — a profile references its chart by OCI coordinate, and that coordinate
is not derived from the profile's own name.

Only charts under oci://ghcr.io/gentian-org/charts are checked: those are the ones
this repo builds and can therefore verify offline. Third-party repositories are
left to the install path.
"""

from __future__ import annotations

import pathlib
import sys

import yaml

REPO = pathlib.Path(__file__).resolve().parent.parent
OWN_REGISTRY = "oci://ghcr.io/gentian-org/charts"


def charts_this_repo_builds() -> dict[str, pathlib.Path]:
    """Chart name -> path, for every chart built here.

    Two layouts count. A vendored or Gentian-authored chart carries its own
    Chart.yaml and the name comes from it. A patched upstream chart (charts/
    activepieces) has no Chart.yaml at all — it is an UPSTREAM pin plus a patch
    series, fetched and patched at build time — and the build script packages it
    under the directory name.
    """
    found: dict[str, pathlib.Path] = {}
    for pattern in ("apps/*/chart/Chart.yaml", "charts/*/Chart.yaml"):
        for path in REPO.glob(pattern):
            data = yaml.safe_load(path.read_text()) or {}
            name = data.get("name")
            if name:
                found[name] = path
    for upstream in REPO.glob("charts/*/UPSTREAM"):
        found.setdefault(upstream.parent.name, upstream)
    return found


def main() -> int:
    built = charts_this_repo_builds()
    errors: list[str] = []

    for path in sorted(REPO.glob("profiles/**/profile.yaml")):
        doc = yaml.safe_load(path.read_text()) or {}
        spec = doc.get("spec") or {}
        chart = spec.get("chart")
        if not chart:
            continue
        if (chart.get("repository") or "").rstrip("/") != OWN_REGISTRY:
            continue
        name = chart.get("name")
        if name not in built:
            rel = path.relative_to(REPO)
            profile = (doc.get("metadata") or {}).get("name", rel)
            errors.append(
                f"{rel}: profile {profile!r} references chart {name!r} from "
                f"{OWN_REGISTRY}, but this repo builds no such chart. "
                f"Available: {', '.join(sorted(built))}"
            )

    if errors:
        print("Chart reference errors:\n")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(f"Checked chart references against {len(built)} locally built chart(s). All resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
