# Gentian Nextcloud base image.
#
# ONE image, not a bundle chain. The previous build was four cumulative targets
# (base -> office -> officeplus -> suite), each baking more apps into
# /usr/src/nextcloud/apps/ and thereby *enabling* them. That allowed exactly four
# combinations, so a tenant wanting files + calendar but not office could not have it.
#
# Now every optional app is staged in /usr/src/nextcloud/custom_apps/ instead.
# Nextcloud does not run an app merely because it is present — it must be enabled —
# so the same image serves any subset: the addon activation Job runs
# `occ app:enable <id>` for exactly what the tenant selected. The official image's
# entrypoint copies /usr/src/nextcloud into the tenant volume on first start, and
# custom_apps is already registered as a writable apps_path there, so this needs no
# chart change.
#
# user_oidc stays in apps/ and stays enabled: it is platform SSO, not optional.
#
# Build args must match versions.env. See gentian-apps/docs/L3-cleanup.md §4.

ARG NEXTCLOUD_VERSION=33.0.6-apache

FROM docker.io/library/nextcloud:${NEXTCLOUD_VERSION} AS base

USER root

# Platform SSO — always present, always enabled.
ARG USER_OIDC_VERSION=8.10.1

# Optional apps, staged disabled. Selected per tenant via spec.apps[].addons.
ARG RICHDOCUMENTS_VERSION=10.2.0
ARG FORMS_VERSION=5.3.2
ARG MAIL_VERSION=5.10.5
ARG CALENDAR_VERSION=6.5.0
ARG CONTACTS_VERSION=8.7.2
ARG TASKS_VERSION=0.18.1
ARG DECK_VERSION=1.17.4
ARG COLLECTIVES_VERSION=3.5.0
ARG SPREED_VERSION=23.0.8

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    \
    # --- platform SSO: enabled, so it belongs in apps/ ---------------------- \
    curl -fsSL -o /tmp/user_oidc.tar.gz \
      "https://github.com/nextcloud-releases/user_oidc/releases/download/v${USER_OIDC_VERSION}/user_oidc-v${USER_OIDC_VERSION}.tar.gz"; \
    tar -xzf /tmp/user_oidc.tar.gz -C /usr/src/nextcloud/apps/; \
    chown -R www-data:www-data /usr/src/nextcloud/apps/user_oidc; \
    \
    # --- optional apps: staged in custom_apps/, left disabled --------------- \
    mkdir -p /usr/src/nextcloud/custom_apps; \
    fetch_addon() { \
      url="$1"; \
      curl -fsSL -o /tmp/addon.tar.gz "$url"; \
      tar -xzf /tmp/addon.tar.gz -C /usr/src/nextcloud/custom_apps/; \
      rm -f /tmp/addon.tar.gz; \
    }; \
    fetch_addon "https://github.com/nextcloud-releases/richdocuments/releases/download/v${RICHDOCUMENTS_VERSION}/richdocuments-v${RICHDOCUMENTS_VERSION}.tar.gz"; \
    fetch_addon "https://github.com/nextcloud-releases/forms/releases/download/v${FORMS_VERSION}/forms-v${FORMS_VERSION}.tar.gz"; \
    fetch_addon "https://github.com/nextcloud-releases/mail/releases/download/v${MAIL_VERSION}/mail-v${MAIL_VERSION}.tar.gz"; \
    fetch_addon "https://github.com/nextcloud-releases/calendar/releases/download/v${CALENDAR_VERSION}/calendar-v${CALENDAR_VERSION}.tar.gz"; \
    fetch_addon "https://github.com/nextcloud-releases/contacts/releases/download/v${CONTACTS_VERSION}/contacts-v${CONTACTS_VERSION}.tar.gz"; \
    fetch_addon "https://github.com/nextcloud/tasks/releases/download/v${TASKS_VERSION}/tasks.tar.gz"; \
    fetch_addon "https://github.com/nextcloud-releases/deck/releases/download/v${DECK_VERSION}/deck-v${DECK_VERSION}.tar.gz"; \
    fetch_addon "https://github.com/nextcloud/collectives/releases/download/v${COLLECTIVES_VERSION}/collectives-${COLLECTIVES_VERSION}.tar.gz"; \
    fetch_addon "https://github.com/nextcloud-releases/spreed/releases/download/v${SPREED_VERSION}/spreed-v${SPREED_VERSION}.tar.gz"; \
    rm -f /tmp/*.tar.gz; \
    chown -R www-data:www-data /usr/src/nextcloud/custom_apps; \
    \
    # --- Gentian runtime adjustments --------------------------------------- \
    printf '%s\n' 'redis.session.locking_enabled = 0' > /usr/local/etc/php/conf.d/zz-gentian-redis-session.ini; \
    sed -i 's/Listen 80/Listen 8080/' /etc/apache2/ports.conf; \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost \*:8080>/' /etc/apache2/sites-available/000-default.conf; \
    chown -R www-data:www-data /usr/local/etc/php/conf.d; \
    chown -R www-data:www-data /var/run/apache2 /var/log/apache2 /var/lock/apache2 /var/lib/apache2 /etc/apache2

USER www-data

LABEL org.opencontainers.image.title="Gentian Nextcloud" \
      org.opencontainers.image.description="Nextcloud with user_oidc enabled and the Gentian addon set staged (disabled) in custom_apps" \
      org.gentian.nextcloud.base="${NEXTCLOUD_VERSION}" \
      org.gentian.apps.user_oidc="${USER_OIDC_VERSION}" \
      org.gentian.addons.richdocuments="${RICHDOCUMENTS_VERSION}" \
      org.gentian.addons.forms="${FORMS_VERSION}" \
      org.gentian.addons.mail="${MAIL_VERSION}" \
      org.gentian.addons.calendar="${CALENDAR_VERSION}" \
      org.gentian.addons.contacts="${CONTACTS_VERSION}" \
      org.gentian.addons.tasks="${TASKS_VERSION}" \
      org.gentian.addons.deck="${DECK_VERSION}" \
      org.gentian.addons.collectives="${COLLECTIVES_VERSION}" \
      org.gentian.addons.spreed="${SPREED_VERSION}"
