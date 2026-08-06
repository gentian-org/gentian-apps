# Customization ladder — XWiki (family `xwiki`)

**Grade: A** · rubric score **7/8** · characterised 2026-08-06

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `xwiki.cfg` / `xwiki.properties` reference |
| Declared drop-in directories | 1 | `/usr/local/xwiki/data/` config and `lib/` extension dirs |
| Documented plugin/module API | 1 | XWiki components + XAR extensions |
| Plugin API versioned + deprecation policy | 1 | XWiki keeps a long deprecation cycle and documents it per release |
| Published HTTP API with a spec | 1 | REST API |
| Upstream accepts patches | 1 | active Jira + PR flow |
| Plugin ABI survives minor releases | 1 | components are stable within a cycle |
| Test harness for plugin authors | 0 | test tooling exists but is not packaged for downstream authors |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → upstream `xwiki-contrib/xwiki-helm` values |
| **L1** Drop-in | yes | `xwiki-properties` (`/usr/local/xwiki/data/`, properties) and `skin` (static assets, tenant-editable) |
| **L2** Companion | always | consume the XWiki REST API from a separate app |
| **L3** Extension | yes | XAR extension installed through the Extension Manager, or a wiki-page-as-code import |
| **L4** Repackage | yes | upstream chart + `extraValues` + composition |
| **L5** Patch | **no** | not permitted |
| **L6** Fork | **no** | not permitted |

## Notes

XWiki blurs L1 and L3 more than most apps: much of what other systems need a plugin for is
authored as **wiki pages** (velocity/groovy in-page). Treat page-as-code imports as L3 — they
are versioned artifacts loaded by the app, not configuration — and keep them in a module repo
rather than editing pages in a live instance, which would be a Rung X hotfix in disguise.

Extension installation is a runtime operation; drive it from `spec.postInstallJob`, not values.
