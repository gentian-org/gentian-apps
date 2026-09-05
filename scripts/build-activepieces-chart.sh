#!/usr/bin/env bash
# Build the activepieces chart from pinned upstream + the local patch series.
#
# The chart is not vendored: this fetches upstream at the pinned version, applies
# charts/activepieces/patches/series on top, resolves subchart dependencies, and
# packages the result. See charts/activepieces/README.md and
# docs/app-profile-guide.md §0.
#
# Usage:
#   scripts/build-activepieces-chart.sh [--render] [--out DIR]
#
#   --render   also run `helm template` on the built chart and print the manifest
#   --out DIR  where to write the packaged .tgz (default: a temp dir)
#
# Exit status is non-zero if any patch fails to apply — that is deliberate. A
# series that no longer applies to upstream is a decision point, not a nuisance.
set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
CHART_DIR="${REPO_ROOT}/charts/activepieces"
RENDER=0
OUT_DIR=""

while [ $# -gt 0 ]; do
    case "$1" in
        --render) RENDER=1; shift ;;
        --out)    OUT_DIR="$2"; shift 2 ;;
        *) echo "unknown argument: $1" >&2; exit 2 ;;
    esac
done

# shellcheck source=/dev/null
source "${CHART_DIR}/UPSTREAM"
: "${REPO:?UPSTREAM must define REPO}"
: "${CHART:?UPSTREAM must define CHART}"
: "${UPSTREAM_VERSION:?UPSTREAM must define UPSTREAM_VERSION}"
: "${CHART_VERSION:?UPSTREAM must define CHART_VERSION}"

WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT
[ -n "$OUT_DIR" ] || OUT_DIR="$WORK/out"
mkdir -p "$OUT_DIR"

echo "==> upstream ${CHART} ${UPSTREAM_VERSION} from ${REPO}"
helm repo add activepieces-upstream "$REPO" >/dev/null
helm repo update activepieces-upstream >/dev/null
helm pull "activepieces-upstream/${CHART}" \
    --version "$UPSTREAM_VERSION" --untar --untardir "$WORK/src" >/dev/null

SRC="$WORK/src/${CHART}"

echo "==> applying patch series"
applied=0
while IFS= read -r patch; do
    [ -n "$patch" ] || continue
    case "$patch" in \#*) continue ;; esac
    if ! git apply --directory="$(realpath --relative-to="$PWD" "$SRC")" \
            --unsafe-paths "${CHART_DIR}/patches/${patch}" 2>/dev/null; then
        # git apply is strict about context; fall back to patch(1) before failing
        if ! patch -p1 -d "$SRC" -s -F0 < "${CHART_DIR}/patches/${patch}"; then
            echo "ERROR: ${patch} does not apply to ${CHART} ${UPSTREAM_VERSION}" >&2
            echo "       Rebase or drop it — do not pin upstream to avoid this." >&2
            exit 1
        fi
    fi
    echo "    ${patch}"
    applied=$((applied + 1))
done < "${CHART_DIR}/patches/series"
echo "    ${applied} patch(es) applied cleanly"

echo "==> resolving subchart dependencies"
helm dependency build "$SRC" >/dev/null 2>&1 || helm dependency update "$SRC" >/dev/null

echo "==> packaging as ${CHART_VERSION}"
helm package "$SRC" --version "$CHART_VERSION" --destination "$OUT_DIR" >/dev/null
PKG="${OUT_DIR}/${CHART}-${CHART_VERSION}.tgz"
[ -f "$PKG" ] || { echo "ERROR: expected ${PKG}" >&2; exit 1; }

helm lint "$SRC" >/dev/null && echo "==> lint OK"

if [ "$RENDER" = "1" ]; then
    echo "==> rendered manifest"
    helm template activepieces "$SRC"
fi

echo "==> built ${PKG}"
[ -n "${GITHUB_OUTPUT:-}" ] && echo "package=${PKG}" >> "$GITHUB_OUTPUT"
exit 0
