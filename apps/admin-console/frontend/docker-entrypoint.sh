#!/bin/sh
# Assemble the served document root at container start, injecting the runtime
# configuration that must not be baked into the image.
#
# Why configuration arrives at run time
# -------------------------------------
# Vite substitutes import.meta.env.VITE_* at BUILD time, so anything passed as
# a build argument is frozen into the JavaScript bundle. One image is published
# and deployed to every cluster, so a baked-in value can only ever be right for
# the cluster that built it. Configuration therefore comes from the environment
# at container start, and the image is identical everywhere.
#
# Why it copies the document root
# -------------------------------
# The pod runs with readOnlyRootFilesystem, so /app/dist cannot be written to.
# The static files are copied once into a writable emptyDir and config.js is
# generated beside them. index.html loads /config.js as a classic script BEFORE
# the module bundle, so window.__GENTIAN_CONFIG__ exists before any application
# code reads it.
set -eu

SRC_DIR="${GENTIAN_SRC_DIR:-/app/dist}"
WWW_DIR="${GENTIAN_WWW_DIR:-/app/www}"
CONFIG_PATH="${WWW_DIR}/config.js"

# Refuse to start rather than serve a bundle that cannot authenticate. An
# empty issuer under pkce degrades into screens that look like an identity
# provider fault; failing here points at the cause. Under edge the Gateway
# holds the session and the bundle needs no issuer of its own.
if [ -z "${OIDC_ISSUER:-}" ] && [ "${AUTH_DISABLED:-false}" != "true" ] && [ "${AUTH_MODE:-pkce}" != "edge" ]; then
    echo "FATAL: OIDC_ISSUER is unset, AUTH_DISABLED is not true, and AUTH_MODE is not edge." >&2
    echo "       Under pkce set OIDC_ISSUER to https://id.<kernel-domain>/auth/realms/<realm>." >&2
    exit 1
fi

if [ ! -d "${WWW_DIR}" ]; then
    echo "FATAL: ${WWW_DIR} does not exist. The Deployment must mount a writable volume there." >&2
    exit 1
fi

# Every step is checked explicitly. A failed redirect does not trip set -e on
# its own, and the failure mode of an unwritten config.js is silent: the SPA
# requests it, the single-page rewrite answers with index.html at 200, and the
# app runs with no configuration at all.
cp -R "${SRC_DIR}/." "${WWW_DIR}/" || {
    echo "FATAL: could not populate ${WWW_DIR} from ${SRC_DIR}" >&2
    exit 1
}

# A JSON string literal for an arbitrary shell value, so a quote or backslash
# in an environment variable cannot break out of the literal and become script.
json_escape() {
    printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' -e 's/\r//g'
}

emit() {
    printf '  %s: "%s",\n' "$1" "$(json_escape "$2")"
}

{
    echo '// GENERATED AT CONTAINER START by docker-entrypoint.sh. Do not edit.'
    echo '// Values come from the environment, never from the image build.'
    echo 'window.__GENTIAN_CONFIG__ = {'
    emit 'oidcIssuer'   "${OIDC_ISSUER:-}"
    emit 'oidcClientId' "${OIDC_CLIENT_ID:-}"
    emit 'oidcScopes'   "${OIDC_SCOPES:-openid profile email}"
    emit 'authDisabled' "${AUTH_DISABLED:-false}"
    emit 'authMode'     "${AUTH_MODE:-pkce}"
    emit 'kernelDomain' "${KERNEL_DOMAIN:-}"
    echo '};'
} > "${CONFIG_PATH}" || {
    echo "FATAL: could not write ${CONFIG_PATH}" >&2
    exit 1
}

if [ ! -s "${CONFIG_PATH}" ] || ! grep -q '__GENTIAN_CONFIG__' "${CONFIG_PATH}"; then
    echo "FATAL: ${CONFIG_PATH} is missing, empty, or does not define window.__GENTIAN_CONFIG__." >&2
    exit 1
fi

echo "runtime config written to ${CONFIG_PATH} (authMode=${AUTH_MODE:-pkce}, issuer=${OIDC_ISSUER:-<none>})"
exec "$@"
