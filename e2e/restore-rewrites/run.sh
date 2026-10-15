#!/usr/bin/env bash
# The end-to-end runs for the apps whose data remembers where it ran: each
# app's real image and PostgreSQL 16, its data written under one domain and
# database, put back under another database name, role and credentials and
# another domain, as an import into another cluster puts it back. The
# profile's spec.backup.restore.post commands then run as the platform runs
# them (lib/restore.js), and the run shows the app working on what it has
# here. Needs docker and node.
#
#   e2e/restore-rewrites/run.sh              everything
#   e2e/restore-rewrites/run.sh nextcloud    one of: nextcloud, odoo, open-webui
#
# Every container and volume it starts is removed again; E2E_KEEP=1 leaves
# them to look at.
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/../.."

sidecar=images/gentian-sidecar-sso-saml
# The YAML parser.
[ -d "${sidecar}/node_modules" ] || (cd "${sidecar}" && npm ci)

runs=("$@")
[ ${#runs[@]} -gt 0 ] || runs=(nextcloud odoo open-webui)
status=0
for run in "${runs[@]}"; do
    echo "=== ${run} ==="
    node --test "e2e/restore-rewrites/${run}.e2e.js" || status=1
done
if [ -z "${E2E_KEEP:-}" ]; then
    docker network rm "${E2E_RESTORE_NETWORK:-restore-e2e}" >/dev/null 2>&1 || true
fi
exit "${status}"
