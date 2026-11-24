#!/usr/bin/env python3
"""Check that every profile's chart renders the pull secrets the platform hands it.

The operator gives each release its pull Secrets under `imagePullSecrets` and
`global.imagePullSecrets` (gentian-os internal/apprender/values_inline.go), as
plain names, or as `{name: ...}` entries when the profile carries the
annotation `gentianos.io/standard-image-pull-secrets: "true"`. A chart that
writes the list into the pod spec as it is needs the second form: given plain
names it renders `- registry-credentials` where Kubernetes wants
`- name: registry-credentials`, and the install fails at Helm's post render
(`expected MappingNode but got ScalarNode`) only when a tenant installs it.

For every profile this renders its chart with the profile's extraValues and
the pull secrets in the form that profile gets, and fails on a plain name in
any workload's `imagePullSecrets`. A chart this repository builds is rendered
from its directory; any other is fetched. `${...}` placeholders stand for
values the platform fills in and are given a dummy value.

A chart that cannot be fetched or does not render on its own (it needs values
only the platform has) is a warning, not a failure: an outage must not fail a
pull request. VALIDATE_OFFLINE=1 checks only the charts built here.
"""

from __future__ import annotations

import os
import pathlib
import re
import subprocess
import sys
import tempfile

import yaml

REPO = pathlib.Path(__file__).resolve().parent.parent
OWN_REGISTRY = "oci://ghcr.io/gentian-org/charts"
STANDARD = "gentianos.io/standard-image-pull-secrets"
SECRET = "registry-credentials"
PLACEHOLDER = re.compile(r"\$\{[A-Z0-9_]+\}")
WORKLOADS = {"Deployment", "StatefulSet", "DaemonSet", "Job", "CronJob", "ReplicaSet", "Pod"}


def own_charts() -> dict[str, pathlib.Path]:
    found: dict[str, pathlib.Path] = {}
    for pattern in ("charts/*/Chart.yaml", "images/*/chart/Chart.yaml", "apps/*/chart/Chart.yaml"):
        for path in REPO.glob(pattern):
            data = yaml.safe_load(path.read_text()) or {}
            if data.get("name"):
                found[data["name"]] = path.parent
    return found


def profiles():
    for path in sorted(REPO.glob("profiles/**/profile.yaml")):
        for doc in yaml.safe_load_all(path.read_text()):
            if isinstance(doc, dict) and doc.get("kind") == "ComponentProfile":
                yield path, doc


def fill_placeholders(value):
    if isinstance(value, str):
        return PLACEHOLDER.sub("placeholder.example", value)
    if isinstance(value, dict):
        return {k: fill_placeholders(v) for k, v in value.items()}
    if isinstance(value, list):
        return [fill_placeholders(v) for v in value]
    return value


def set_path(values: dict, dotted: str, value) -> None:
    keys = dotted.split(".")
    node = values
    for key in keys[:-1]:
        if not isinstance(node.get(key), dict):
            node[key] = {}
        node = node[key]
    node.setdefault(keys[-1], value)


def platform_values(spec: dict) -> dict:
    """A dummy for every value the platform supplies: each valueMapping
    target (database host, realm issuer, ...) and each generated secret's
    path, so a chart that requires them renders."""
    values: dict = {}

    def walk(mapping) -> None:
        if not isinstance(mapping, dict):
            return
        for key, target in mapping.items():
            if isinstance(target, dict):
                walk(target)
            elif isinstance(target, str) and key.endswith("Key") and target:
                if key.lower().endswith("portkey"):
                    dummy = 1
                elif key == "organizationKey":  # who the tenant is, as one object
                    dummy = {}
                else:
                    dummy = "placeholder"
                set_path(values, target, dummy)

    walk((spec.get("package") or {}).get("valueMapping"))
    for secret in (spec.get("secrets") or {}).get("generated") or []:
        if isinstance(secret, dict) and secret.get("valuePath"):
            set_path(values, secret["valuePath"], "placeholder")
    return values


def pod_spec(doc: dict) -> dict:
    spec = doc.get("spec") or {}
    if doc.get("kind") == "Pod":
        return spec
    if doc.get("kind") == "CronJob":
        spec = ((spec.get("jobTemplate") or {}).get("spec")) or {}
    return ((spec.get("template") or {}).get("spec")) or {}


def main() -> int:
    offline = os.environ.get("VALIDATE_OFFLINE") == "1"
    built = own_charts()
    errors: list[str] = []
    warnings: list[str] = []
    checked = 0
    for path, profile in profiles():
        name = profile["metadata"]["name"]
        package = profile.get("spec", {}).get("package") or {}
        chart = package.get("chart") or {}
        if not chart.get("name"):
            continue
        if chart.get("repository") == OWN_REGISTRY and chart["name"] in built:
            source = [str(built[chart["name"]])]
        elif offline:
            continue
        else:
            source = [chart["name"], "--repo", chart["repository"], "--version", str(chart.get("version", ""))]
            if chart["repository"].startswith("oci://"):
                source = [f"{chart['repository']}/{chart['name']}", "--version", str(chart.get("version", ""))]
        standard = (profile["metadata"].get("annotations") or {}).get(STANDARD) == "true"
        given = [{"name": SECRET}] if standard else [SECRET]
        values = fill_placeholders(package.get("extraValues") or {})
        with tempfile.TemporaryDirectory() as tmp:
            supplied = pathlib.Path(tmp, "supplied.yaml")
            supplied.write_text(yaml.safe_dump(platform_values(profile.get("spec") or {})))
            extra = pathlib.Path(tmp, "extra.yaml")
            extra.write_text(yaml.safe_dump(values))
            secrets = pathlib.Path(tmp, "secrets.yaml")
            secrets.write_text(yaml.safe_dump({"imagePullSecrets": given, "global": {"imagePullSecrets": given}}))
            run = subprocess.run(
                ["helm", "template", "check", *source, "-f", str(supplied), "-f", str(extra), "-f", str(secrets)],
                capture_output=True, text=True,
            )
        if run.returncode != 0:
            last = (run.stderr.strip().splitlines() or ["no output"])[-1]
            warnings.append(f"{path.relative_to(REPO)}: {name}: chart not rendered on its own ({last[:160]})")
            continue
        checked += 1
        try:
            docs = [d for d in yaml.safe_load_all(run.stdout) if isinstance(d, dict)]
        except yaml.YAMLError as err:
            warnings.append(f"{path.relative_to(REPO)}: {name}: rendered output is not YAML ({str(err)[:120]})")
            continue
        for doc in docs:
            if doc.get("kind") not in WORKLOADS:
                continue
            for entry in pod_spec(doc).get("imagePullSecrets") or []:
                if not isinstance(entry, dict):
                    form = "{name: ...} entries" if standard else "plain names"
                    errors.append(
                        f"{path.relative_to(REPO)}: {name}: {doc['kind']} {doc.get('metadata', {}).get('name')} "
                        f"renders the pull secret {entry!r} as a plain name. The chart is given {form}; "
                        + ("make the chart write them as `- name: <secret>`" if standard else
                           f"set the annotation {STANDARD}: \"true\" on the profile, or make the chart turn "
                           "names into `- name: <secret>`")
                    )
    for w in warnings:
        print(f"warning: {w}")
    if errors:
        print("Pull secret errors:")
        for e in errors:
            print(f"  - {e}")
        return 1
    print(f"Pull secrets: {checked} charts rendered, every workload names its pull secrets as references")
    return 0


if __name__ == "__main__":
    sys.exit(main())
