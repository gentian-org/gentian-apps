# WordCraft (word processor, WebAssembly) -- see profiles/wordcraft/wordcraft-ce/profile.yaml.
#
# Upstream publishes no image, but every release carries the browser build as
# static files (wordcraft-web-<version>.zip). This image serves that build
# unchanged from unprivileged nginx: the app runs in the browser, the pod runs
# no application code. The release and its checksum are pinned in versions.env.

FROM docker.io/nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6 AS site
ARG WORDCRAFT_VERSION
ARG WORDCRAFT_WEB_SHA256
USER root
ADD --checksum=sha256:${WORDCRAFT_WEB_SHA256} \
    https://github.com/storytold/wordcraft/releases/download/v${WORDCRAFT_VERSION}/wordcraft-web-${WORDCRAFT_VERSION}.zip /tmp/web.zip
# The sample header rules are for other hosts; nginx.conf sets ours. The
# hashed files are compressed once here and served by gzip_static.
RUN unzip -q /tmp/web.zip -d /tmp \
 && mv "/tmp/wordcraft-web-${WORDCRAFT_VERSION}" /site \
 && rm -f /site/.htaccess /site/_headers \
 && test -f /site/index.html \
 && find /site -type f \( -name '*.wasm' -o -name '*.js' -o -name '*.html' \) -exec gzip -9 -k {} + \
 && chmod -R a+rX /site

FROM docker.io/nginxinc/nginx-unprivileged:1.29-alpine@sha256:0c79d56aee561a1d81c63f00eee5fb5fe29279560cdc55e91425133104c7fbe6
COPY nginx.conf /etc/nginx/conf.d/default.conf
COPY --from=site /site /usr/share/nginx/html
LABEL org.opencontainers.image.title="WordCraft" \
      org.opencontainers.image.description="The WordCraft word processor's browser build, served as static files" \
      org.opencontainers.image.source="https://github.com/storytold/wordcraft" \
      org.opencontainers.image.licenses="MIT OR Apache-2.0"
EXPOSE 8080
