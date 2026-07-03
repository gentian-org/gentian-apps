# Gentian XWiki bundle image

Custom image extending the [Docker Official `library/xwiki`](https://hub.docker.com/_/xwiki)
`postgres-tomcat` variant so a fresh XWiki works **fully offline** on a locked-down
tenant — no Distribution Wizard, no Extension Manager download, no pod egress.

Published as `ghcr.io/gentian-org/xwiki:<IMAGE_TAG>` (see `versions.env`).

## Base

| Component | Version | Source |
|-----------|---------|--------|
| XWiki | 17.10.9 | `docker.io/library/xwiki:17.10.9-postgres-tomcat` |

## What it bundles

| Layer | Version | Purpose | Source |
|-------|---------|---------|--------|
| Standard Flavor (offline XIP) | 17.10.9 | Wiki UI / apps installed on first boot | `xwiki-platform-distribution-flavor-xip` (nexus.xwiki.org) |
| OpenID Connect Authenticator | 2.20.2 | OIDC SSO (`org.xwiki.contrib.oidc.auth.OIDCAuthServiceImpl`) | `org.xwiki.contrib.oidc:oidc-authenticator` (+ deps) |

### 1. Standard Flavor (offline)

The stock image ships **no** flavor: on an empty database the Distribution Wizard
would ask an admin to download one, which is impossible without egress. The
Standard Flavor XIP (an offline extension repository) is baked at
`/opt/gentian/xwiki-flavor.xip`. The wrapper entrypoint
(`docker-entrypoint-gentian.sh`, installed as `/usr/local/bin/docker-entrypoint.sh`)
stages it into the permanent extension repository
(`/usr/local/xwiki/data/extension/repository`) on first boot. The profile's
headless Distribution Job (`distribution.job.interactive=false` +
`distribution.defaultUI`) then installs it **offline**.

Kubernetes does not copy image content into an empty PVC, so staging happens at
runtime and re-runs automatically on any fresh cluster/tenant (empty PVC) — this
is what makes the flavor install reproducible across a **full teardown**. It is a
no-op once staged (marker file `.gentian-flavor-staged`).

The XIP `<version>` **must** equal the base image XWiki version.

### 2. OIDC authenticator (core extensions)

`oidc-authenticator` and its runtime dependencies are all JARs (Nimbus OAuth2
OIDC SDK, the `org.xwiki.contrib.oidc:*` modules — no wiki pages). They are
resolved with Maven at build time and dropped into `WEB-INF/lib` as core
extensions, so the auth class is available at boot with no Extension Manager
step. Jars whose artifactId already ships in the WAR are skipped to avoid
duplicate-jar classloader conflicts.

The profile activates it via `xwiki.cfg` (`xwiki.authentication.authclass`) and
configures it via `xwiki.properties` (`oidc.*`). Because everything is local,
the profile also sets `extension.repositories=` (empty) to stop XWiki from
probing remote extension repositories.

## Not included

- No wiki-page (XAR) extensions and no OIDC admin UI pages — SSO is driven
  entirely by `xwiki.properties`, so the config UI is unnecessary.

## Rebuild

```bash
./images/xwiki/build.sh
# or push via .github/workflows/apps-ci.yaml on merge to main/develop
```

Bump `IMAGE_TAG` in `versions.env` and `profiles/xwiki/profile.yaml` together.
When changing `XWIKI_VERSION`, also refresh `FLAVOR_XIP_SHA256`:

```bash
V=17.10.9
curl -fsSL "https://nexus.xwiki.org/nexus/content/groups/public/org/xwiki/platform/xwiki-platform-distribution-flavor-xip/${V}/xwiki-platform-distribution-flavor-xip-${V}.xip" \
  | sha256sum
```
