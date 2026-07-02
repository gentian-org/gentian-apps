# Gentian Nextcloud bundle — see BUNDLE.md for contents.
# Build args must match versions.env.

ARG NEXTCLOUD_VERSION=33.0.6-apache
FROM docker.io/library/nextcloud:${NEXTCLOUD_VERSION}

USER root

ARG RICHDOCUMENTS_VERSION=10.2.0
ARG USER_OIDC_VERSION=8.10.1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL -o /tmp/richdocuments.tar.gz \
      "https://github.com/nextcloud-releases/richdocuments/releases/download/v${RICHDOCUMENTS_VERSION}/richdocuments-v${RICHDOCUMENTS_VERSION}.tar.gz"; \
    tar -xzf /tmp/richdocuments.tar.gz -C /usr/src/nextcloud/apps/; \
    curl -fsSL -o /tmp/user_oidc.tar.gz \
      "https://github.com/nextcloud-releases/user_oidc/releases/download/v${USER_OIDC_VERSION}/user_oidc-v${USER_OIDC_VERSION}.tar.gz"; \
    tar -xzf /tmp/user_oidc.tar.gz -C /usr/src/nextcloud/apps/; \
    rm -f /tmp/*.tar.gz; \
    chown -R www-data:www-data \
      /usr/src/nextcloud/apps/richdocuments \
      /usr/src/nextcloud/apps/user_oidc

LABEL org.opencontainers.image.title="Gentian Nextcloud" \
      org.opencontainers.image.description="Nextcloud with richdocuments and user_oidc bundled for Gentian tenants" \
      org.gentian.nextcloud.base="${NEXTCLOUD_VERSION}" \
      org.gentian.apps.richdocuments="${RICHDOCUMENTS_VERSION}" \
      org.gentian.apps.user_oidc="${USER_OIDC_VERSION}"
