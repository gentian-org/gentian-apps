# Drop-in configuration (rung L1)

Fragments here are merged into the app's runtime configuration in **lexicographic
order**, exactly like systemd's `*.conf.d`. Later files win.

| Prefix | Owner | Set by |
|---|---|---|
| `00-`–`49-` | platform | `gentian-os` kernel defaults |
| `50-`–`89-` | profile | catalogue maintainer, `profiles/<n>/dropins/` |
| `90-`–`99-` | tenant | tenant admin, via `Tenant.spec.apps[].config.dropIns` or the Admin Console |

The operator enforces the range on write, so a tenant cannot claim a `50-` file and
silently outrank the profile.

## What belongs here

Feature configuration: defaults, labels, toggles, locale bundles, branding assets.

## What does not

**Security-relevant settings and secrets.** `auth_disabled`, `cors_origins` and every
credential come from `Settings` (environment, ESO-injected) and are deliberately not
readable from drop-ins — content mounted here lands in a ConfigMap, is visible in the
Admin Console, and is writable by tenant admins for `tenantEditable` entries.

## Verifying

```bash
curl -s localhost:8000/api/v1/extensions | jq .dropIns
```
