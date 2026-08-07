# Customization ladder — OpenProject (family `openproject-ce`)

**Grade: B** · rubric score **5/8** · characterised 2026-08-06

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `configuration.yml` + `OPENPROJECT_*` env reference |
| Declared drop-in directories | 0 | no upstream-documented config drop-in directory |
| Documented plugin/module API | 1 | Rails engines registered via a plugins Gemfile |
| Plugin API versioned + deprecation policy | 0 | no published plugin deprecation policy |
| Published HTTP API with a spec | 1 | APIv3, documented |
| Upstream accepts patches | 1 | active PR flow |
| Plugin ABI survives minor releases | 0 | engines routinely break across releases |
| Test harness for plugin authors | 1 | the Rails/RSpec suite is usable by plugin authors |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → upstream `charts.openproject-ce.org` values, `OPENPROJECT_*` env |
| **L1** Drop-in | limited | `branding` only (static assets, tenant-editable). There is no config drop-in directory — a config *file* mount is L4 here, not L1 |
| **L2** Companion | always | **the recommended path.** APIv3 is complete and stable; the `project-management` contract exists |
| **L3** Extension | yes, expensive | a Rails engine, delivery `image-layer` only — plugins are resolved at build time, so every change is an image rebuild |
| **L4** Repackage | yes | upstream chart + `extraValues` + composition |
| **L5** Patch | **no** | not permitted |
| **L6** Fork | **no** | not permitted |

## Prefer L2

OpenProject is the catalogue's clearest "grade B ⇒ go side-by-side" case. L3 is technically
available but carries the full cost of an image rebuild per change *and* an unstable engine
ABI, while APIv3 is complete enough that most requests can be met by a companion app that
survives upgrades untouched.

Only choose L3 when the function must appear inside OpenProject's own work-package UI and
extend its data model — and when you do, pin `testMatrix` and expect to re-verify on every
upstream minor.

## Gotchas

- Theming beyond the logo is an Enterprise feature. Do not patch to unlock it — see the
  licensing prohibition in `app-profile-guide.md`.
- Seeding (`SEED_*`) runs on first boot only; changing seed data later is a runtime job, not
  a values change.
