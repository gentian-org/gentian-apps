#!/usr/bin/env python3
"""Generate the customization debt report from records in this repository.

The authoritative report is computed by the gentian-os operator from live
``Customization`` CRs (their ``status`` carries review-overdue, upstream-stale and
version-drift signals) and rendered in the Admin Console. This script produces the
same view from the git working tree, so the number is visible in a PR — before the
debt is merged rather than after.

The headline number is **records by rung**, and it is meant to go down. A platform
whose L4+ count only ever rises is one that has stopped descending.

Usage:
    python3 scripts/customization-debt-report.py [--format markdown|json]

See gentian-os/docs/app-customization.md section 8.3.
"""

from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import pathlib
import sys

import yaml

REPO_ROOT = pathlib.Path(__file__).resolve().parent.parent
PROFILES_DIR = REPO_ROOT / "profiles"

RUNGS = ["L0", "L1", "L2", "L3", "L4", "L5", "L6"]
SCOPES = ["tenant", "profile", "platform"]
RUNG_ORDER = {rung: index for index, rung in enumerate(RUNGS)}


def load_records() -> list[dict]:
    records = []
    for path in sorted(PROFILES_DIR.glob("**/customizations/*.yaml")):
        doc = yaml.safe_load(path.read_text())
        if isinstance(doc, dict) and doc.get("kind") == "Customization":
            doc["_path"] = str(path.relative_to(REPO_ROOT))
            records.append(doc)
    return records


def load_grades() -> dict[str, str]:
    """Grade every profile, resolving addon inheritance only.

    An addon inherits: it is activation state inside a base — same image, same
    drop-in dirs, same plugin API — so the base's ladder is its ladder by
    construction, and it names that base in spec.customization.addon.of.

    An edition does not. It shares a family name and nothing else:
    nextcloud-base-od deploys the OpenDesk AIO chart from a credentialed registry,
    nextcloud-base-ce the community chart with a Gentian image. Inheriting by family
    reported the OpenDesk bundle as grade A on the strength of a different artifact,
    and hid it from the uncharacterised list below — the one place it should appear.
    """
    entries = []
    graded: dict[str, str] = {}
    for path in sorted(PROFILES_DIR.glob("**/profile.yaml")):
        doc = yaml.safe_load(path.read_text())
        if not isinstance(doc, dict):
            continue
        spec = doc.get("spec", {}) or {}
        name = (doc.get("metadata", {}) or {}).get("name")
        if not name:
            continue
        surface = spec.get("customization") or {}
        grade = surface.get("grade")
        base = (surface.get("addon") or {}).get("of")
        entries.append((name, base, grade))
        if grade:
            graded[name] = grade

    return {
        name: grade or (graded.get(base, "unknown") if base else "unknown")
        for name, base, grade in entries
    }


def declared_deltas() -> list[tuple[str, str, str]]:
    """Deltas the catalogue admits to carrying, read from the profiles.

    The report used to count only Customization records, so "0 carried deltas at L4
    or above" meant "nobody wrote a record" — the instrument built to measure the gap
    read zero by construction, and read it most loudly when the gap was widest.

    A profile that owns its chart, permits patching, or maintains a fork is carrying a
    delta whether or not anyone filed the paperwork. §5 requires a record for every
    customization at L2 and above, so a declared delta with no record is exactly the
    debt this report exists to surface.

    Returns (profile, rung, what).
    """
    found: list[tuple[str, str, str]] = []
    for path in sorted(PROFILES_DIR.glob("**/profile.yaml")):
        doc = yaml.safe_load(path.read_text())
        if not isinstance(doc, dict):
            continue
        spec = doc.get("spec", {}) or {}
        name = (doc.get("metadata", {}) or {}).get("name")
        surface = spec.get("customization") or {}
        if not name or surface.get("addon"):
            continue

        ownership = (surface.get("repackage") or {}).get("chartOwnership")
        # "upstream" is the absence of a delta; anything else is Gentian carrying one.
        if ownership and ownership != "upstream":
            found.append((name, "L4", f"chartOwnership: {ownership}"))
        # patch.allowed is a permission, not a delta: the delta is the patch series,
        # and its length lives in the build repo where this script cannot read it
        # (odoo's is currently empty — the fork's changes are Dockerfile-level, i.e.
        # L6). Inferring an L5 delta from the permission would report debt that does
        # not exist, which is the mirror of the bug this section fixes. §8.3 asks for
        # "patch series length per forked component"; that needs the operator, which
        # can see the repo, not a catalogue-side script.
        if (surface.get("fork") or {}).get("allowed"):
            repo = (surface.get("fork") or {}).get("repo", "?")
            found.append((name, "L6", f"fork maintained at {repo}"))
    return found


def analyse(records: list[dict], grades: dict[str, str]) -> dict:
    today = dt.date.today()
    matrix = collections.Counter()
    by_rung = collections.Counter()
    overdue, unforwarded, external = [], [], []

    for record in records:
        spec = record.get("spec", {}) or {}
        rung = spec.get("rung", "?")
        scope = spec.get("scope", "?")
        by_rung[rung] += 1
        matrix[(rung, scope)] += 1

        review_by = spec.get("reviewBy")
        if review_by:
            try:
                if dt.date.fromisoformat(str(review_by)) < today:
                    overdue.append((record["_path"], review_by))
            except ValueError:
                overdue.append((record["_path"], f"unparseable: {review_by}"))

        upstream = spec.get("upstreamFirst") or {}
        if (
            RUNG_ORDER.get(rung, 0) >= RUNG_ORDER["L4"]
            and upstream.get("forwarded") == "no"
            and not str(upstream.get("reason", "")).strip()
        ):
            unforwarded.append(record["_path"])

        origin = spec.get("origin") or {}
        if origin.get("repoOwnership") == "external":
            external.append((record["_path"], origin.get("organisation", "?")))

    uncharacterised = sorted(
        name for name, grade in grades.items() if grade in {"unknown", None}
    )

    covered = {
        (str((r.get("spec") or {}).get("target", {}).get("profile")), (r.get("spec") or {}).get("rung"))
        for r in records
    }
    unrecorded = [
        (profile, rung, what)
        for profile, rung, what in declared_deltas()
        if (profile, rung) not in covered
    ]

    return {
        "generated": today.isoformat(),
        "totalRecords": len(records),
        "byRung": {rung: by_rung.get(rung, 0) for rung in RUNGS},
        "matrix": {f"{rung}/{scope}": count for (rung, scope), count in sorted(matrix.items())},
        "carriedDeltas": sum(by_rung[rung] for rung in ("L4", "L5", "L6")),
        "reviewOverdue": overdue,
        "upstreamUnforwarded": unforwarded,
        "externallyOwned": external,
        "uncharacterisedApps": uncharacterised,
        "unrecordedDeltas": unrecorded,
        "grades": collections.Counter(grades.values()),
    }


def render_markdown(report: dict) -> str:
    lines = [
        "# Customization debt report",
        "",
        f"Generated {report['generated']} from `profiles/**/customizations/`.",
        "",
        f"**{report['totalRecords']}** record(s) covering "
        f"**{report['carriedDeltas']}** delta(s) at L4 or above; "
        f"**{len(report['unrecordedDeltas'])}** declared delta(s) with no record.",
        "",
        "## Records by rung",
        "",
        "| Rung | Count |",
        "|---|---|",
    ]
    for rung in RUNGS:
        lines.append(f"| {rung} | {report['byRung'][rung]} |")

    lines += ["", "## Readiness grades", "", "| Grade | Apps |", "|---|---|"]
    for grade in ("A", "B", "C", "D", "unknown"):
        lines.append(f"| {grade} | {report['grades'].get(grade, 0)} |")

    def section(title: str, rows: list, formatter) -> None:
        lines.extend(["", f"## {title}", ""])
        if not rows:
            lines.append("None.")
            return
        for row in rows:
            lines.append(f"- {formatter(row)}")

    section("Past review date", report["reviewOverdue"], lambda r: f"`{r[0]}` — due {r[1]}")
    section(
        "Never forwarded upstream, no reason recorded",
        report["upstreamUnforwarded"],
        lambda r: f"`{r}`",
    )
    section("Externally owned", report["externallyOwned"], lambda r: f"`{r[0]}` — {r[1]}")
    section("Uncharacterised apps", report["uncharacterisedApps"], lambda r: f"`{r}`")
    section(
        "Declared deltas with no Customization record",
        report["unrecordedDeltas"],
        lambda r: f"`{r[0]}` — {r[1]}, {r[2]}",
    )

    return "\n".join(lines) + "\n"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--format", choices=("markdown", "json"), default="markdown")
    args = parser.parse_args()

    report = analyse(load_records(), load_grades())

    if args.format == "json":
        report["grades"] = dict(report["grades"])
        print(json.dumps(report, indent=2))
    else:
        print(render_markdown(report), end="")

    # A report is informational; it never fails CI. Enforcement lives in
    # validate-customizations.py and in the operator's admission checks.
    return 0


if __name__ == "__main__":
    sys.exit(main())
