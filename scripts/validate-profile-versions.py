#!/usr/bin/env python3
"""Check that a profile's version moves with its bundle, and that a release
carries no development number.

A tenant sees two things of a build: its digest, which is exact and says
nothing, and spec.version, which is what the listing and the App Store print.
A version that never moves makes the second useless -- every build of every
app said 1.0.0 for a year -- so this holds the two together: when the
published bundle of a profile differs from the base branch's, spec.version
must differ too.

The numbering is the next-dev model (gentian-os docs/plans/versioning.md): on
develop a build carries a pre-release suffix, "0.5.1-dev", and the suffix is
removed when the catalogue is released from main. So on main, or in a pull
request into main, a version with "-dev" is refused, as is a chart pinned at a
"<version>-develop.<sha7>" build (docs/releasing.md).

  --base <git ref>   the commit to compare with: the merge base of a pull
                     request, the commit before a push. Without it only the
                     syntax and the release rules are checked.
  --released         hold the tree to the release rules. CI passes it on main
                     and on pull requests into main.
"""

from __future__ import annotations

import argparse
import pathlib
import re
import subprocess
import sys
import tempfile

import yaml

REPO = pathlib.Path(__file__).resolve().parent.parent
BUILD = REPO / "scripts" / "build-catalogue-source.py"
SEMVER = re.compile(r"^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?$")


def index_of(repo: pathlib.Path, out: pathlib.Path) -> dict[str, dict]:
    """name -> index entry, as the catalogue build of this commit writes it for repo."""
    result = subprocess.run(
        [sys.executable, str(BUILD), "--repo", str(repo), "--out", str(out)],
        capture_output=True,
        text=True,
    )
    if result.returncode != 0:
        print(result.stdout, result.stderr, sep="\n", file=sys.stderr)
        raise SystemExit(f"the catalogue of {repo} does not build")
    entries = (yaml.safe_load((out / "index.yaml").read_text()) or {}).get("entries") or []
    return {e["name"]: e for e in entries}


def main() -> int:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--base", default="", help="git ref to compare the published bundles with")
    ap.add_argument("--released", action="store_true", help="refuse development numbers")
    args = ap.parse_args()
    errors: list[str] = []

    for path in sorted(REPO.glob("profiles/**/profile.yaml")):
        spec = (yaml.safe_load(path.read_text()) or {}).get("spec") or {}
        version = str(spec.get("version") or "")
        rel = path.relative_to(REPO)
        if not SEMVER.match(version):
            errors.append(f"{rel}: spec.version {version!r} is not a semantic version (\"0.5.1-dev\", \"0.5.1\")")
            continue
        if args.released and "-dev" in version:
            errors.append(f"{rel}: spec.version {version!r} is a development number; a release carries the bare version")
        if args.released:
            chart = ((spec.get("package") or {}).get("chart") or {}) if isinstance(spec.get("package"), dict) else {}
            if "-develop." in str(chart.get("version") or ""):
                errors.append(f"{rel}: spec.package.chart.version {chart.get('version')!r} is a develop build; a released profile pins a released chart")

    if args.base:
        with tempfile.TemporaryDirectory() as tmp:
            tmp_path = pathlib.Path(tmp)
            base_tree = tmp_path / "base"
            subprocess.run(["git", "-C", str(REPO), "worktree", "add", "--detach", str(base_tree), args.base],
                           check=True, capture_output=True)
            try:
                head = index_of(REPO, tmp_path / "head")
                base = index_of(base_tree, tmp_path / "base-out") if (base_tree / "profiles").is_dir() else {}
            finally:
                subprocess.run(["git", "-C", str(REPO), "worktree", "remove", "--force", str(base_tree)],
                               check=False, capture_output=True)
        for name, entry in sorted(head.items()):
            before = base.get(name)
            if before is None or before.get("digest") == entry.get("digest"):
                continue
            if before.get("version") == entry.get("version"):
                errors.append(
                    f"{name}: the published bundle changed ({before.get('digest', '')[:19]} -> "
                    f"{entry.get('digest', '')[:19]}) and spec.version is still {entry.get('version')!r}; bump it"
                )

    if errors:
        print("Profile version errors:\n")
        for err in errors:
            print(f"  - {err}")
        return 1
    print(f"Profile versions: {len(list(REPO.glob('profiles/**/profile.yaml')))} profiles checked"
          + (f" against {args.base}" if args.base else "") + (", release rules on" if args.released else ""))
    return 0


if __name__ == "__main__":
    sys.exit(main())
