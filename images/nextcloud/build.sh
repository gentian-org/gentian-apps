#!/usr/bin/env bash
# Build the Gentian Nextcloud bundle image locally.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/versions.env"

REGISTRY="${REGISTRY:-ghcr.io}"
IMAGE="${REGISTRY}/gentian-org/nextcloud:${IMAGE_TAG}"

docker build \
  --build-arg "NEXTCLOUD_VERSION=${NEXTCLOUD_VERSION}" \
  --build-arg "RICHDOCUMENTS_VERSION=${RICHDOCUMENTS_VERSION}" \
  --build-arg "USER_OIDC_VERSION=${USER_OIDC_VERSION}" \
  -t "${IMAGE}" \
  "${ROOT}"

echo "Built ${IMAGE}"
