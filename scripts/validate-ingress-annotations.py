#!/usr/bin/env python3
"""Validate gentianos.io/gateway-* annotations on AppProfile ingress specs.

An annotation the operator does not recognise is not rejected anywhere -- it is
simply never read, so a profile can ask for behaviour it silently never gets.

That is not hypothetical. gentianos.io/gateway-response-timeout was declared,
documented, honoured in the operator and set by four profiles, and did nothing
at all: BackendTrafficPolicy's timeout.http has no responseTimeout field, so the
API server pruned it on write and every policy came back with requestTimeout
alone. It took a 504 on a user-facing sign-in to notice.

This cannot catch a key the operator reads but the downstream CRD prunes -- that
one needs a test against the real schema. It does catch the cheaper half: a
profile naming an annotation nothing will ever act on.
"""

from __future__ import annotations

import sys
from pathlib import Path

import yaml

ROOT = Path(__file__).resolve().parents[1]
PROFILES = ROOT / "profiles"

# Mirrors the constants in gentian-os api/v1alpha1/catalogue_types.go. Keep in
# step with that block; it is the operator's own list and the only thing that
# decides what is read.
KNOWN = {
    "gentianos.io/gateway-frame-ancestors",
    "gentianos.io/gateway-escaped-slashes-action",
    "gentianos.io/gateway-request-timeout",
    "gentianos.io/gateway-buffer-limit",
}

# Removed rather than renamed, with what to use instead.
RETIRED = {
    "gentianos.io/gateway-response-timeout": (
        "no such field in BackendTrafficPolicy.timeout.http -- the API server "
        "pruned it, so it never had an effect. gateway-request-timeout is the "
        "whole budget for the exchange, response included."
    ),
}


def ingress_blocks(spec: dict) -> list[dict]:
    blocks = []
    primary = spec.get("ingress")
    if isinstance(primary, dict):
        blocks.append(primary)
    for extra in spec.get("additionalIngresses") or []:
        if isinstance(extra, dict):
            blocks.append(extra)
    return blocks


def validate_profile(path: Path) -> list[str]:
    errors: list[str] = []
    doc = yaml.safe_load(path.read_text(encoding="utf-8"))
    if not doc or doc.get("kind") != "AppProfile":
        return errors
    rel = path.relative_to(ROOT)
    for block in ingress_blocks(doc.get("spec") or {}):
        for key in (block.get("annotations") or {}):
            if not key.startswith("gentianos.io/gateway-"):
                continue
            if key in RETIRED:
                errors.append(f"{rel}: {key} is retired -- {RETIRED[key]}")
            elif key not in KNOWN:
                errors.append(
                    f"{rel}: {key} is not read by the operator; "
                    f"known keys are {', '.join(sorted(KNOWN))}"
                )
    return errors


def main() -> int:
    errors: list[str] = []
    profiles = sorted(PROFILES.glob("**/profile.yaml"))
    for path in profiles:
        errors.extend(validate_profile(path))
    if errors:
        for e in errors:
            print(f"ERROR: {e}", file=sys.stderr)
        return 1
    print(f"Validated gateway annotations for {len(profiles)} profiles")
    return 0


if __name__ == "__main__":
    sys.exit(main())
