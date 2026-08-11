# Customization ladder — Mathesar (family `mathesar-ce`)

**Grade: D** · rubric score **2/8** · characterised 2026-08-11

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | [Environment variables](https://docs.mathesar.org/latest/administration/environment-variables/) + `sso.yml`/`file_storage.yml`/`login_page.yml` |
| Declared drop-in directories | 0 | Not implemented in `charts/mathesar` yet — only env vars are wired today |
| Documented plugin/addon API | 0 | Mathesar is a monolithic Django + Svelte app with no plugin/extension mechanism |
| Plugin API versioned + deprecation policy | 0 | N/A — no plugin API |
| Published HTTP API with a spec | 0 | Mathesar's RPC API is session-cookie authenticated for its own frontend, not a published bearer-token integration surface |
| Upstream accepts patches | 1 | Active GitHub project, PR flow, GPL-3.0 |
| Plugin ABI survives minor releases | 0 | N/A — no plugin ABI |
| Test harness for plugin authors | 0 | N/A — no plugin system |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `charts/mathesar` values → Mathesar env vars (`ALLOWED_HOSTS`, `MATHESAR_INSTANCE_NAME`, `SSO_CONFIG_DICT`, …) |
| **L1** Drop-in | not yet | Mathesar supports declarative config files (`sso.yml`, `file_storage.yml`, `login_page.yml`) that could be mounted as ConfigMap drop-ins; `charts/mathesar` does not wire any of them up yet |
| **L2** Companion | always | consume Mathesar's RPC API from a separate app (session-cookie auth only today — see rubric) |
| **L3** Extension | **no** | Mathesar has no plugin/extension mechanism to extend |
| **L4** Repackage | yes | first-party chart (`charts/mathesar`, `chartOwnership: gentian-owned`) wrapping the unmodified upstream image + `extraValues` |
| **L5** Patch | **no** | not permitted — no build pipeline for a patched image exists |
| **L6** Fork | **no** | not permitted |

## Notes

Mathesar ships no upstream Helm chart at all (docker-compose only), so unlike most profiles in
this catalogue `charts/mathesar` is a **first-party Gentian chart** wrapping the official,
unmodified `mathesar/mathesar` image — the same shape as `charts/odoo`, not a vendored/patched
upstream chart. `repackage.chartOwnership: gentian-owned` reflects that; there is no upstream
chart repo to point `patch.buildRepo`/`fork.repo` at.

**SSO client secret delivery is an exception to the usual `valueMapping` → `existingSecret` +
`secretKeyRef` pattern** used for the database credentials in this chart. Mathesar's
`SSO_CONFIG_DICT` is a single JSON blob env var with the client secret embedded inline (no
separate secret-file option), so `oidc.clientSecret` is delivered as a literal Helm value via
`valueMapping.oidc.clientSecretKey` and interpolated into the JSON at render time
(`charts/mathesar/templates/deployment.yaml`, `toJson`, which HTML/JSON-escapes the secret
safely). Raising this to a rung would require Mathesar itself to support a secret-file /
secret-ref option, which does not exist upstream today.

**No automated admin bootstrap.** Mathesar links an SSO login to an *existing* local user
matched by email rather than auto-provisioning admins, so `spec.postInstallJob` (or a custom
`composition.yaml`) would need to script a Django `createsuperuser`-equivalent against the
app's own database to fully automate this — deferred rather than shipped speculatively; see
the profile header comment for the interim (password-based first-run wizard) flow.
