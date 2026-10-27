# Customization ladder — Paperless-ngx (family `paperless-ngx-ce`)

**Grade: C** · rubric score **4/8** · characterised 2026-10-21

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | [Configuration](https://docs.paperless-ngx.com/configuration/): every setting is an environment variable, with defaults |
| Declared drop-in directories | 0 | The image runs scripts from `/custom-cont-init.d` at start, but `charts/paperless-ngx` mounts nothing there yet, and running as non-root it could not install packages anyway |
| Documented plugin/addon API | 1 | Parser plugins since 3.0: a Python package under the `paperless_ngx.parsers` entry point ([advanced usage](https://docs.paperless-ngx.com/advanced_usage/)), "not supported by the maintainers" |
| Plugin API versioned + deprecation policy | 0 | None stated |
| Published HTTP API with a spec | 1 | [REST API](https://docs.paperless-ngx.com/api/), versioned by `Accept` header (10 today, older kept a year), OpenAPI schema served by the app; basic auth and tokens for machine clients — the MCP companion and both Jobs of this profile are built on it |
| Upstream accepts patches | 1 | Active GitHub project, PR flow, GPL-3.0 |
| Plugin ABI survives minor releases | 0 | Not promised |
| Test harness for plugin authors | 0 | None |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `charts/paperless-ngx` values → `PAPERLESS_*` environment (OCR languages and mode, time zone, polling, workers, AI) |
| **L1** Drop-in | not yet | `/custom-cont-init.d` exists in the image; the chart does not mount it |
| **L2** Companion | always | consume the REST API from a separate app with a Paperless account of its own. The MCP companion (`images/paperless-ngx-mcp`, `spec.extensions`) is one |
| **L3** Extension | **no** | parser plugins exist upstream but need a package installed into the image, which this chart does not build; declare it once an image build exists |
| **L4** Repackage | yes | first-party chart (`charts/paperless-ngx`, `chartOwnership: gentian-owned`) wrapping the unmodified upstream image + `extraValues` |
| **L5** Patch | **no** | not permitted — no build pipeline for a patched image exists |
| **L6** Fork | **no** | not permitted |

## Notes

Paperless-ngx ships no upstream Helm chart (docker compose only), so `charts/paperless-ngx` is a
**first-party Gentian chart** wrapping the official, unmodified `ghcr.io/paperless-ngx/paperless-ngx`
image, the shape of `charts/docmost` and `charts/mathesar`. `repackage.chartOwnership: gentian-owned`
reflects that; there is no upstream chart repo to point `patch.buildRepo`/`fork.repo` at.

**One container, one pod.** Upstream runs the web server, the consumer, the scheduler and the
task worker in one container under s6-overlay, and so does the chart, started as the image's own
user (uid 1000) with no root anywhere: upstream documents the image as rootless-capable. The one
thing that mode gives up is installing extra Tesseract languages at start; the image ships
`eng`, `deu`, `fra`, `ita` and `spa`.

**The broker is in the pod.** Celery's queue and the websocket channel layer are transient and
this pod's alone, so the chart runs a Redis bound to `127.0.0.1` beside the app rather than
asking for the shared cache (the chart's `values.yaml` has the reasoning).

**Secrets reach the pod through one Secret** the chart renders (`paperless-ngx-ce-env`) and the
container reads with `envFrom`: the database password, Django's key, the technical passwords and
the realm client's secret inside allauth's provider JSON (`PAPERLESS_SOCIALACCOUNT_PROVIDERS`
takes the secret inline; there is no file or ref form for it). The profile's post-install Job
reads the same Secret, so what it sets in Paperless is what the pod runs with.

**Admin bootstrap is fully automated.** `PAPERLESS_ADMIN_USER` makes the technical superuser
`gentian-bootstrap-admin` at first start. Human administrators are whoever holds the tenant's
App Admin role: `spec.hooks.provisioning.syncJob` sets `is_superuser` on their accounts over the
REST API, as that technical account, and takes it from everyone else. Not Paperless' own
claim-driven sync (`PAPERLESS_SOCIAL_ACCOUNT_SYNC_SUPERUSER_GROUP`): it reads the `groups`
claim from the id token or userinfo, and the realm's mapper writes it to the access token only.
A member who has not signed in yet has no account to promote (allauth makes it at the first
sign-in and would not link one made ahead of it); the Job names them and promotes them on a
later run.

**Every person is in the group `Members`.** Paperless gives an account its first sign-in makes no
permissions at all, and every screen then refuses the person. The chart's
`PAPERLESS_SOCIAL_ACCOUNT_DEFAULT_GROUPS` puts each new account into `Members`, and
`spec.hooks.postInstall` makes that group with everyday permissions (documents, including
deleting them, their filing vocabulary, saved views, notes, share links, mail fetching, one's own
settings and tasks) and adds the accounts made before it. Workflows, users, groups and the app's
settings stay with the App Admin role. Which documents a member sees is still Paperless' own
ownership and sharing.

**The MCP companion** authenticates as the ordinary account `mcp-service`, made by
`spec.hooks.postInstall` with exactly the model permissions its tools need. Paperless shows a
document only to its owner and to whom it was shared with, and a document a person uploads is
theirs, so the same hook adds a workflow that shares every newly consumed document with that
account (view and change). Whether the companion may write at all is the extension's `readOnly`
value; with it on, only the reading tools are offered.

**Paperless' own AI features are off.** Enabling them means declaring `requires.services.llm`,
mapping the gateway's address and key to the chart's `llm.*` values and naming a model the
gateway serves (`extraValues.ai`). The profile's header says so; it is not declared because
declaring `llm` holds the release on a cluster that serves no models.

**Backup.** The full-text index under `data/index` is excluded and rebuilt after a restore
(`document_index reindex`); thumbnails are kept, as Paperless does not regenerate one on demand.
