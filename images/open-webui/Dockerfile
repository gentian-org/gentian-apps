# Gentian Open WebUI image: the upstream slim image with its frontend rebuilt
# from the same release plus the patches in patches/. The backend, its Python
# environment and everything else in the image are upstream's, unchanged.
#
# Why: after a sign-out, Open WebUI kept the token the server had revoked and
# either stopped on "invalid token" or bounced between / and /auth until the
# page froze (gentian-apps#306). The patch belongs upstream; this image carries
# it until a release does.
#
# Build args must match versions.env. The runtime FROM below names the same
# release; both digests are pinned.

ARG OPEN_WEBUI_VERSION=0.10.2
ARG OPEN_WEBUI_COMMIT=ecd48e2f718220a6400ecf49eafd4867a38feb10

# Stage 1: the frontend, built the way upstream's Dockerfile builds it.
FROM --platform=$BUILDPLATFORM docker.io/library/node:22-alpine3.20@sha256:2289fb1fba0f4633b08ec47b94a89c7e20b829fc5679f9b7b298eaa2f1ed8b7e AS build
ARG OPEN_WEBUI_VERSION
ARG OPEN_WEBUI_COMMIT
WORKDIR /app
RUN apk add --no-cache git
RUN git clone --depth 1 --branch "v${OPEN_WEBUI_VERSION}" https://github.com/open-webui/open-webui.git . \
    && test "$(git rev-parse HEAD)" = "${OPEN_WEBUI_COMMIT}"
RUN npm ci --force
COPY patches /patches
# The series in order; a patch that does not apply fails the build, which is
# what makes a version bump re-validate every patch.
RUN set -eu; while read -r patch; do \
      [ -n "$patch" ] || continue; \
      git apply --verbose "/patches/$patch"; \
    done < /patches/series
ENV APP_BUILD_HASH=${OPEN_WEBUI_COMMIT}
RUN npm run build

# Stage 2: upstream's image, with the rebuilt frontend in place of its own.
FROM ghcr.io/open-webui/open-webui:0.10.2-slim@sha256:f03f7fcdaf5e3381b3d505c0e66f2bf4e82d1918082022b85dee7da1299b6efd
RUN rm -rf /app/build
COPY --from=build /app/build /app/build
