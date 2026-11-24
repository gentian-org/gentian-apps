# MailCraft's browser build, for a tenant whose mail is on a JMAP mail server
# outside the cluster (mail.serviceMode external, such as Stalwart).
#
# Upstream (UCS-Care-Group/mailcraft, MIT OR Apache-2.0) publishes no image,
# but every release carries the browser build as static files
# (mailcraft-web-<version>.zip). This image serves that build unchanged; the
# release and its checksum are pinned in versions.env.
#
# What serves it is images/app-host in jmap mode, given as the context named
# "app-host": the app at the root, with one script put first in its entry
# page that names the person's account at the mail server and hands the app
# the person's token on each of its jobs. The app then reads and sends mail
# with that server directly. Without a mail server named, the app starts as
# upstream ships it.

FROM docker.io/nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS site
ARG MAILCRAFT_VERSION
ARG MAILCRAFT_WEB_SHA256
USER root
ADD --checksum=sha256:${MAILCRAFT_WEB_SHA256} \
    https://github.com/UCS-Care-Group/mailcraft/releases/download/v${MAILCRAFT_VERSION}/mailcraft-web-${MAILCRAFT_VERSION}.zip /tmp/web.zip
# The sample header rules are for other hosts; the server sets ours. The
# hashed files are compressed once here and served as they are.
RUN unzip -q /tmp/web.zip -d /tmp \
 && mv "/tmp/mailcraft-web-${MAILCRAFT_VERSION}" /site \
 && rm -f /site/.htaccess /site/_headers \
 && test -f /site/index.html \
 && find /site -type f \( -name '*.wasm' -o -name '*.js' \) -exec gzip -9 -k {} + \
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
ENV CRAFT_MODE=jmap \
    CRAFT_APP=mailcraft \
    CRAFT_TITLE=MailCraft
LABEL org.opencontainers.image.title="MailCraft" \
      org.opencontainers.image.description="The browser build of MailCraft, signed in at the workspace's JMAP mail server as the person at the page" \
      org.opencontainers.image.source="https://github.com/gentian-org/gentian-apps" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"
USER 101:101
EXPOSE 8080
ENTRYPOINT ["/host"]
