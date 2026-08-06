# Customization ladder — Nextcloud (family `nextcloud`)

**Grade: A** · rubric score **7/8** · characterised 2026-08-06
Applies to `nextcloud-drive-ce` and the `nextcloud-office*` / `nextcloud-suite-ce` profiles.

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `config.php` admin manual |
| Declared drop-in directories | 1 | `config/*.config.php` is an upstream-documented drop-in dir |
| Documented plugin/module API | 1 | Nextcloud apps (OCP) + AppAPI ExApps |
| Plugin API versioned + deprecation policy | 1 | `max-version` in `appinfo/info.xml`; OCP deprecation cycle |
| Published HTTP API with a spec | 1 | OCS + WebDAV; `file-store` / `filepicker` contracts |
| Upstream accepts patches | 1 | active GitHub PR flow |
| Plugin ABI survives minor releases | 1 | apps pin a server major; OCP is stable within it |
| Test harness for plugin authors | 0 | app test tooling exists but is not a supported harness |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → upstream `nextcloud/nextcloud` chart values |
| **L1** Drop-in | yes | `config` (`/var/www/html/config`, PHP fragments — **not** tenant-editable: it is executable config) and `theming` (static assets, tenant-editable) |
| **L2** Companion | always | consume `file-store` / `filepicker`; or ship an **ExApp**, which is Nextcloud's own name for a side-by-side extension |
| **L3** Extension | yes | a Nextcloud app installed via `occ app:install` from `spec.postInstallJob` |
| **L4** Repackage | yes | upstream chart + `extraValues`; composition for bootstrap sequencing |
| **L5** Patch | **no** | not permitted — the app and ExApp surfaces are rich enough that a patch signals a wrong turn |
| **L6** Fork | **no** | not permitted |

## L2 vs L3 here

Nextcloud is the clearest case in the catalogue of both rungs being first-class, and upstream
names them: a **PHP app** runs inside the server (L3); an **ExApp** (AppAPI) is a container
alongside it (L2). Apply the framework's tie-breaker — if the function must appear in the
Nextcloud UI and touch its data model, write an app; otherwise write an ExApp or a Gentian
companion, which survives major-version upgrades unchanged.

## Gotchas

- `config/*.config.php` fragments are **executable PHP**. They are declared `tenantEditable:
  false` deliberately — a tenant-supplied fragment would be arbitrary code execution.
  Tenant self-service is limited to `theming` assets.
- App installation is a runtime operation via `occ`; it is not idempotent across chart
  re-renders, so it belongs in a post-install Job, not in values.
- `appcodechecker` rejects apps using private APIs — a good early signal that a customization
  is reaching past the supported extension point.
