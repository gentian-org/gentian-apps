#!/usr/bin/env python3
"""Check every published bundle against the schema of each platform version
line its floor admits.

A profile declares the oldest platform it runs on, spec.requires.platform
(">=0.5"). The platform reads a bundle with the schema of its own line and
refuses what it does not know, whole. So a bundle has to conform to the
schema of every line from its floor up to the newest this repository knows,
and this is where that is checked -- in the pull request, not at a tenant's
install.

The schemas are the platform's own resource definitions, one directory per
line, vendored here from gentian-os when a line is cut:

    contracts/platform/<line>/gentianos.io_componentprofiles.yaml
    contracts/platform/<line>/gentianos.io_customizations.yaml
    contracts/platform/<line>/gentianos.io_oidcpackcatalogs.yaml

Only kinds a bundle may hold and that the platform defines are checked. A
Composition's schema is Crossplane's and a ConfigMap's is Kubernetes'; both
are checked by kubectl kustomize in CI.

The check is structural: types, required fields, enums, patterns and
lengths. The platform's CEL rules (x-kubernetes-validations) are not run
here; they are the platform's to run, and a bundle that trips one is refused
at install with the rule's own message.
"""

from __future__ import annotations

import pathlib
import re
import subprocess
import sys
import tempfile

import jsonschema
import yaml

REPO = pathlib.Path(__file__).resolve().parent.parent


class PlainLoader(yaml.SafeLoader):
    """YAML as the API server reads it: a date is a string, not a date."""


PlainLoader.yaml_implicit_resolvers = {
    first: [(tag, regexp) for tag, regexp in resolvers if tag != "tag:yaml.org,2002:timestamp"]
    for first, resolvers in yaml.SafeLoader.yaml_implicit_resolvers.items()
}
LINES = REPO / "contracts" / "platform"
BUILD = REPO / "scripts" / "build-catalogue-source.py"
FLOOR = re.compile(r"^(>=)?v?(\d+)\.(\d+)$")


def line_of(name: str) -> tuple[int, int]:
    major, minor = name.split(".")
    return int(major), int(minor)


def schemas() -> dict[tuple[int, int], dict[str, dict]]:
    """line -> kind -> openAPIV3Schema, for every vendored line."""
    out: dict[tuple[int, int], dict[str, dict]] = {}
    for directory in sorted(p for p in LINES.iterdir() if p.is_dir()):
        kinds: dict[str, dict] = {}
        for crd_file in sorted(directory.glob("gentianos.io_*.yaml")):
            crd = yaml.safe_load(crd_file.read_text())
            kind = crd["spec"]["names"]["kind"]
            for version in crd["spec"]["versions"]:
                if version.get("served", True):
                    kinds[kind] = prune(version["schema"]["openAPIV3Schema"])
        out[line_of(directory.name)] = kinds
    return out


def prune(schema):
    """The CRD schema as a JSON schema: Kubernetes' own keywords removed, and
    int-or-string and nullable spelled as JSON schema spells them."""
    if isinstance(schema, dict):
        out = {}
        if schema.get("x-kubernetes-int-or-string"):
            return {"anyOf": [{"type": "integer"}, {"type": "string"}]}
        if schema.get("x-kubernetes-preserve-unknown-fields") and "properties" not in schema:
            return {}
        for key, value in schema.items():
            if key.startswith("x-kubernetes-"):
                continue
            if key == "nullable":
                continue
            out[key] = prune(value)
        if schema.get("nullable") and "type" in out and isinstance(out["type"], str):
            out["type"] = [out["type"], "null"]
        return out
    if isinstance(schema, list):
        return [prune(v) for v in schema]
    return schema


def main() -> int:
    by_line = schemas()
    if not by_line:
        print(f"no platform lines under {LINES.relative_to(REPO)}", file=sys.stderr)
        return 1
    newest = max(by_line)
    errors: list[str] = []
    checked = 0
    with tempfile.TemporaryDirectory() as tmp:
        out = pathlib.Path(tmp)
        result = subprocess.run([sys.executable, str(BUILD), "--out", str(out)], capture_output=True, text=True)
        if result.returncode != 0:
            print(result.stdout, result.stderr, sep="\n", file=sys.stderr)
            return 1
        for published in sorted((out / "profiles").glob("*.yaml")):
            docs = [d for d in yaml.load_all(published.read_text(), Loader=PlainLoader) if d]
            profile = docs[0]
            floor = str(((profile.get("spec") or {}).get("requires") or {}).get("platform") or "")
            m = FLOOR.match(floor) if floor else None
            if floor and not m:
                errors.append(f"{published.stem}: spec.requires.platform {floor!r} is not \">=<major>.<minor>\"")
                continue
            lowest = (int(m.group(2)), int(m.group(3))) if m else min(by_line)
            if lowest > newest:
                errors.append(
                    f"{published.stem}: spec.requires.platform {floor!r} names a line this repository has no "
                    f"schema for; vendor contracts/platform/{m.group(2)}.{m.group(3)} first"
                )
                continue
            admitted = [line for line in sorted(by_line) if line >= lowest]
            for line in admitted:
                kinds = by_line[line]
                for doc in docs:
                    schema = kinds.get(doc.get("kind"))
                    if schema is None:
                        continue
                    validator = jsonschema.Draft7Validator(schema)
                    for problem in sorted(validator.iter_errors(doc), key=lambda e: list(e.path)):
                        where = "/".join(str(p) for p in problem.path) or "<root>"
                        errors.append(
                            f"{published.stem}: {doc.get('kind')} {doc.get('metadata', {}).get('name')} does not "
                            f"conform to platform {line[0]}.{line[1]} at {where}: {problem.message}"
                        )
                    checked += 1
    if errors:
        print("Platform schema errors:\n")
        for err in errors:
            print(f"  - {err}")
        return 1
    lines = ", ".join(f"{a}.{b}" for a, b in sorted(by_line))
    print(f"Platform schema: {checked} documents conform to the lines they admit ({lines})")
    return 0


if __name__ == "__main__":
    sys.exit(main())
