#!/usr/bin/env python3
"""Refuse a catalog Composition that writes an app's secrets to the vault.

The operator makes every entry of a profile's secrets.generated, derived or
random as the cluster's mode says, and the first value stored stays. A
Composition has no secret to work with: what it writes is computed from names,
and anyone who knows the names can compute it.
"""

from __future__ import annotations

import pathlib
import sys

REFUSED = ("kv.vault.upbound.io", "sha256sum (printf")


def main() -> int:
    failures = []
    for path in sorted(pathlib.Path("profiles").rglob("composition.yaml")):
        text = path.read_text()
        failures += [f"{path}: holds {r}" for r in REFUSED if r in text]
    for failure in failures:
        print(failure, file=sys.stderr)
    return 1 if failures else 0


if __name__ == "__main__":
    sys.exit(main())
