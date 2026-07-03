# Gentian XWiki bundle — see BUNDLE.md for contents.
# Build args must match versions.env.
#
# What this image adds to the stock Docker Official xwiki image:
#   1. The Standard Flavor offline repository (XIP), baked at /opt/gentian and
#      staged into the permanent extension repository on first boot by the
#      wrapper entrypoint -> headless, offline flavor install (no Distribution
#      Wizard, no egress).
#   2. The OpenID Connect Authenticator extension + its runtime deps as core
#      extensions in WEB-INF/lib -> OIDC SSO works at boot with no Extension
#      Manager step and no egress.

# Global build args (declared before the first FROM so XWIKI_VERSION can be used
# in the runtime stage's FROM line). Re-declared inside each stage that uses them.
ARG XWIKI_VERSION=17.10.9
ARG OIDC_VERSION=2.20.2

# ---------------------------------------------------------------------------
# Stage 1 — resolve the OIDC authenticator + deps as JARs.
# ---------------------------------------------------------------------------
FROM docker.io/library/maven:3.9-eclipse-temurin-21 AS oidcdeps
ARG OIDC_VERSION
WORKDIR /build
COPY oidc-pom.xml pom.xml
# Copy the OIDC contrib jars + their non-platform deps (Nimbus, etc.). The
# xwiki-platform/commons/rendering subtree is pruned in the pom (already in the
# WAR) and excluded here as well. nexus.xwiki.org occasionally returns transient
# 502s, so retry the whole resolution a few times before giving up.
RUN set -eu; \
    ok=0; \
    for attempt in 1 2 3 4 5; do \
      if mvn -B -Doidc.version="${OIDC_VERSION}" \
           -Dmaven.wagon.http.retryHandler.count=5 \
           -Dmaven.wagon.http.retryHandler.requestSentEnabled=true \
           org.apache.maven.plugins:maven-dependency-plugin:3.8.1:copy-dependencies \
           -DoutputDirectory=/oidc-libs \
           -DincludeScope=runtime \
           -DexcludeGroupIds=org.xwiki.platform,org.xwiki.commons,org.xwiki.rendering; then \
        ok=1; break; \
      fi; \
      echo "[gentian] maven attempt ${attempt} failed (transient nexus.xwiki.org error?); retrying in 20s..."; \
      sleep 20; \
    done; \
    [ "${ok}" = 1 ]; \
    ls -1 /oidc-libs

# ---------------------------------------------------------------------------
# Stage 2 — the runtime image.
# ---------------------------------------------------------------------------
FROM docker.io/library/xwiki:${XWIKI_VERSION}-postgres-tomcat

# Re-declare after FROM so the global values are available in this stage.
ARG XWIKI_VERSION
ARG OIDC_VERSION
ARG FLAVOR_XIP_SHA256

USER root

ENV WEBINF_LIB="/usr/local/tomcat/webapps/ROOT/WEB-INF/lib"

# --- 1) Bake the Standard Flavor offline repository (XIP) ---
# curl and unzip are already present in the stock image.
RUN set -eux; \
    mkdir -p /opt/gentian; \
    curl -fSL \
      "https://nexus.xwiki.org/nexus/content/groups/public/org/xwiki/platform/xwiki-platform-distribution-flavor-xip/${XWIKI_VERSION}/xwiki-platform-distribution-flavor-xip-${XWIKI_VERSION}.xip" \
      -o /opt/gentian/xwiki-flavor.xip; \
    echo "${FLAVOR_XIP_SHA256}  /opt/gentian/xwiki-flavor.xip" | sha256sum -c -

# --- 2) Bundle the OIDC authenticator + deps as core extensions ---
# Only add jars whose artifactId is not already shipped in the WAR (the version
# in the WAR is authoritative for shared libs); this avoids duplicate-jar
# classloader conflicts. artifactId is derived by stripping the -<version>.jar
# suffix.
COPY --from=oidcdeps /oidc-libs /tmp/oidc-libs
RUN set -eux; \
    for f in "${WEBINF_LIB}"/*.jar; do \
      basename "$f" | sed -E 's/-[0-9][^/]*\.jar$/.jar/'; \
    done | sort -u > /tmp/existing-artifacts.txt; \
    added=0; skipped=0; \
    for f in /tmp/oidc-libs/*.jar; do \
      b="$(basename "$f" | sed -E 's/-[0-9][^/]*\.jar$/.jar/')"; \
      if grep -qxF "$b" /tmp/existing-artifacts.txt; then \
        echo "skip (already in WAR): $(basename "$f")"; skipped=$((skipped+1)); \
      else \
        cp "$f" "${WEBINF_LIB}/"; echo "add: $(basename "$f")"; added=$((added+1)); \
      fi; \
    done; \
    echo "OIDC core extensions: added=${added} skipped=${skipped}"; \
    test "${added}" -ge 1; \
    ls -1 "${WEBINF_LIB}" | grep -iE 'oidc|oauth2-oidc-sdk' || (echo "ERROR: oidc jars not bundled" >&2; exit 1); \
    rm -rf /tmp/oidc-libs /tmp/existing-artifacts.txt

# --- 3) Install the wrapper entrypoint (stages the flavor on first boot) ---
# The chart calls /usr/local/bin/docker-entrypoint.sh (both `source` and `exec`);
# we shim it and delegate to the renamed stock entrypoint.
COPY docker-entrypoint-gentian.sh /usr/local/bin/docker-entrypoint-gentian.sh
RUN set -eux; \
    mv /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint-xwiki.sh; \
    cp /usr/local/bin/docker-entrypoint-gentian.sh /usr/local/bin/docker-entrypoint.sh; \
    chmod 0755 /usr/local/bin/docker-entrypoint.sh /usr/local/bin/docker-entrypoint-xwiki.sh

LABEL org.opencontainers.image.title="Gentian XWiki" \
      org.opencontainers.image.description="XWiki with the Standard Flavor (offline XIP) and OIDC authenticator bundled for locked-down Gentian tenants" \
      org.gentian.xwiki.base="${XWIKI_VERSION}-postgres-tomcat" \
      org.gentian.xwiki.flavor="${XWIKI_VERSION}" \
      org.gentian.xwiki.oidc="${OIDC_VERSION}"
