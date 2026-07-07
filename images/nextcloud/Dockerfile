# Gentian Nextcloud bundle images.
# Build args must match versions.env.

ARG NEXTCLOUD_VERSION=33.0.6-apache

# ==============================================================================
# 1. BASE TARGET
# ==============================================================================
FROM docker.io/library/nextcloud:${NEXTCLOUD_VERSION} AS base

USER root

ARG USER_OIDC_VERSION=8.10.1

RUN set -eux; \
    apt-get update; \
    apt-get install -y --no-install-recommends ca-certificates curl; \
    rm -rf /var/lib/apt/lists/*; \
    curl -fsSL -o /tmp/user_oidc.tar.gz \
      "https://github.com/nextcloud-releases/user_oidc/releases/download/v${USER_OIDC_VERSION}/user_oidc-v${USER_OIDC_VERSION}.tar.gz"; \
    tar -xzf /tmp/user_oidc.tar.gz -C /usr/src/nextcloud/apps/; \
    rm -f /tmp/*.tar.gz; \
    chown -R www-data:www-data /usr/src/nextcloud/apps/user_oidc; \
    printf '%s\n' 'redis.session.locking_enabled = 0' > /usr/local/etc/php/conf.d/zz-gentian-redis-session.ini; \
    sed -i 's/Listen 80/Listen 8080/' /etc/apache2/ports.conf; \
    sed -i 's/<VirtualHost \*:80>/<VirtualHost \*:8080>/' /etc/apache2/sites-available/000-default.conf; \
    chown -R www-data:www-data /usr/local/etc/php/conf.d; \
    chown -R www-data:www-data /var/run/apache2 /var/log/apache2 /var/lock/apache2 /var/lib/apache2 /etc/apache2

USER www-data

LABEL org.opencontainers.image.title="Gentian Nextcloud Base" \
      org.opencontainers.image.description="Nextcloud with user_oidc bundled for Gentian tenants" \
      org.gentian.nextcloud.base="${NEXTCLOUD_VERSION}" \
      org.gentian.apps.user_oidc="${USER_OIDC_VERSION}"

# ==============================================================================
# 2. OFFICE TARGET
# ==============================================================================
FROM base AS office

USER root

ARG RICHDOCUMENTS_VERSION=10.2.0
ARG FORMS_VERSION=4.3.0

RUN set -eux; \
    curl -fsSL -o /tmp/richdocuments.tar.gz \
      "https://github.com/nextcloud-releases/richdocuments/releases/download/v${RICHDOCUMENTS_VERSION}/richdocuments-v${RICHDOCUMENTS_VERSION}.tar.gz"; \
    tar -xzf /tmp/richdocuments.tar.gz -C /usr/src/nextcloud/apps/; \
    curl -fsSL -o /tmp/forms.tar.gz \
      "https://github.com/nextcloud-releases/forms/releases/download/v${FORMS_VERSION}/forms-v${FORMS_VERSION}.tar.gz"; \
    tar -xzf /tmp/forms.tar.gz -C /usr/src/nextcloud/apps/; \
    rm -f /tmp/*.tar.gz; \
    chown -R www-data:www-data \
      /usr/src/nextcloud/apps/richdocuments \
      /usr/src/nextcloud/apps/forms

USER www-data

LABEL org.opencontainers.image.title="Gentian Nextcloud Office" \
      org.opencontainers.image.description="Nextcloud Office bundle with user_oidc, richdocuments and forms" \
      org.gentian.apps.richdocuments="${RICHDOCUMENTS_VERSION}" \
      org.gentian.apps.forms="${FORMS_VERSION}"

# ==============================================================================
# 3. OFFICE+ TARGET
# ==============================================================================
FROM office AS officeplus

USER root

ARG MAIL_VERSION=5.10.5
ARG CALENDAR_VERSION=6.5.0
ARG CONTACTS_VERSION=8.7.2
ARG TASKS_VERSION=0.18.1

RUN set -eux; \
    curl -fsSL -o /tmp/mail.tar.gz \
      "https://github.com/nextcloud-releases/mail/releases/download/v${MAIL_VERSION}/mail-v${MAIL_VERSION}.tar.gz"; \
    tar -xzf /tmp/mail.tar.gz -C /usr/src/nextcloud/apps/; \
    curl -fsSL -o /tmp/calendar.tar.gz \
      "https://github.com/nextcloud-releases/calendar/releases/download/v${CALENDAR_VERSION}/calendar-v${CALENDAR_VERSION}.tar.gz"; \
    tar -xzf /tmp/calendar.tar.gz -C /usr/src/nextcloud/apps/; \
    curl -fsSL -o /tmp/contacts.tar.gz \
      "https://github.com/nextcloud-releases/contacts/releases/download/v${CONTACTS_VERSION}/contacts-v${CONTACTS_VERSION}.tar.gz"; \
    tar -xzf /tmp/contacts.tar.gz -C /usr/src/nextcloud/apps/; \
    curl -fsSL -o /tmp/tasks.tar.gz \
      "https://github.com/nextcloud/tasks/releases/download/v${TASKS_VERSION}/tasks.tar.gz"; \
    tar -xzf /tmp/tasks.tar.gz -C /usr/src/nextcloud/apps/; \
    rm -f /tmp/*.tar.gz; \
    chown -R www-data:www-data \
      /usr/src/nextcloud/apps/mail \
      /usr/src/nextcloud/apps/calendar \
      /usr/src/nextcloud/apps/contacts \
      /usr/src/nextcloud/apps/tasks

USER www-data

LABEL org.opencontainers.image.title="Gentian Nextcloud Office+" \
      org.opencontainers.image.description="Nextcloud Office+ bundle with mail, calendar, contacts and tasks" \
      org.gentian.apps.mail="${MAIL_VERSION}" \
      org.gentian.apps.calendar="${CALENDAR_VERSION}" \
      org.gentian.apps.contacts="${CONTACTS_VERSION}" \
      org.gentian.apps.tasks="${TASKS_VERSION}"

# ==============================================================================
# 4. SUITE TARGET
# ==============================================================================
FROM officeplus AS suite

USER root

ARG DECK_VERSION=1.13.2
ARG COLLECTIVES_VERSION=3.2.0
ARG SPREED_VERSION=21.0.3

RUN set -eux; \
    curl -fsSL -o /tmp/deck.tar.gz \
      "https://github.com/nextcloud-releases/deck/releases/download/v${DECK_VERSION}/deck-v${DECK_VERSION}.tar.gz"; \
    tar -xzf /tmp/deck.tar.gz -C /usr/src/nextcloud/apps/; \
    curl -fsSL -o /tmp/collectives.tar.gz \
      "https://github.com/nextcloud/collectives/releases/download/v${COLLECTIVES_VERSION}/collectives-${COLLECTIVES_VERSION}.tar.gz"; \
    tar -xzf /tmp/collectives.tar.gz -C /usr/src/nextcloud/apps/; \
    curl -fsSL -o /tmp/spreed.tar.gz \
      "https://github.com/nextcloud-releases/spreed/releases/download/v${SPREED_VERSION}/spreed-v${SPREED_VERSION}.tar.gz"; \
    tar -xzf /tmp/spreed.tar.gz -C /usr/src/nextcloud/apps/; \
    rm -f /tmp/*.tar.gz; \
    chown -R www-data:www-data \
      /usr/src/nextcloud/apps/deck \
      /usr/src/nextcloud/apps/collectives \
      /usr/src/nextcloud/apps/spreed

USER www-data

LABEL org.opencontainers.image.title="Gentian Nextcloud Suite" \
      org.opencontainers.image.description="Nextcloud Suite bundle with deck, collectives and spreed (Talk)" \
      org.gentian.apps.deck="${DECK_VERSION}" \
      org.gentian.apps.collectives="${COLLECTIVES_VERSION}" \
      org.gentian.apps.spreed="${SPREED_VERSION}"
