# activepieces chart — upstream + patch series

Upstream (`adnoctem/helm`) is **not** vendored here. This directory carries the
pinned coordinates ([`UPSTREAM`](UPSTREAM)) and the delta ([`patches/`](patches/)),
in the same shape `ocb` uses for Odoo and Debian uses for source packages.

## Build

```bash
scripts/build-activepieces-chart.sh            # fetch + patch + package
scripts/build-activepieces-chart.sh --render   # also render templates for inspection
```

`helm dependency build` fetches the postgresql/redis subcharts at build time —
they are not committed either, for the same reason.

## The delta

| Patch | Kind | Forwarded |
|---|---|---|
| 0001 encryption secrets regenerated every deploy | upstream bug | not-yet |
| 0002 volumes/volumeMounts indentation | upstream bug | not-yet |
| 0003 Redis username read from a nonexistent secret key | upstream bug | not-yet |
| 0004 `extraEnvVars` / `extraVolumes` / `command` / `hostAliases` | Gentian extension points | no |
| 0005 nginx ConfigMap for portal SSO | Gentian integration glue | not-needed |

0001–0003 are genuine upstream defects and should be offered upstream; the
`Forwarded:` header in each patch is the tracking record. 0004–0005 are
Gentian-specific and are expected to stay.

## Rules

1. Every patch carries DEP-3 headers; `Forwarded:` is not optional.
2. A patch that stops applying on an upstream bump is a decision point, not a
   nuisance — rebase or drop it, don't pin upstream forever to avoid it.
3. Never patch to bypass licence validation or unlock paid features. Activepieces
   gates SSO and appearance behind `AP_LICENSE_KEY`; supply a real key. This is an
   absolute prohibition — see `docs/app-profile-guide.md`.
