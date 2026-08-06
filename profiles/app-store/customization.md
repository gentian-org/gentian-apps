# Customization ladder — App Store (family `app-store`)

**Grade: B** · rubric score **5/8** · characterised 2026-08-06
**First-party app** built from `gentian-app-template`.

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `backend/app/core/config.py` + chart values |
| Declared drop-in directories | 1 | `/etc/gentian/app-store/conf.d` (template `conf.d` reader) |
| Documented plugin/module API | 0 | the template extension loader is not yet adopted here |
| Plugin API versioned + deprecation policy | 0 | — |
| Published HTTP API with a spec | 1 | FastAPI → OpenAPI at `/api/v1` |
| Upstream accepts patches | 1 | we are upstream |
| Plugin ABI survives minor releases | 0 | no plugin ABI yet |
| Test harness for plugin authors | 1 | the app's own pytest suite |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `apps/app-store/chart/values.yaml` |
| **L1** Drop-in | yes | `app-config` (`/etc/gentian/app-store/conf.d`, yaml) |
| **L2** Companion | always | the OpenAPI surface at `/api/v1` |
| **L3** Extension | **not yet** | adopt the template's entry-point loader (`gentian.app.app-store.plugins`) to unlock this — that change alone moves the app to grade A |
| **L4** Repackage | yes | Gentian-owned chart |
| **L5** Patch | n/a | we own the source; a "patch" here is just a commit |
| **L6** Fork | n/a | — |

## We are upstream

For first-party apps the ladder collapses at the top: there is no upstream to diverge from, so
L5/L6 are meaningless and a change that would be a patch elsewhere is simply a PR. That makes
the *lower* rungs matter more, not less — a first-party app that forces every consumer to edit
its source has just moved the maintenance cost rather than removing it.

**The gap to close:** adopting the template extension loader (`backend/app/extensions/`) and
frontend slots. Until then L3 is unavailable and consumers who need in-app behaviour must
either send a PR or build a companion.
