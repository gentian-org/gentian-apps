#!/usr/bin/env bash
# The end-to-end runs for apps that sign people in themselves (OIDC): each
# app's real image against Keycloak 26.8.0, with the client and the sign-out
# address the platform would register from the app's profile. A person signs
# in, signs out at Keycloak, and the app's session is over. Needs docker,
# node and openssl.
#
#   e2e/oidc-sign-out/run.sh              everything
#   e2e/oidc-sign-out/run.sh nextcloud    one of: nextcloud, xwiki
#
# Every container it starts is removed again; E2E_KEEP=1 leaves the apps'
# to look at.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

sidecar=images/gentian-sidecar-sso-saml
# The YAML parser, and the image the run's small relays are started from.
[ -d "${sidecar}/node_modules" ] || (cd "${sidecar}" && npm ci)
docker build -q -t "${E2E_SIDECAR_IMAGE:-sso-sidecar:e2e}" "${sidecar}" >/dev/null

runs=("$@")
[ ${#runs[@]} -gt 0 ] || runs=(nextcloud xwiki)
status=0
for run in "${runs[@]}"; do
    echo "=== ${run} ==="
    node --test "e2e/oidc-sign-out/${run}.e2e.js" || status=1
done
if [ -z "${E2E_KEEP:-}" ]; then
    network="${E2E_OIDC_NETWORK:-${E2E_NETWORK:-sso-e2e}-oidc}"
    docker rm -f "${network}-kc" "${network}-idp-tls" >/dev/null 2>&1 || true
    docker network rm "${network}" >/dev/null 2>&1 || true
fi
exit "${status}"
