#!/usr/bin/env bash
# The end-to-end runs: the sidecar built from this directory against Keycloak
# 26.8.0, and against Docmost and OpenProject at the versions the
# catalog pins, each with its profile's own handler. Needs docker, node and
# helm.
#
#   e2e/run.sh                 everything
#   e2e/run.sh docmost         one of: sidecar, docmost, openproject
#
# Every container it starts is removed again; E2E_KEEP=1 leaves them to look at.
# Keycloak runs with the platform's extension (E2E_LISTENER_IMAGE), asking a
# stand-in for the rights store (e2e/lib/rights.js) for a person's roles.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ -d node_modules ] || npm ci
docker build -q -t "${E2E_SIDECAR_IMAGE:-sso-sidecar:e2e}" . >/dev/null

runs=("$@")
[ ${#runs[@]} -gt 0 ] || runs=(sidecar docmost openproject)
status=0
for run in "${runs[@]}"; do
    echo "=== ${run} ==="
    node --test "e2e/${run}.e2e.js" || status=1
done
if [ -z "${E2E_KEEP:-}" ]; then
    kc="${E2E_NETWORK:-sso-e2e}-kc"
    files="$(docker inspect "${kc}" -f '{{index .Config.Labels "e2e.listener-files"}}' 2>/dev/null || true)"
    docker rm -f "${kc}" "${kc}-rights" >/dev/null 2>&1 || true
    case "${files}" in "${TMPDIR:-/tmp}"/sso-e2e-kc-*) rm -rf "${files}" ;; esac
fi
exit "${status}"
