# Customization ladder — Odoo (family `odoo`)

**Grade: A** · rubric score **8/8** · characterised 2026-08-06
Applies to `odoo-base-ce` and every `odoo-<module>-ce` module profile, which inherit this declaration.

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `odoo.conf` reference in the Odoo developer docs |
| Declared drop-in directories | 1 | `/etc/odoo/odoo.conf.d`, static asset dirs |
| Documented plugin/module API | 1 | Odoo addons: `_inherit`, view `inherit_id` + `xpath` |
| Plugin API versioned + deprecation policy | 1 | per-major-release migration guides; addons declare a version series |
| Published HTTP API with a spec | 1 | JSON-RPC / `/api` on OCB; `erp-core` contract |
| Upstream accepts patches | 1 | active OCA/Odoo PR flow |
| Plugin ABI survives minor releases | 1 | addons are stable within a major series |
| Test harness for plugin authors | 1 | Odoo test framework (`odoo.tests.common`) |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `charts/odoo/values.yaml` |
| **L1** Drop-in | yes | `odoo-conf` (ini fragments merged into `odoo.conf` by an init container — Odoo has no native conf.d, so this is a Gentian mechanism, not an upstream promise) and `branding` (static files, tenant-editable) |
| **L2** Companion | always | consume the `erp-core` contract from a separate app |
| **L3** Extension | yes | Odoo addon in [`odoo-modules`](https://github.com/gentian-org/odoo-modules), synced by `gentian-sidecar-git-modules` into `/opt/odoo/custom-addons` |
| **L4** Repackage | yes | `charts/odoo` (Gentian-owned) + `profiles/odoo/odoo-base-ce/composition.yaml` (`app-odoo`) |
| **L5** Patch | yes | patch series in [`ocb`](https://github.com/gentian-org/ocb) — platform approval required |
| **L6** Fork | yes | `ocb` is the fork; owner `platform-erp` |

## L3 — the normal path

Odoo's inheritance model is the canonical L3 mechanism: `_inherit` extends a model without
copying it, and view inheritance patches XML via `inherit_id` + `xpath` rather than replacing
the original. **Never edit core addons** — that converts an upgrade into a merge.

Three delivery routes are wired up:

- **`git-sidecar`** — the default. Push to `odoo-modules`; the sidecar syncs it into
  `/opt/odoo/custom-addons` on the interval in `gentian.git.syncInterval`.
- **`module-profile`** — when the module is a catalogue *product*. Add a thin profile with
  `deployment-role: module` and `requires-profile: odoo-base-ce` (the `odoo-crm-ce` pattern).
- **`image-layer`** — for airgapped or reproducibility-critical installs.

Per-tenant module sets are permitted **because Odoo runs one instance per tenant namespace**
(`databasePerTenant: true`). Activation is driven by Keycloak group attributes
(`gentianos.io/keycloak-group-attributes` → `gentianOdooModules`), never by divergent module
binaries. See §2.4 of the framework doc for why this is a hard rule.

## L5/L6 — the fork

`ocb` (Odoo Community Backports) is a real L6 fork with its own release train. New deltas
belong in `patches/` with DEP-3 headers, not in the tree — see `ocb/patches/README.md`.

**Never** patch to unlock enterprise features. `hide_enterprise_modules` in `odoo-modules`
is the correct L3 answer to enterprise-module noise.

## Gotchas

- Addon *installation* is a runtime operation, not a Helm one — modules land on disk via the
  sidecar but are activated by the `app-odoo` composition Job.
- `gentian.initModules` (`base,web,gentian_os`) is the bootstrap set; adding to it changes
  first-boot behaviour for every new tenant.
- Assets are cached aggressively; a branding drop-in usually needs an asset regeneration.
