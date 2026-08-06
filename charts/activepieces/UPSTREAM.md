# Upstream — activepieces chart

Required for any vendored chart (gentian-os/docs/app-customization.md §2.5). This is
option **(d) vendored copy** on the L4 preference ladder — the most expensive option.
See [../../profiles/activepieces/customizations/nginx-sso-routing.yaml](../../profiles/activepieces/customizations/nginx-sso-routing.yaml)
for the record and the exit path.

## Source

| | |
|---|---|
| Upstream | https://github.com/adnoctem/helm — `charts/activepieces` |
| Vendored at | chart version 0.3.0, 2026-07-14 (`9721490`) |
| Upstream licence | MIT (`org.opencontainers.image.licenses` in `Chart.yaml`) |
| App image | `docker.io/activepieces/activepieces:0.28.0` |

The chart was obtained with `helm pull adnoctem/activepieces --untar`, which is why it
landed at the repo root before being moved under `charts/`.

## Application licensing

The chart deploys Activepieces **Community Edition**. `AP_EDITION` and `AP_LICENSE_KEY`
are deliberately unset — do not add them without a valid key. Activepieces is
dual-licensed and its `ee` packages are not MIT.

A startup patch that forced the enterprise gates on was removed in `c5b0d4f`, together
with a placeholder `AP_LICENSE_KEY`. The same commit added the absolute prohibition to
[docs/app-profile-guide.md](../../docs/app-profile-guide.md). Do not reintroduce it in
any form — not in `files/entrypoint.sh`, not in the profile's `postInstallJob`, not as
a value.

## Delta from upstream

Four changes. Three are generic defects that belong upstream; one is Gentian-specific.

| File | Change | Upstream-able |
|---|---|---|
| `templates/_podSpec.tpl` | `command` / `args` passthrough | yes — plain gap |
| `templates/_podSpec.tpl` | `AP_REDIS_USER` from a value, not a `secretKeyRef` | yes — the username is not a secret and the referenced key does not exist |
| `templates/_podSpec.tpl` | `nindent 10`/`6` instead of `12`/`8` on volumes and volumeMounts | yes — indentation bug, renders invalid YAML |
| `templates/secrets.yaml` | keep encryption/JWT secrets stable across upgrades | yes — regenerating them logs every user out (`369e9e7`) |
| `templates/gentian-runtime-configmap.yaml`, `files/` | Gentian nginx config + entrypoint | no — integration glue |

**None of the upstream-able fixes have been filed yet.** Doing so is the cheapest way
out of vendoring: if they land, this copy collapses to a wrapper chart with upstream as
a dependency and the delta drops to the ConfigMap alone.

## Trim candidates

`charts/postgresql/` and `charts/redis/` are vendored subcharts, both disabled by the
profile (the kernel provides Postgres and Redis). They are roughly two thirds of the
152 files here. Removing them means dropping the corresponding entries from
`Chart.yaml`/`Chart.lock` as well — verify `helm package` and a render before doing it.

## Bumping

1. Re-pull upstream at the new version into a scratch directory.
2. Re-apply the delta above; `files/` and `templates/gentian-runtime-configmap.yaml`
   carry over unchanged.
3. Re-check the two startup patches in `files/entrypoint.sh` against the new image —
   `disableUpgradeBanner` matches a literal string in a **minified** bundle and fails
   silently when upstream rebuilds. Prefer deleting it (see the record's exit criteria).
4. Bump `version:` in `Chart.yaml` and `spec.chart.version` in the profile.
