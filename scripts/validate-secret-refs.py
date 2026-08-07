#!/usr/bin/env python3
"""Check that profiles reference the Secret name the composition actually creates.

The compositions name the ESO-managed Secret after the App claim, which is the
profile's metadata.name: `<profile>-sensitive-values`. A profile that hardcodes a
different name renders a Deployment whose envFrom points at a Secret nobody
creates, and the pod sits in CreateContainerConfigError forever.

This is not hypothetical. Renaming the singleton profiles to carry an edition
suffix (app-store -> app-store-me, xwiki -> xwiki-ce, ...) left four profiles
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

    if errors:
        print("Secret reference errors:\n")
        for err in errors:
            print(f"  - {err}")
        return 1

    print(f"Checked {checked} secret reference(s). All match their profile name.")
    return 0


if __name__ == "__main__":
    sys.exit(main())
