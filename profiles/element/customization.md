# Customization ladder — Element + Synapse (family `element`)

**Grade: B** · rubric score **6/8** · characterised 2026-08-06

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

This profile deploys **two** components with different customization surfaces. The grade is
the lower of the two, because a request usually lands on whichever one is less accommodating.

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `config.json` (Element) and `homeserver.yaml` (Synapse) |
| Declared drop-in directories | 1 | Synapse `conf.d`-style config directory |
| Documented plugin/module API | 1 | Synapse Module API (server side only) |
| Plugin API versioned + deprecation policy | 1 | Synapse module API is versioned and deprecations are announced |
| Published HTTP API with a spec | 1 | Matrix Client-Server API |
| Upstream accepts patches | 1 | active PR flow |
| Plugin ABI survives minor releases | 0 | Synapse module API has broken across releases |
| Test harness for plugin authors | 0 | none packaged |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `ananace/matrix-synapse` chart values |
| **L1** Drop-in | yes | `synapse-config` (Synapse config directory, yaml) and `element-config` (`config.json`, tenant-editable for branding keys only) |
| **L2** Companion | always | Matrix Client-Server API, or an application service |
| **L3** Extension | **server only** | a Synapse Python module. There is **no** plugin system for the Element web client |
| **L4** Repackage | yes | upstream chart + composition (Jitsi overlay lives here) |
| **L5** Patch | **no** | not permitted |
| **L6** Fork | **no** | not permitted |

## The asymmetry that matters

Anything the request phrases as "change how the chat *client* behaves" is **not** L3 — Element
Web has no plugin API. The options are L1 (`config.json` knobs, including branding and feature
flags) or L2 (a companion widget/app). Rebuilding the Element bundle to inject behaviour is L5
and is not permitted here; treat a request that seems to need it as a signal to redesign toward
a widget.

Server-side behaviour (auth, spam checking, event hooks) *is* L3 via the Synapse Module API —
but note the ABI score above: modules have broken across Synapse releases, so pin
`testMatrix` and expect to re-verify on every bump.

## Gotchas

- Double CSP headers and `frame-ancestors` handling for portal embedding are L4 concerns
  already solved in the composition — see `app-profile-guide.md` §6b.
- Element SSO redirect URIs are host-sensitive; changing them is L0, not L1.
