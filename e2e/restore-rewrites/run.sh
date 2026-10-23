#!/usr/bin/env bash
# The end-to-end runs for the apps whose data remembers where it ran: each
# app's real image and PostgreSQL 16, its data written under one domain and
# database, put back under another database name, role and credentials and
# another domain, as an import into another cluster puts it back. The
# profile's spec.backup.restore.post commands then run as the platform runs
# them (lib/restore.js), and the run shows the app working on what it has
# here. XWiki, which finds a returning person by the realm's address, is
# signed in to through Keycloak 26.8.0 before and after the move, as the
# sign-out runs sign in (e2e/oidc-sign-out/lib). Needs docker and node, and
# openssl for XWiki.
#
#   e2e/restore-rewrites/run.sh              everything
#   e2e/restore-rewrites/run.sh nextcloud    one of: nextcloud, odoo, open-webui, mathesar, xwiki
#
# Every container and volume it starts is removed again; E2E_KEEP=1 leaves
# them to look at.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

sidecar=images/gentian-sidecar-sso-saml
# The YAML parser.
[ -d "${sidecar}/node_modules" ] || (cd "${sidecar}" && npm ci)

# XWiki runs as the image its profile names. A change that moves that tag has
# not published it yet (pull requests publish nothing), so it is built here.
xwiki_image() {
    [ -z "${E2E_XWIKI_IMAGE:-}" ] || return 0
    local tag
    # shellcheck disable=SC1091
    tag="$(source images/xwiki/versions.env && echo "${IMAGE_TAG}")"
    docker pull -q "ghcr.io/gentian-org/xwiki:${tag}" >/dev/null 2>&1 || images/xwiki/build.sh
}

runs=("$@")
[ ${#runs[@]} -gt 0 ] || runs=(nextcloud odoo open-webui mathesar xwiki)
# The image the realm's public addresses are served from.
case " ${runs[*]} " in
*" xwiki "*)
    docker build -q -t "${E2E_SIDECAR_IMAGE:-sso-sidecar:e2e}" "${sidecar}" >/dev/null
    xwiki_image
    ;;
esac
status=0
for run in "${runs[@]}"; do
    echo "=== ${run} ==="
    node --test "e2e/restore-rewrites/${run}.e2e.js" || status=1
done
if [ -z "${E2E_KEEP:-}" ]; then
    docker network rm "${E2E_RESTORE_NETWORK:-restore-e2e}" >/dev/null 2>&1 || true
    network="${E2E_OIDC_NETWORK:-${E2E_NETWORK:-sso-e2e}-oidc}"
    docker rm -f "${network}-kc" "${network}-idp-tls" "${network}-idp-tls-id.moved.test" >/dev/null 2>&1 || true
    docker network rm "${network}" >/dev/null 2>&1 || true
fi
exit "${status}"
