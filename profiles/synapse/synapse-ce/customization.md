# Customization ladder — Synapse (`synapse-ce`)

**Grade: B** · rubric score **6/8**

Framework: [gentian-os/docs/guides/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/guides/app-customization.md).

Synapse is the Matrix homeserver that comes with Element ([element-ce](../../element/element-ce/customization.md)).
Nobody opens it; a request about how the chat client looks or behaves belongs to Element.

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `homeserver.yaml` |
| Declared drop-in directories | 1 | Synapse `conf.d`-style config directory |
| Documented plugin/addon API | 1 | Synapse Module API |
| Plugin API versioned + deprecation policy | 1 | the module API is versioned and deprecations are announced |
| Published HTTP API with a spec | 1 | Matrix Client-Server API |
| Upstream accepts patches | 1 | active PR flow |
| Plugin ABI survives minor releases | 0 | the module API has broken across releases |
| Test harness for plugin authors | 0 | none packaged |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `ananace/matrix-synapse` chart values (`extraConfig`, `extraSecrets`) |
| **L1** Drop-in | yes | `synapse-config` (Synapse config directory, yaml) |
| **L2** Companion | always | Matrix Client-Server API, or an application service |
| **L3** Extension | yes | a Synapse Python module |
| **L4** Repackage | yes | upstream chart, values only |
| **L5** Patch | **no** | not permitted |
| **L6** Fork | **no** | not permitted |

## Gotchas

- Server-side behavior (auth, spam checking, event hooks) is L3 via the Module API, but the ABI
  score above holds: modules have broken across Synapse releases, so pin `testMatrix` and
  re-verify on every bump.
- The sign-in redirect URI is host-sensitive (`matrix.<tenant domain>`); changing it is L0,
  not L1.
- Synapse reads each top-level key of its configuration from one file: a key written both in
  `extraConfig` and in `extraSecrets` is taken from one of them only. `email` lives in
  `extraConfig`, `oidc_providers` in `extraSecrets`.
