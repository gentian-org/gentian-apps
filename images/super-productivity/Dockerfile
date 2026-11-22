# Super Productivity's web build, with sync to the tenant's file home.
#
# Upstream's image serves the web build with nginx. This one serves the same
# files, taken from upstream's image by its digest and unchanged, with
# images/app-host in relay mode: the app at the root, and under /webdav/ a
# WebDAV relay into the folder "Super Productivity" of the signed-in person's
# files at the tenant's home. The app is told so in its default settings
# (sync-settings.json, served where it reads them), so its WebDAV sync points
# here. Without a home the relay answers nothing and the app is as upstream
# ships it.

ARG SP_IMAGE
FROM ${SP_IMAGE} AS upstream

FROM docker.io/library/alpine:3.22@sha256:49340b346798875b5592e5d420241f2f9cfba5f47e62ebb1446a1b34734e898f AS site
COPY --from=upstream /usr/share/nginx/html /site
# The source maps are for upstream's debugging and are not served. The rest
# is compressed once here and served as it is.
RUN find /site -name '*.map' -delete \
 && test -f /site/index.html \
 && find /site -type f \( -name '*.js' -o -name '*.css' -o -name '*.html' -o -name '*.json' -o -name '*.svg' \) -exec gzip -9 -k {} + \
 && chmod -R a+rX /site

FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27.3-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9 AS host
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY --from=app-host . .
RUN go test ./... \
 && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /host .

FROM scratch
COPY --from=host /host /host
COPY --from=site /site /site
COPY sync-settings.json /etc/app-host/sync-settings.json
ENV CRAFT_MODE=relay \
    CRAFT_APP=super-productivity \
    CRAFT_TITLE="Super Productivity" \
    CRAFT_DAV_FOLDER="Super Productivity" \
    CRAFT_SETTINGS_PATH=/assets/sync-config-default-override.json \
    CRAFT_SETTINGS_TEMPLATE=/etc/app-host/sync-settings.json
LABEL org.opencontainers.image.title="Super Productivity" \
      org.opencontainers.image.description="The web build of Super Productivity, with WebDAV sync to the tenant's file home" \
      org.opencontainers.image.source="https://github.com/gentian-org/gentian-apps" \
      org.opencontainers.image.licenses="MIT"
USER 101:101
EXPOSE 8080
ENTRYPOINT ["/host"]
