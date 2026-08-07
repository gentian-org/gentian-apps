# Customization ladder — Activepieces (family `activepieces-me`)

**Grade: A** · rubric score **7/8** · characterised 2026-08-06

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `AP_*` environment reference |
| Declared drop-in directories | 1 | the pieces directory, synced by the git-modules sidecar |
| Documented plugin/addon API | 1 | the Pieces framework (TypeScript) |
| Plugin API versioned + deprecation policy | 1 | pieces declare a framework version; breaking changes are versioned |
| Published HTTP API with a spec | 1 | REST API |
| Upstream accepts patches | 1 | active PR flow |
| Plugin ABI survives minor releases | 1 | pieces are stable within a framework major |
| Test harness for plugin authors | 0 | no packaged harness for downstream authors |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `AP_*` values on the chart |
| **L1** Drop-in | yes | `branding` static assets (tenant-editable) |
| **L2** Companion | always | REST API, or a webhook-triggered service |
| **L3** Extension | yes | a **custom piece**, delivered by the `git-sync` sidecar already declared on this profile (`gentian-sidecar-git-modules` 0.1.7) |
| **L4** Repackage | yes | `charts/activepieces-me/` — pinned upstream + a DEP-3 patch series, `chartOwnership: patched` |
| **L5** Patch | **no** | not permitted — see below |
| **L6** Fork | **no** | not permitted |

### L4 patches the chart; L5 would patch the app — only one of those is allowed

`charts/activepieces-me/` carries a 5-patch series against upstream `adnoctem/helm`
(3 upstream bug fixes, 2 Gentian extension points). That is **L4 Repackage**: a
chart is *packaging*, and patching packaging is what a distribution repo does.

**L5 remains forbidden**, because at this rung the patch target would be the
Activepieces application itself — its server bundles and database flags — and
that is precisely where the licence-bypass temptation lives (see below). The
distinction is the target, not the technique.

## L3 is the intended path

Custom pieces are Activepieces' native extension unit and the sidecar wiring already exists on
this profile — adding a piece is a push to the addon repo, not a platform change. Anything
phrased as "add an integration/connector/step" is L3 here, not L2.

## Licensing — read before customizing

Several capabilities (SSO, custom appearance, git sync of flows, advanced RBAC) are Enterprise
features gated by a licence key. Configure them by supplying a valid `AP_LICENSE_KEY`, never by
patching bundles or flipping database flags. This is an explicit absolute prohibition — see
`app-profile-guide.md`. It is also why `patch.allowed` is `false` for this app: the temptation
lives exactly here.

Upstream chart provenance and licence terms are pinned in
[`charts/activepieces-me/UPSTREAM`](../../charts/activepieces-me/UPSTREAM); the local delta is
[`charts/activepieces-me/patches/`](../../charts/activepieces-me/patches/). Nothing about that
series touches licensing — it is 3 upstream bug fixes plus 2 additive extension points.
