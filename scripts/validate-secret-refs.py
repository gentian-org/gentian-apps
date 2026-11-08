#!/usr/bin/env python3
"""Check that profiles reference object names the composition actually creates.

The compositions name the ESO-managed Secret after the App claim, which is the
profile's metadata.name: `<profile>-sensitive-values`. A profile that hardcodes a
different name renders a Deployment whose envFrom points at a Secret nobody
creates, and the pod sits in CreateContainerConfigError forever.

This is not hypothetical. Renaming the singleton profiles to carry an edition
suffix (xwiki -> xwiki-ce, ...) left four profiles
pointing at their pre-rename Secret names. Only one was installed, so only one
broke visibly; the other three were waiting to fail on next install.

Sidecar secrets are exempt: they are named `<parent>-<sidecar>-sensitive-values`,
so any name that starts with the profile name is accepted.
"""

from __future__ import annotations

import pathlib
import re
import sys

import yaml

REPO = pathlib.Path(__file__).resolve().parent.parent
SECRET_RE = re.compile(r"([a-z0-9][a-z0-9-]*)-sensitive-values")


def check_ingress_service_name(path: pathlib.Path, doc: dict) -> list[str]:
    """spec.ingress.serviceName must start with the profile name.

    app-default builds the alias Service's pod selector by trimming "<profile>-"
    off this value to get a component label. When the value does not start with
    that prefix, trimPrefix is a no-op and the selector becomes the whole service
    name — which is never a component label, so the Service gets no endpoints and
    the route 500s. The failure is invisible in Argo CD: the Service exists and the
    Application is Healthy.

    Skipped when the chart already creates a Service of that name
    (fullnameOverride == serviceName), because then no alias is emitted at all.
    """
    meta, spec = doc.get("metadata") or {}, doc.get("spec") or {}
    if spec.get("compositionRef"):
        # The old signal for "rendered by its own composition". AD-4 deletes
        # the field -- the composition is chosen by the claim now -- so the
        # sibling composition.yaml is what says it. Kept for an unconverted
        # profile.
        return []
    svc = (spec.get("ingress") or {}).get("serviceName")
    if not svc:
        return []
    if svc == (spec.get("extraValues") or {}).get("fullnameOverride"):
        return []

    name = meta.get("name")
    if svc.startswith(f"{name}-"):
        return []
    return [
        f"{path}: spec.ingress.serviceName {svc!r} does not start with "
        f"'{name}-', so the alias Service's selector resolves to "
        f"component={svc!r} and will match no pods. Use '{name}-<component>', "
        f"or set extraValues.fullnameOverride to {svc!r} so the chart owns it."
    ]


def main() -> int:
    errors: list[str] = []
    checked = 0

    for path in sorted(REPO.glob("profiles/**/profile.yaml")):
        raw = path.read_text()
        doc = yaml.safe_load(raw) or {}
        name = (doc.get("metadata") or {}).get("name")
        if not name:
            continue

        for referenced in sorted(set(SECRET_RE.findall(raw))):
            checked += 1
            # Exact match, or a sidecar secret prefixed with the profile name.
            if referenced == name or referenced.startswith(f"{name}-"):
                continue
            errors.append(
                f"{path.relative_to(REPO)}: profile {name!r} references "
                f"{referenced}-sensitive-values, but the composition creates "
                f"{name}-sensitive-values. A pod using it would never start."
            )

        errors.extend(check_ingress_service_name(path.relative_to(REPO), doc))

    if errors:
        print("Reference errors:\n")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(f"Checked {checked} secret reference(s) and all gateway backends. All resolve.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
