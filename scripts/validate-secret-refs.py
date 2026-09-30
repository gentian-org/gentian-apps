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

import json
import pathlib
import re
import sys

import yaml

REPO = pathlib.Path(__file__).resolve().parent.parent
SECRET_RE = re.compile(r"([a-z0-9][a-z0-9-]*)-sensitive-values")


def _composition_services(composition: pathlib.Path) -> set[str]:
    """Service names a profile's own composition creates.

    A regex rather than a YAML parser on purpose: the file is a Go template
    and the manifests inside it are not valid YAML until rendered. A literal
    `name:` two lines under `kind: Service` is what this is after, which is
    how every one of them is written.
    """
    if not composition.is_file():
        return set()
    pattern = re.compile(
        r"kind:\s*Service\s*\n\s*metadata:\s*\n\s*name:\s*([a-z0-9][a-z0-9.-]*)\s*\n")
    return set(pattern.findall(composition.read_text(encoding="utf-8")))


def check_gateway_backends(path: pathlib.Path, doc: dict) -> list[str]:
    """Gateway backends must name a Service something actually creates.

    Only profiles on app-default are checked. There the stable API alias name is
    fixed as `<profile>-api`, and the only other alias is spec.ingress.serviceName,
    which the composition creates verbatim. A profile with its own compositionRef
    defines its own Service names — openproject-ce creates `openproject-portal-bridge`
    literally — so guessing at those would produce false positives.

    app-default also emits a stable ClusterIP alias for any sidecar declaring
    `stableServiceName` (see its "Emit sidecars" step), which is the only way to
    address a sidecar by a fixed name — its own Helm release name is generated.
    Those count as created Services too; without this, routing to a sidecar the
    supported way is reported as a dangling backend.
    """
    meta, spec = doc.get("metadata") or {}, doc.get("spec") or {}
    if spec.get("compositionRef"):
        # The old signal for "rendered by its own composition". AD-4 deletes
        # the field -- the composition is chosen by the claim now -- so the
        # sibling composition.yaml is what says it. Kept for an unconverted
        # profile.
        return []
    raw = (meta.get("annotations") or {}).get("gentianos.io/gateway-api-backends")
    if not raw:
        return []

    name = meta.get("name")
    try:
        backends = json.loads(raw)
    except json.JSONDecodeError as exc:
        return [f"{path}: gateway-api-backends is not valid JSON: {exc}"]

    # Where a Service the platform actually creates can be named.
    #
    # Read from ComponentProfile's shape: spec.ingress became one entry of
    # spec.expose, each naming its own backend, and spec.sidecars became
    # spec.extensions. Both spellings are accepted while the catalogue is
    # converted -- a validator that only knew the new shape would report every
    # unconverted profile as broken, which is noise rather than a finding.
    allowed = {f"{name}-api"}
    for exposure in spec.get("expose") or []:
        service = ((exposure or {}).get("backend") or {}).get("service")
        if service:
            allowed.add(service)
    for extension in (spec.get("extensions") or []) + (spec.get("sidecars") or []):
        if (extension or {}).get("stableServiceName"):
            allowed.add(extension["stableServiceName"])
    if (spec.get("ingress") or {}).get("serviceName"):
        allowed.add(spec["ingress"]["serviceName"])

    # A profile with its own composition creates its own Services, and only
    # that composition knows their names. openproject-ce is the case: it emits
    # a Deployment and a Service for the portal bridge, and its two gateway
    # backends point at that Service.
    #
    # Scanned rather than skipped. Skipping is what spec.compositionRef did,
    # and it turned the whole check off for the three profiles most likely to
    # get a backend wrong; reading the Service names out of the composition
    # keeps the question being asked.
    allowed |= _composition_services(REPO / path.parent / "composition.yaml")

    errors = []
    for backend in backends:
        svc = backend.get("serviceName")
        if svc and svc not in allowed:
            errors.append(
                f"{path}: gateway backend {backend.get('pathPrefix')!r} points at "
                f"Service {svc!r}, which nothing creates. app-default emits "
                f"{sorted(allowed)}. The HTTPRoute would report BackendNotFound and "
                f"every path on this host would return 500."
            )
    return errors


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

        errors.extend(check_gateway_backends(path.relative_to(REPO), doc))
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
