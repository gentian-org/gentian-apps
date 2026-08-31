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

# The CustomizationDelivery enum, mirrored from
# gentian-os/api/v1alpha1/customization_surface_types.go. The CRD is the only
# thing that enforced it, which means the enforcement happened on the cluster:
# nginx-sso-routing shipped with `delivery: chart`, the API server refused the
# object, Argo CD retried five times and gave up, and the record simply never
# existed — along with every debt signal the operator derives from one. This
# script reported it valid throughout, because it did not read the field.
#
# Kept as a literal rather than parsed out of the CRD: this repo does not vendor
# gentian-os, and a check that silently passes when it cannot find the schema is
# the failure it is here to prevent. If the enum gains a member, this list is
# one line behind it and the error message says where to look.
DELIVERY_MECHANISMS = {"git-sidecar", "image-layer", "addon-profile", "app-store-api"}

GRADE_BANDS = [(7, "A"), (5, "B"), (3, "C"), (0, "D")]

# Module profiles inherit their base profile's declaration rather than repeating it.
# "module" is the deprecated spelling of "addon"; both are accepted while the
# catalogue migrates.
INHERITING_ROLES = {"addon", "module"}


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


def check_surface(path: pathlib.Path, doc: dict) -> list[str]:
    """Check one AppProfile's spec.customization declaration."""
    errors: list[str] = []
    meta = doc.get("metadata", {}) or {}
    annotations = meta.get("annotations", {}) or {}
    spec = doc.get("spec", {}) or {}

    role = annotations.get("gentianos.io/deployment-role", "standalone")
    surface = spec.get("customization")

    if surface is None:
        # Addons inherit, editions do not.
        #
        # An addon is activation state inside a base: same image, same drop-in dirs,
        # same plugin API, so the base's ladder is its ladder by construction, and it
        # names that base in spec.customization.addon.of.
        #
        # An edition shares only a family name. nextcloud-base-od deploys the OpenDesk
        # AIO chart from a credentialed registry — a locked-down bundle with a fixed
        # app set — and nextcloud-base-ce deploys the community chart with a Gentian
        # image that stages addons for `occ app:enable`. Treating the second as
        # evidence about the first asserted a reachability that does not exist, and
        # nothing at runtime honoured the inheritance anyway: the operator reads
        # spec.customization directly, so an edition without one is [L0, L4] there
        # while this check called it characterised.
        if role in INHERITING_ROLES:
            return errors
        return [
            f"{path}: missing spec.customization — characterise the app "
            f"(see docs/customization-ladder.md) or mark it deployment-role: addon. "
            f"If it genuinely has not been characterised, say so explicitly with "
            f"grade: unknown and supportedRungs: [L0, L4]"
        ]

    # An addon declares spec.customization only to carry `addon:`. Its ladder is the
    # base's, so restating grade/rubricScore/supportedRungs here just forks a mutable
    # fact into N files that go stale the next time the base is rescored.
    if role in INHERITING_ROLES:
        for field in ("grade", "rubricScore", "supportedRungs"):
            if field in surface:
                errors.append(
                    f"{path}: spec.customization.{field} must not be set on an addon — "
                    f"the ladder is inherited from the base named in "
                    f"spec.customization.addon.of; remove it and grade the base instead"
                )
        if not surface.get("addon"):
            errors.append(
                f"{path}: deployment-role addon needs spec.customization.addon.{{id,of}} "
                f"so the operator knows what the hosting app calls it"
            )
        return errors

    grade = surface.get("grade")
    score = surface.get("rubricScore")
    if grade is None:
        errors.append(f"{path}: spec.customization.grade is required")
    # grade: unknown is the honest answer for an app nobody has scored, and a score
    # alongside it would be a contradiction — so it is the one grade that may omit
    # rubricScore. The debt report lists these as uncharacterised, which is the point.
    if score is None and grade != "unknown":
        errors.append(
            f"{path}: spec.customization.rubricScore is required (or set "
            f"grade: unknown if the app has genuinely not been scored)"
        )
    if score is not None and grade == "unknown":
        errors.append(
            f"{path}: grade is unknown but rubricScore {score} is set — score it and "
            f"assign the matching grade, or drop the score"
        )
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
        # perTenantAddons, not perTenantModules: the field was renamed in the L3
        # cleanup and this check kept reading the old key, so it matched nothing and
        # passed every profile for as long as it has existed.
        if extension.get("perTenantAddons") and not extension.get("testMatrix"):
            errors.append(
                f"{path}: extension.perTenantAddons requires a testMatrix — per-tenant "
                f"addons must be pinned to verified app versions"
            )
        if "perTenantModules" in extension:
            errors.append(
                f"{path}: extension.perTenantModules was renamed to perTenantAddons; "
                f"the old key is not read by the CRD and would be silently ignored"
            )

        # extension.delivery is a list of the same enum the record's spec.delivery
        # takes a single value from. A member outside it is rejected by the API
        # server, so the profile would never apply.
        declared = extension.get("delivery")
        if declared is not None:
            if not isinstance(declared, list):
                errors.append(
                    f"{path}: extension.delivery must be a list of mechanisms, "
                    f"got {type(declared).__name__}"
                )
            else:
                for mechanism in declared:
                    if mechanism not in DELIVERY_MECHANISMS:
                        errors.append(
                            f"{path}: extension.delivery {mechanism!r} is not a delivery "
                            f"mechanism — the CRD accepts "
                            f"{', '.join(sorted(DELIVERY_MECHANISMS))}"
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

    # spec.delivery: valid member of the enum, and only meaningful at L3.
    #
    # Two separate failures. A value outside the enum is refused by the API
    # server, so the record never exists. A valid value at another rung applies
    # an L3 answer to a question that rung does not ask — an L4 delivers through
    # its repackaged chart, an L2 as its own deployable — and reaching for the
    # field because it sounds like "how this is delivered" is precisely what put
    # `delivery: chart` on an L4 record.
    delivery = spec.get("delivery")
    if delivery is not None:
        if delivery not in DELIVERY_MECHANISMS:
            errors.append(
                f"{path}: spec.delivery {delivery!r} is not a delivery mechanism — the CRD "
                f"accepts {', '.join(sorted(DELIVERY_MECHANISMS))}, and refuses the whole "
                f"record otherwise"
            )
        elif rung != "L3":
            errors.append(
                f"{path}: spec.delivery is how an L3 module reaches a running app, and this "
                f"record is {rung} — omit it. An L4 delivers through its repackaged chart, "
                f"an L2 as its own deployable; neither is one of these four mechanisms"
            )

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

    for profile_path in sorted(PROFILES_DIR.glob("**/profile.yaml")):
        doc = load_yaml(profile_path)
        if not isinstance(doc, dict):
            errors.append(f"{profile_path}: not a mapping")
            continue
        surfaces += 1
        errors.extend(check_surface(profile_path, doc))

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
