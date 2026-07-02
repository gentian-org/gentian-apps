# Gentian Nextcloud bundle image

Custom image extending the official [`library/nextcloud`](https://hub.docker.com/_/nextcloud)
Apache variant with Gentian-required apps pre-installed at build time. No runtime
downloads from the Nextcloud App Store or GitHub are needed on tenant clusters.

Published as `ghcr.io/gentian-org/nextcloud:<IMAGE_TAG>` (see `versions.env`).

## Base

| Component | Version | Source |
|-----------|---------|--------|
| Nextcloud Server | 33.0.6 | `docker.io/library/nextcloud:33.0.6-apache` |

## Bundled apps

| App | Version | Purpose | Source |
|-----|---------|---------|--------|
| richdocuments | 10.2.0 | Collabora / Nextcloud Office (document, spreadsheet, presentation) | [nextcloud-releases/richdocuments](https://github.com/nextcloud-releases/richdocuments) |
| user_oidc | 8.10.1 | OIDC SSO (`gentian` provider configured at install hook) | [nextcloud-releases/user_oidc](https://github.com/nextcloud-releases/user_oidc) |

Apps are extracted to `/usr/src/nextcloud/apps/` in the image. On first start (or when
missing on the tenant PVC), profile hooks copy them into `/var/www/html/custom_apps/`
and enable them with `occ app:enable` — no outbound HTTPS from the pod.

## Not included

- **Collabora Online** remains a Helm subchart (`nextcloud-collabora`) deployed beside
  Nextcloud per tenant — it is a separate service, not part of this image.
- Portal SSO assets (`nextcloud-portal-sso.html`, `gentian-portal-bridge.php`) are
  fetched from in-cluster portal-web on pod start (platform-kernel only).

## Rebuild

```bash
./images/nextcloud/build.sh
# or push via .github/workflows/apps-ci.yaml on merge to main/develop
```

Bump `IMAGE_TAG` in `versions.env` and `profiles/nextcloud/profile.yaml` when changing
bundled app versions or the base Nextcloud release.
