#!/usr/bin/env bash
# Build the Gentian Nextcloud bundle images locally.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/versions.env"

REGISTRY="${REGISTRY:-ghcr.io}"

# Build and tag each target edition
build_target() {
  local target="$1"
  local tag_suffix="$2"
  
  # Parse nextcloud version and gentian release suffix from IMAGE_TAG (e.g. 33.0.6-gentian4)
  local v_part="${IMAGE_TAG%%-*}"
  local g_part="${IMAGE_TAG#*-}"
  local image="${REGISTRY}/gentian-org/nextcloud:${v_part}-${tag_suffix}-${g_part}"
  
  echo "Building target [${target}] as [${image}]..."
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
    --target "${target}" \
    -t "${image}" \
    "${ROOT}"
  
  echo "Built ${image}"
}

build_target "base" "base"
build_target "office" "office"
build_target "officeplus" "officeplus"
build_target "suite" "suite"
