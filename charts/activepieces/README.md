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
| 0005 nginx ConfigMap fronting the app | Gentian integration glue | not-needed |
| 0006 mount the Gentian runtime, own the entrypoint | Gentian integration glue | not-needed |
| 0007 `extraContainers` / `extraInitContainers` | Gentian extension points | no |
| 0008 leave the sign-in routes to the platform; serve the sign-in shim | Gentian integration glue | not-needed |

0001–0003 are genuine upstream defects and should be offered upstream; the
`Forwarded:` header in each patch is the tracking record. 0004–0008 are
Gentian-specific and are expected to stay.

## A patch is a diff, and its numbers count

A hunk header states how many lines follow (`@@ -0,0 +1,155 @@`), and `patch` applies
that many and stops. Lines added to a patch by hand without correcting the header are
dropped without an error: 0005 lost the end of `files/nginx.conf` that way, and nginx
did not start in any chart built from it (0.3.26 and 0.3.27). Change the tree and
regenerate the patch (`diff -ruN`), or count; then run the app's end-to-end test
(`images/gentian-sidecar-sso-saml/e2e/activepieces.e2e.js`), which starts the real
container with the chart's own files.

## Rules

1. Every patch carries DEP-3 headers; `Forwarded:` is not optional.
2. A patch that stops applying on an upstream bump is a decision point, not a
   nuisance — rebase or drop it, don't pin upstream forever to avoid it.
3. Never patch to bypass licence validation or unlock paid features. Activepieces
   gates SSO and appearance behind `AP_LICENSE_KEY`; supply a real key. This is an
   absolute prohibition — see `docs/app-profile-guide.md`.
