#!/usr/bin/env bash
# The end-to-end runs: the sidecar built from this directory against Keycloak
# 26.8.0, and against Docmost, Activepieces and OpenProject at the versions the
# catalogue pins, each with its profile's own handler. Needs docker, node and
# helm.
#
#   e2e/run.sh                 everything
#   e2e/run.sh docmost         one of: sidecar, docmost, activepieces, openproject
#
# Every container it starts is removed again; E2E_KEEP=1 leaves them to look at.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."

[ -d node_modules ] || npm ci
docker build -q -t "${E2E_SIDECAR_IMAGE:-sso-sidecar:e2e}" . >/dev/null

runs=("$@")
[ ${#runs[@]} -gt 0 ] || runs=(sidecar docmost activepieces openproject)
status=0
for run in "${runs[@]}"; do
    echo "=== ${run} ==="
    node --test "e2e/${run}.e2e.js" || status=1
done
[ -n "${E2E_KEEP:-}" ] || docker rm -f "${E2E_NETWORK:-sso-e2e}-kc" >/dev/null 2>&1 || true
exit "${status}"
