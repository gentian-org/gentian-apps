#!/usr/bin/env bash
# Build the Gentian Nextcloud image locally.
#
# One image, not four bundle editions — every optional app is staged disabled in
# custom_apps and enabled per tenant. See the Dockerfile header.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/versions.env"

REGISTRY="${REGISTRY:-ghcr.io}"

build_image() {
  local image="${REGISTRY}/gentian-org/nextcloud:${IMAGE_TAG}"

  echo "Building [${image}]..."
  docker build \
    --build-arg "NEXTCLOUD_VERSION=${NEXTCLOUD_VERSION}" \
    --build-arg "USER_OIDC_VERSION=${USER_OIDC_VERSION}" \
    --build-arg "RICHDOCUMENTS_VERSION=${RICHDOCUMENTS_VERSION}" \
    --build-arg "FORMS_VERSION=${FORMS_VERSION}" \
    --build-arg "MAIL_VERSION=${MAIL_VERSION}" \
    --build-arg "CALENDAR_VERSION=${CALENDAR_VERSION}" \
    --build-arg "CONTACTS_VERSION=${CONTACTS_VERSION}" \
    --build-arg "TASKS_VERSION=${TASKS_VERSION}" \
    --build-arg "DECK_VERSION=${DECK_VERSION}" \
    --build-arg "COLLECTIVES_VERSION=${COLLECTIVES_VERSION}" \
    --build-arg "SPREED_VERSION=${SPREED_VERSION}" \
    -t "${image}" \
    "${ROOT}"

  echo "Built ${image}"
}

build_image
