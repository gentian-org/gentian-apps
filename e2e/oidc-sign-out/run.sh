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

# An app built here runs as the image this tree builds, images/<name> at its
# IMAGE_TAG, whatever develop build its profile names: the run is of this
# change. That tag is published by a release only, so it is built here unless
# it can be pulled; the tests are told which image through E2E_<NAME>_IMAGE.
built_image() {
    local tag ref var
    var="E2E_$(echo "$1" | tr '[:lower:]' '[:upper:]')_IMAGE"
    [ -z "${!var:-}" ] || return 0
    # shellcheck disable=SC1090
    tag="$(source "images/$1/versions.env" && echo "${IMAGE_TAG}")"
    ref="ghcr.io/gentian-org/$1:${tag}"
    docker pull -q "${ref}" >/dev/null 2>&1 || "images/$1/build.sh"
    export "${var}=${ref}"
}

runs=("$@")
[ ${#runs[@]} -gt 0 ] || runs=(nextcloud xwiki)
case " ${runs[*]} " in *" xwiki "*) built_image xwiki ;; esac
case " ${runs[*]} " in *" nextcloud "*) built_image nextcloud ;; esac
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
