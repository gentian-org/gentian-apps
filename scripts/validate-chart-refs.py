#!/usr/bin/env python3
"""Check that every chart a profile names exists, under that name and version.

A profile that names a chart nobody publishes passes review and fails only when
a tenant clicks Install, because the Helm release is what resolves the
reference. That is far too late to learn about a typo.

This catches the failure that motivated the check: renaming a profile to carry
an edition suffix (xwiki -> xwiki-ce) and letting the substitution run through
the chart's name as well. The chart is still published as `xwiki`; only the
catalog entry moved. A profile references its chart by coordinate, and that
coordinate is not derived from the profile's own name.

Read: spec.package.chart and spec.extensions[].chart, each {repository, name,
version}.

  oci://ghcr.io/gentian-org/charts   a chart this repository builds. Its name
      must be the `name` of a Chart.yaml here (charts/*, images/*/chart,
      apps/*/chart) or a charts/<name>/UPSTREAM pin. Its version must be that
      Chart.yaml's (or UPSTREAM's CHART_VERSION) — what this commit publishes
      when released — or one the registry already holds: a released version a
      profile on develop still pins after the chart moved on, or a
      <version>-develop.<sha7> build (docs/releasing.md).
  any other oci:// repository         the registry must hold name:version.
  https:// repository                 its index.yaml must list name at version.

A definite "not there" fails. A repository that cannot be reached, or that
wants credentials before it answers, is a warning: an outage must not fail a
pull request. VALIDATE_OFFLINE=1 skips the network and checks only what this
repository can answer by itself.
"""

from __future__ import annotations

import pathlib
import sys

import yaml

from _artefacts import FOUND, MISSING, OFFLINE, helm_chart, oci_chart

REPO = pathlib.Path(__file__).resolve().parent.parent
OWN_REGISTRY = "oci://ghcr.io/gentian-org/charts"


def charts_this_repo_builds() -> dict[str, tuple[str, pathlib.Path]]:
    """Chart name -> (version it is released under, path), for every chart built here.

    Two layouts count. A vendored or Gentian-authored chart carries its own
    Chart.yaml. A patched upstream chart (charts/activepieces) has none — it is
    an UPSTREAM pin plus a patch series, fetched and patched at build time —
    and is released as CHART_VERSION under the directory name.
    """
    found: dict[str, tuple[str, pathlib.Path]] = {}
    for pattern in ("charts/*/Chart.yaml", "images/*/chart/Chart.yaml", "apps/*/chart/Chart.yaml"):
        for path in REPO.glob(pattern):
            data = yaml.safe_load(path.read_text()) or {}
            if data.get("name"):
                found[data["name"]] = (str(data.get("version", "")), path)
    for upstream in REPO.glob("charts/*/UPSTREAM"):
        version = ""
        for line in upstream.read_text().splitlines():
            if line.strip().startswith("CHART_VERSION="):
                version = line.split("=", 1)[1].strip().strip("\"'")
        found.setdefault(upstream.parent.name, (version, upstream))
    return found


def main() -> int:
    built = charts_this_repo_builds()
    errors: list[str] = []
    warnings: list[str] = []
    checked = 0

    for path in sorted(REPO.glob("profiles/**/profile.yaml")):
        doc = yaml.safe_load(path.read_text()) or {}
        spec = doc.get("spec") or {}
        rel = path.relative_to(REPO)
        uses = []
        package = spec.get("package") or {}
        if isinstance(package.get("chart"), dict):
            uses.append(("spec.package.chart", package["chart"]))
        for i, ext in enumerate(spec.get("extensions") or []):
            if isinstance(ext, dict) and isinstance(ext.get("chart"), dict):
                uses.append((f"spec.extensions[{i}].chart", ext["chart"]))

        for where, chart in uses:
            repository = str(chart.get("repository") or "").rstrip("/")
            name = str(chart.get("name") or "")
            version = str(chart.get("version") or "")
            at = f"{rel}: {where}"
            if not repository or not name or not version:
                errors.append(f"{at} must name repository, name and version (has {chart})")
                continue
            checked += 1

            if repository == OWN_REGISTRY:
                if name not in built:
                    errors.append(
                        f"{at} names chart {name!r} from {OWN_REGISTRY}, but this repo builds no such "
                        f"chart. Built here: {', '.join(sorted(built))}"
                    )
                    continue
                released, source = built[name]
                if version == released:
                    continue
                answer = oci_chart(repository, name, version, owned=True)
                if answer.state == FOUND:
                    continue
                if answer.state == MISSING:
                    errors.append(
                        f"{at} pins {name} {version}: {source.relative_to(REPO)} releases {released}, "
                        f"and the registry does not hold {version} ({answer.detail})"
                    )
                else:
                    warnings.append(
                        f"{at} pins {name} {version}, not the {released} of {source.relative_to(REPO)}, "
                        f"and the registry could not be asked: {answer.detail}"
                    )
                continue

            if repository.startswith("oci://"):
                answer = oci_chart(repository, name, version)
            elif repository.startswith(("https://", "http://")):
                answer = helm_chart(repository, name, version)
            else:
                errors.append(f"{at} names repository {repository!r}, neither oci:// nor https://")
                continue
            if answer.state == MISSING:
                errors.append(f"{at} names chart {name} {version}, which does not exist: {answer.detail}")
            elif answer.state != FOUND:
                warnings.append(f"{at}: could not confirm {repository} {name} {version}: {answer.detail}")

    for warning in warnings:
        print(f"::warning::{warning}" if not OFFLINE else f"warning: {warning}")
    if errors:
        print("Chart reference errors:\n")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(
        f"Checked {checked} chart reference(s): every one exists"
        + (f" ({len(warnings)} could not be confirmed, see warnings)" if warnings else "")
        + "."
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
