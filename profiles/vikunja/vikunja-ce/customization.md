# Customization ladder — Vikunja (family `vikunja-ce`)

**Grade: C** · rubric score **4/8** · characterized 2026-11-22

Framework: [gentian-os/docs/guides/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/guides/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | [Config options](https://vikunja.io/docs/config-options): every key with its default, as `config.yml` or `VIKUNJA_*` variables |
| Declared drop-in directories | 0 | One configuration file; `charts/vikunja` writes all of it, and the image is `FROM scratch` with no directory it reads extra files from |
| Documented plugin/addon API | 1 | Plugins as Go source loaded by yaegi (`plugins.*`), documented upstream; off here (`plugins.enabled: false`) |
| Plugin API versioned + deprecation policy | 0 | None stated; the native loader is already deprecated in favor of yaegi |
| Published HTTP API with a spec | 1 | REST API under `/api/v1/`, OpenAPI served by the app (`/api/v1/docs`), scoped API tokens a person makes in Vikunja's settings |
| Upstream accepts patches | 1 | Active project, PR flow, AGPL-3.0-or-later |
| Plugin ABI survives minor releases | 0 | Not promised |
| Test harness for plugin authors | 0 | None |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `charts/vikunja` values → `config.yml` (time zone, file size, link sharing, defaults for new accounts) |
| **L1** Drop-in | **no** | no drop-in surface (see rubric) |
| **L2** Companion | always | a separate app calling the REST API with a Vikunja API token of its own account |
| **L3** Extension | **no** | plugins need files in the image's root path, which this chart does not build; declare it once an image build exists |
| **L4** Repackage | yes | first-party chart (`charts/vikunja`, `chartOwnership: gentian-owned`) wrapping the unmodified upstream image |
| **L5** Patch | **no** | not permitted — no build pipeline for a patched image exists |
| **L6** Fork | **no** | not permitted |

## Notes

Upstream publishes a Helm chart (`go-vikunja/helm-chart`), a wrapper of the bjw-s `common` library
chart 1.5.1 with every value under a `vikunja:` key. The operator writes `podLabels` at the top of
a chart's values, where that chart never reads them, and the tenant's network policies select the
app's pods by those labels. `charts/vikunja` is therefore first-party, as `charts/paperless-ngx`
and `charts/docmost` are.

Vikunja's instance administrator role is a Vikunja Pro feature (`vikunja user set-admin` needs a
license key). This edition has none, so the profile has no `hooks.provisioning` and nobody is an
administrator inside Vikunja.

The web app sends Vikunja's own token in the `Authorization` header, which the front door removes
unless the entry declares `clientAuthorization: app` and the tenant's perimeter approver approved
it. Until then the page loads and every API call is refused.
