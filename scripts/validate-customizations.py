#!/usr/bin/env python3
"""Validate customization ladder declarations and Customization records.

Two things are checked:

1. Every catalogue AppProfile declares ``spec.customization`` — its position on the
   customization ladder. An app with no declaration is treated by agents as
   ``{grade: unknown, supportedRungs: [L0, L4]}``, which is a deliberate floor, not
   a default to leave in place.

2. Every ``profiles/**/customizations/*.yaml`` record satisfies the ladder policy:
   the rung x scope cost matrix, the upstream-first obligation, the justification
   chain, and the review date.

The policy mirrors gentian-os/internal/customization/policy.go — the operator
enforces the same rules at admission. This script exists so authors and agents get
the answer before pushing, not after.

See gentian-os/docs/app-customization.md.
"""

from __future__ import annotations

import datetime as dt
import pathlib
import sys

import yaml

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
PROFILES_DIR = REPO_ROOT / "profiles"

# Ladder order: index is cost. See framework doc section 2.
RUNG_ORDER = {"L0": 0, "L1": 1, "L2": 2, "L3": 3, "L4": 4, "L5": 5, "L6": 6}

GRADE_BANDS = [(7, "A"), (5, "B"), (3, "C"), (0, "D")]

# Module profiles inherit their base profile's declaration rather than repeating it.
INHERITING_ROLES = {"module"}


def grade_for_score(score: int) -> str:
    for threshold, grade in GRADE_BANDS:
        if score >= threshold:
            return grade
    return "D"


def rung_at_or_above(rung: str, ref: str) -> bool:
    if rung not in RUNG_ORDER or ref not in RUNG_ORDER:
        return False
    return RUNG_ORDER[rung] >= RUNG_ORDER[ref]


def load_yaml(path: pathlib.Path):
    try:
        return yaml.safe_load(path.read_text())
    except yaml.YAMLError as exc:  # pragma: no cover - surfaced to the author
        raise SystemExit(f"{path}: invalid YAML: {exc}")


def check_surface(path: pathlib.Path, doc: dict, characterised_families: set[str]) -> list[str]:
    """Check one AppProfile's spec.customization declaration."""
    errors: list[str] = []
    meta = doc.get("metadata", {}) or {}
    annotations = meta.get("annotations", {}) or {}
    spec = doc.get("spec", {}) or {}

    role = annotations.get("gentianos.io/deployment-role", "standalone")
    family = spec.get("family") or meta.get("name")
    surface = spec.get("customization")

    if surface is None:
        # Module profiles and edition profiles inherit the surface of the family's
        # characterised profile: they are the same app with a different feature set,
        # so their customization ladder is identical by construction.
        if role in INHERITING_ROLES or family in characterised_families:
            return errors
        return [
            f"{path}: missing spec.customization — characterise the app "
            f"(see docs/customization-ladder.md), mark it deployment-role: module, "
            f"or give it a family whose base profile is characterised"
        ]

    grade = surface.get("grade")
    score = surface.get("rubricScore")
    if grade is None:
        errors.append(f"{path}: spec.customization.grade is required")
    if score is None:
        errors.append(f"{path}: spec.customization.rubricScore is required")
    if grade is not None and score is not None and grade != "unknown":
        expected = grade_for_score(int(score))
        if expected != grade:
            errors.append(
                f"{path}: grade {grade!r} does not match rubricScore {score} "
                f"(expected {expected!r}) — rescore or regrade"
            )

    rungs = surface.get("supportedRungs") or []
    for rung in rungs:
        if rung not in RUNG_ORDER:
            errors.append(f"{path}: unknown rung {rung!r} in supportedRungs")
    if "L2" in rungs:
        errors.append(
            f"{path}: L2 must not appear in supportedRungs — a companion app is always "
            f"buildable, so L2 is a property of the customization, not of the target"
        )

    for drop_in in surface.get("dropIns") or []:
        name = drop_in.get("name", "<unnamed>")
        if not str(drop_in.get("path", "")).startswith("/"):
            errors.append(f"{path}: dropIn {name!r}: path must be absolute")
        if not drop_in.get("format"):
            errors.append(f"{path}: dropIn {name!r}: format is required")
        if drop_in.get("tenantEditable") and not drop_in.get("format"):
            errors.append(
                f"{path}: dropIn {name!r}: tenant-editable drop-ins need a format "
                f"so content can be validated before it is mounted"
            )

    extension = surface.get("extension")
    if extension is not None:
        if "L3" not in rungs:
            errors.append(
                f"{path}: spec.customization.extension is declared but L3 is not in supportedRungs"
            )
        if extension.get("perTenantModules") and not extension.get("testMatrix"):
            errors.append(
                f"{path}: extension.perTenantModules requires a testMatrix — per-tenant "
                f"modules must be pinned to verified app versions"
            )

    return errors


def check_record(path: pathlib.Path, doc: dict) -> list[str]:
    """Check one Customization record against the ladder policy."""
    errors: list[str] = []
    if doc.get("kind") != "Customization":
        return [f"{path}: expected kind: Customization, got {doc.get('kind')!r}"]

    spec = doc.get("spec", {}) or {}
    rung = spec.get("rung")
    scope = spec.get("scope")

    if rung not in RUNG_ORDER:
        return [f"{path}: spec.rung {rung!r} is not a ladder rung"]
    if scope not in {"tenant", "profile", "platform"}:
        errors.append(f"{path}: spec.scope {scope!r} is not a valid scope")

    for field in ("summary", "owner", "reviewBy"):
        if not spec.get(field):
            errors.append(f"{path}: spec.{field} is required")

    if not (spec.get("target") or {}).get("profile"):
        errors.append(f"{path}: spec.target.profile is required")

    # Cost matrix: never patch or fork for a single tenant.
    if scope == "tenant" and rung_at_or_above(rung, "L5"):
        errors.append(
            f"{path}: rung {rung} is not permitted at tenant scope — a tenant-specific "
            f"source divergence has no upgrade path"
        )
    if scope == "tenant" and not spec.get("tenants"):
        errors.append(f"{path}: spec.tenants must be non-empty at tenant scope")
    if scope != "tenant" and spec.get("tenants"):
        errors.append(f"{path}: spec.tenants must be empty when scope is {scope}")

    # Upstream-first, mandatory from L4 where Gentian starts owning the artifact.
    if rung_at_or_above(rung, "L4"):
        upstream = spec.get("upstreamFirst") or {}
        if not upstream.get("attempted"):
            errors.append(f"{path}: spec.upstreamFirst.attempted must be true for rung {rung}")
        elif upstream.get("forwarded") == "no" and not str(upstream.get("reason", "")).strip():
            errors.append(f"{path}: spec.upstreamFirst.reason is required when forwarded is 'no'")

    if rung_at_or_above(rung, "L5") and not str(spec.get("exitCriteria", "")).strip():
        errors.append(f"{path}: spec.exitCriteria is required for rung {rung}")

    if rung_at_or_above(rung, "L3") and not spec.get("artifacts"):
        errors.append(f"{path}: spec.artifacts must name at least one artifact for rung {rung}")

    # The justification chain is what stops the ladder being decorative.
    justification = spec.get("rungJustification") or {}
    chosen = RUNG_ORDER[rung]
    for candidate, idx in RUNG_ORDER.items():
        if idx >= chosen:
            continue
        if not str(justification.get(candidate, "")).strip():
            errors.append(
                f"{path}: spec.rungJustification[{candidate!r}] is required — "
                f"state why {candidate} cannot express this change"
            )

    review_by = spec.get("reviewBy")
    if review_by:
        try:
            if dt.date.fromisoformat(str(review_by)) < dt.date.today():
                errors.append(
                    f"{path}: spec.reviewBy {review_by} has passed — this is customization "
                    f"debt: re-justify, descend a rung, or drop it"
                )
        except ValueError:
            errors.append(f"{path}: spec.reviewBy {review_by!r} is not an ISO date")

    return errors


def main() -> int:
    errors: list[str] = []
    surfaces = 0
    records = 0

    # First pass: which families have a characterised profile? Edition and module
    # profiles inherit from it rather than repeating the declaration.
    profiles = []
    characterised_families: set[str] = set()
    for profile_path in sorted(PROFILES_DIR.glob("**/profile.yaml")):
        doc = load_yaml(profile_path)
        if not isinstance(doc, dict):
            errors.append(f"{profile_path}: not a mapping")
            continue
        profiles.append((profile_path, doc))
        spec = doc.get("spec", {}) or {}
        if spec.get("customization"):
            family = spec.get("family") or (doc.get("metadata", {}) or {}).get("name")
            if family:
                characterised_families.add(family)

    for profile_path, doc in profiles:
        surfaces += 1
        errors.extend(check_surface(profile_path, doc, characterised_families))

    for record_path in sorted(PROFILES_DIR.glob("**/customizations/*.yaml")):
        doc = load_yaml(record_path)
        if not isinstance(doc, dict):
            errors.append(f"{record_path}: not a mapping")
            continue
        records += 1
        errors.extend(check_record(record_path, doc))

    print(f"Checked {surfaces} profile(s) and {records} customization record(s).")
    if errors:
        print(f"\n{len(errors)} problem(s):\n", file=sys.stderr)
        for error in errors:
            print(f"  - {error}", file=sys.stderr)
        return 1
    print("All customization declarations and records are valid.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
