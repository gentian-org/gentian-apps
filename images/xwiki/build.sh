#!/usr/bin/env bash
# Build the Gentian XWiki bundle image locally.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck disable=SC1091
source "${ROOT}/versions.env"

REGISTRY="${REGISTRY:-ghcr.io}"
IMAGE="${REGISTRY}/gentian-org/xwiki:${IMAGE_TAG}"

docker build \
  --build-arg "XWIKI_VERSION=${XWIKI_VERSION}" \
  --build-arg "FLAVOR_XIP_SHA256=${FLAVOR_XIP_SHA256}" \
  --build-arg "OIDC_VERSION=${OIDC_VERSION}" \
  -t "${IMAGE}" \
  "${ROOT}"

echo "Built ${IMAGE}"
