# Customization ladder — Docmost (family `docmost-ce`)

**Grade: D** · rubric score **2/8** · characterised 2026-08-11

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | [Environment variables](https://docmost.com/docs/self-hosting/environment-variables) |
| Declared drop-in directories | 0 | No ConfigMap-mountable config file surface (env-var config only) |
| Documented plugin/addon API | 0 | Docmost is a monolithic NestJS + React app with no plugin/extension mechanism |
| Plugin API versioned + deprecation policy | 0 | N/A — no plugin API |
| Published HTTP API with a spec | 0 | Docmost's REST API is session-cookie authenticated for its own frontend, not a published bearer-token integration surface |
| Upstream accepts patches | 1 | Active GitHub project, PR flow, AGPL-3.0 core |
| Plugin ABI survives minor releases | 0 | N/A — no plugin ABI |
| Test harness for plugin authors | 0 | N/A — no plugin system |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `charts/docmost` values → Docmost env vars (`APP_URL`, `STORAGE_DRIVER`, `MAIL_DRIVER`, …) |
| **L1** Drop-in | not yet | Docmost has no declarative config-file surface to mount a drop-in against — everything is env vars |
| **L2** Companion | always | consume Docmost's REST API from a separate app (session-cookie auth only today — see rubric) |
| **L3** Extension | **no** | Docmost has no plugin/extension mechanism to extend |
| **L4** Repackage | yes | first-party chart (`charts/docmost`, `chartOwnership: gentian-owned`) wrapping the unmodified upstream image + `extraValues` |
| **L5** Patch | **no** | not permitted — no build pipeline for a patched image exists |
| **L6** Fork | **no** | not permitted |

## Notes

Docmost ships no upstream Helm chart at all (docker-compose only), so — like Mathesar — `charts/docmost`
is a **first-party Gentian chart** wrapping the official, unmodified `docmost/docmost` image, not a
vendored/patched upstream chart. `repackage.chartOwnership: gentian-owned` reflects that; there is no
upstream chart repo to point `patch.buildRepo`/`fork.repo` at.

**SSO is the load-bearing customization decision for this profile and sits outside the rung framework
above**, so it is documented at length: Docmost's own SSO (SAML/OIDC/LDAP) is entirely behind a paid
Business/Enterprise subscription (`apps/server/src/ee/`), so `kernelRequirements.identity.oidc` is not
used — using it would require a license key, which the platform's licensing-bypass prohibition forbids.
Instead this profile declares `kernelRequirements.identity.saml` pointing Keycloak at the generic
**`gentian-sidecar-sso-saml`** sidecar (already shipped for `activepieces-me`'s own Enterprise-gated SSO —
see that profile). That sidecar is a thin relay only — it holds no Docmost secret, because it's a
*separate* Helm release/pod and Kubernetes `envFrom` silently drops the hyphenated `internal-*` secret
keys every `appSecret` gets (confirmed against `gentian-os/crossplane/compositions/app-default.yaml`'s
own comment on this). The actual work — logging the user into Docmost's own free, unlicensed CE
`/api/auth/login` + self-hosted invite API — happens in a small companion container baked into
`charts/docmost` itself (same pod as Docmost, secrets delivered the same proven way `APP_SECRET` is),
reachable only over an internal Service port the sidecar calls. Full rationale, the exact CE endpoints
relied on, and the one known limitation (no admin password-reset path if the bridge secret ever rotates)
are in the `profile.yaml` header comment — read that before touching the SSO wiring.
