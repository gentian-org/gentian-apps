# WordCraft (word processor, WebAssembly) -- see profiles/wordcraft/wordcraft-ce/profile.yaml.
#
# Upstream publishes no image, but every release carries the browser build as
# static files (wordcraft-web-<version>.zip). This image serves that build
# unchanged: the app runs in the browser. The release and its checksum are
# pinned in versions.env.
#
# What serves it is host/, a small server of this repository. Beside the
# build it serves a page that frames the app and four file calls, so that the
# app opens and saves in the tenant's file home as the signed-in person
# (host/main.go). Without a home it serves the build and nothing else.

FROM docker.io/nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS site
ARG WORDCRAFT_VERSION
ARG WORDCRAFT_WEB_SHA256
USER root
ADD --checksum=sha256:${WORDCRAFT_WEB_SHA256} \
    https://github.com/storytold/wordcraft/releases/download/v${WORDCRAFT_VERSION}/wordcraft-web-${WORDCRAFT_VERSION}.zip /tmp/web.zip
# The sample header rules are for other hosts; the server sets ours. The
# hashed files are compressed once here and served as they are.
RUN unzip -q /tmp/web.zip -d /tmp \
 && mv "/tmp/wordcraft-web-${WORDCRAFT_VERSION}" /site \
 && rm -f /site/.htaccess /site/_headers \
 && test -f /site/index.html \
 && find /site -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.html' \) -exec gzip -9 -k {} + \
 && chmod -R a+rX /site

FROM --platform=$BUILDPLATFORM docker.io/library/golang:1.27.3-bookworm@sha256:d9b6a1beb9474adc2a1ce842573639b44b2a0dd49b6669f51d3821baf9ec37c9 AS host
ARG TARGETOS
ARG TARGETARCH
WORKDIR /src
COPY host/ .
RUN go test ./... \
 && CGO_ENABLED=0 GOOS=${TARGETOS} GOARCH=${TARGETARCH} go build -trimpath -ldflags="-s -w" -o /host .

FROM scratch
COPY --from=host /host /host
COPY --from=site /site /site
LABEL org.opencontainers.image.title="WordCraft" \
      org.opencontainers.image.description="The WordCraft word processor's browser build, with open and save in the tenant's file home" \
      org.opencontainers.image.source="https://github.com/gentian-org/gentian-apps" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"
USER 101:101
EXPOSE 8080
ENTRYPOINT ["/host"]
