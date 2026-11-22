# The Crafting Apps that run in the browser (WordCraft, GridCraft, DeckCraft,
# PdfCraft) -- one build for each, told apart by the build arguments, which
# images/<app>/versions.env holds.
#
# Upstream publishes no image, but every release carries the browser build as
# static files (<app>-web-<version>.zip). An image serves that build unchanged:
# the app runs in the browser. The release and its checksum are pinned.
#
# What serves it is images/app-host, a small server of this repository that
# other images share; the build is given it as the context named "app-host". Beside the
# build it serves a page that frames the app and four file calls, so that the
# app opens and saves in the tenant's file home as the signed-in person
# (images/app-host/main.go). Without a home it serves the build and nothing else.

FROM docker.io/nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS site
ARG CRAFT_APP
ARG CRAFT_VERSION
ARG CRAFT_WEB_SHA256
USER root
ADD --checksum=sha256:${CRAFT_WEB_SHA256} \
    https://github.com/storytold/${CRAFT_APP}/releases/download/v${CRAFT_VERSION}/${CRAFT_APP}-web-${CRAFT_VERSION}.zip /tmp/web.zip
# The sample header rules are for other hosts; the server sets ours. The
# hashed files are compressed once here and served as they are.
RUN unzip -q /tmp/web.zip -d /tmp \
 && mv "/tmp/${CRAFT_APP}-web-${CRAFT_VERSION}" /site \
 && rm -f /site/.htaccess /site/_headers \
 && test -f /site/index.html \
 && find /site -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.html' \) -exec gzip -9 -k {} + \
 && chmod -R a+rX /site

FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27.3-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9 AS host
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY --from=app-host . .
RUN go test ./... \
 && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /host .

FROM scratch
ARG CRAFT_APP
ARG CRAFT_TITLE
ARG CRAFT_EXTENSIONS
COPY --from=host /host /host
COPY --from=site /site /site
# Which app this is: the name its messages carry, the name a person reads and
# the file name endings it opens.
ENV CRAFT_APP=${CRAFT_APP} \
    CRAFT_TITLE=${CRAFT_TITLE} \
    CRAFT_EXTENSIONS=${CRAFT_EXTENSIONS}
LABEL org.opencontainers.image.title="${CRAFT_TITLE}" \
      org.opencontainers.image.description="The browser build of ${CRAFT_TITLE}, with open and save in the tenant's file home" \
      org.opencontainers.image.source="https://github.com/gentian-org/gentian-apps" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"
USER 101:101
EXPOSE 8080
ENTRYPOINT ["/host"]
