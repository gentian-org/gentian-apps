# L3 cleanup — one addon model, no packages

**Status:** Plan, not started. Tracking document.
**Companion to:** [app-profile-guide.md](app-profile-guide.md) §0 (repo layout),
[customization-ladder.md](customization-ladder.md),
[gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md) (rung L3)

---

## 1. Problem

The directory level between family and profile means **two different things**:

| Family | Second layer is… | Consequence |
|---|---|---|
| `odoo` | **modules** — individually installable, one AppProfile each | ~50 CE modules would become ~50 App Store tiles. A zoo. |
| `nextcloud` | **packages** — fixed bundles of plugins baked into an image | Only 4 combinations exist. A tenant wanting drive + calendar but not office cannot have it. |

Same slot, incompatible semantics, and the two scale badly in opposite directions —
one floods the catalogue, the other cannot express what tenants want.

Both are the *same underlying thing*: customization-ladder rung **L3 (Extension)**.
The platform already has one working implementation of it (Odoo). The cleanup is to
make that the only implementation, and to stop calling it "module".

## 2. Target model

```text
profiles/<family>/
  base/     <family>-base-<edition>        # ce · me · od · pro-*
  addons/   <family>-<addon>-<edition>
profiles/<family>/                          # families with no L3 support
            <family>-<edition>              # no extra layer at all
```

* **"addon" is the only word.** `deployment-role: module` → `addon`. No "module",
  no "plugin", no "package" in Gentian vocabulary. The underlying app may still call
  them modules (Odoo) or apps (Nextcloud) — that is upstream's word, not ours.
* **The addon mechanism is unchanged.** Exactly what `odoo-*-ce` does today:
  delivery into a module path, per-tenant activation, one AppProfile per addon.
* **Packages are decommissioned.** `drive` / `office` / `suite` disappear. There is
  only base (in editions) plus addons (in editions).
* **Apps without L3 do not get the extra layer** — no single-child `base/` folders.
* **install/provision and uninstall/purge are unchanged.** No new lifecycle verbs.

### What actually changes for a user

Addons leave the App Store grid. They are chosen in a window that opens after
install/provision, and managed afterwards via an **Edit** button on the installed
app. Pro addons carry a Buy button in that window.

### Edition vocabulary

This supersedes the open question in [backlog.md](backlog.md). "Base in various
editions and addons in various editions" means the leaf suffix **is** the edition:

| | Before | After |
|---|---|---|
| `spec.edition` enum | `minimal · standard · full · performant` | `ce · me · od · pro` |
| meaning | footprint/feature-breadth, read by nothing | the edition, matching the leaf suffix |

The old values described a footprint axis nothing consumed, while the real edition
axis had no field at all. Drop them rather than reconcile them.

---

## 3. Work by repository

### 3.1 `gentian-os` — CRD + operator

| # | Change | Notes |
|---|---|---|
| 1 | `Tenant.spec.apps[].addons: []string` | The selected addon set for that app. New field, additive. |
| 2 | `ProfileDeploymentRoleModule` → `…Addon`; annotation value `module` → `addon` | `api/v1alpha1/catalogue_types.go`, `catalogue_helpers.go`. Accept `module` as a deprecated alias for one release so the catalogue can migrate without a flag day. |
| 3 | **Invert `implicit_base_apps.go`** | Today: installing a module profile injects its `requires-profile` base. Target: you install base and select addons, so addons never appear in `spec.apps`. This logic becomes dead — confirm before deleting. |
| 4 | Addon activation reconciler | Reconcile `spec.apps[].addons` → the app's native activation (Odoo `-i`, Nextcloud `occ app:enable`). Must be generic; no per-app branching (platform boundary). |
| 5 | `spec.edition` enum → `ce · me · od · pro` | Enum change is admission-validated → **must deploy before** any profile uses a new value. |
| 6 | Entitlement check moves down a level | Currently gates app install; must also gate activation of a `pro` addon. |
| 7 | Addons stop being App claims | An addon is activation state inside the base app, not its own workload. Check `app_reconciler.go` assumptions. |

**Ordering trap (hit twice already):** CRD enum and field changes are
admission-validated, so gentian-os ships and syncs *before* gentian-apps uses the
new values. Same lesson as the `patched` chartOwnership enum and the catalogue
ApplicationSet generator.

### 3.2 `gentian-apps` — catalogue

| # | Change | Notes |
|---|---|---|
| 8 | Odoo: `profiles/odoo/<mod>/odoo-<mod>-ce` → `profiles/odoo/addons/odoo-<mod>-ce` | 9 profiles. Base → `profiles/odoo/base/odoo-base-ce`. |
| 9 | Annotations: `deployment-role: addon` on all 9 | Plus drop `requires-profile` once (3) lands. |
| 10 | Nextcloud: collapse packages → base + addons | See §4 — this is the real work. |
| 11 | Singletons: decide layer per §6 | element, xwiki, openproject, litellm, activepieces, app-store, gentian-subscriptions. |
| 12 | `spec.edition` rewritten on all profiles | 18 profiles set it; 4 leave it unset. |
| 13 | CI: validate `edition` matches leaf suffix, and `addons/` members carry `deployment-role: addon` | Extends the existing `validate-profiles` job. |

### 3.3 `gentian-ui` + `apps/app-store` — the UI change

| # | Change | Notes |
|---|---|---|
| 14 | Store grid filters out `deployment-role: addon` | `gentian-apps/apps/app-store/frontend/src/pages/StorePage.tsx`. |
| 15 | Addon selection window after install/provision | Lists addons for that family + edition, Buy button for `pro`. |
| 16 | **Edit** button on installed apps → same selection list | Add/remove after the fact. |
| 17 | Writes must go through the **git** path, not the live CR | `Tenant` is GitOps-managed with `selfHeal: true`; a direct patch is reverted and violates the no-hand-patching rule. The existing `admin-demo` flow (see `feat(demo): uninstall … (via admin-demo)` commits in gentian-deployments) is the precedent to reuse. |
| 18 | `gentianOdooModules` naming | `gentian-ui/backend/app/services/keycloak_admin_store.py`, `api/routes/admin.py`. Group attribute is Odoo-specific and persisted in Keycloak — renaming is a data migration; **decide whether it is worth it** or whether it stays as an Odoo-internal name. |

### 3.4 `gentian-deployments`

| # | Change | Notes |
|---|---|---|
| 19 | Demo tenant migrated off `nextcloud-suite-me` | Becomes base + addon set. Data-preserving (see §5). |
| 20 | MAC waiver allowlist follows any profile rename | `profiles/_base.yaml`; currently references `nextcloud-office-ce`, `nextcloud-suite-me`, `element`. |

---

## 4. The Nextcloud conversion (the actual work)

Today `images/nextcloud/Dockerfile` is a **cumulative inheritance chain** —
`base → office → officeplus → suite` — each `curl`-ing release tarballs into
`/usr/src/nextcloud/apps/` with versions pinned as Dockerfile `ARG`s. That is the
package model baked into the image, and it is why only four combinations exist.

**Apps currently baked in, and their target addon profile:**

| Image target | Apps | Becomes |
|---|---|---|
| `base` | `user_oidc` | stays in base — it is platform SSO, not optional |
| `office` | `richdocuments`, `forms` | `nextcloud-richdocuments-ce`, `nextcloud-forms-ce` |
| `officeplus` | `mail`, `calendar`, `contacts`, `tasks` | four addon profiles |
| `suite` | `deck`, `collectives`, `spreed` | three addon profiles |

**Why this is tractable: the seam already matches Odoo.**

| | Odoo (today) | Nextcloud (target) |
|---|---|---|
| delivery | git-sidecar → `/opt/odoo/custom-addons` | sidecar → `custom_apps` |
| registration | `addons_path` in `odoo.conf` | `apps_paths` in `config.php` |
| activation | `-i <module>` | `occ app:enable <app>` |
| per-tenant set | `gentianOdooModules` group attribute | same pattern |

`custom_apps` is Nextcloud's standard *writable* second app directory, which is the
direct analogue of `custom-addons`. Both activate against a live instance and run
migrations — neither is image content, despite the current Dockerfile implying so.

**Steps:**

1. Collapse four image targets to one base image (`nextcloud` + `user_oidc`).
2. Register `custom_apps` in `apps_paths` via the chart.
3. Move the nine apps out of the Dockerfile into addon profiles; version pinning
   moves from Dockerfile `ARG`s into each addon profile.
4. Deliver addon tarballs by the same sidecar pattern Odoo uses.
5. Activate per tenant with `occ app:enable`.

**Hard constraint with no Odoo equivalent:** Nextcloud apps declare a `max-version`
against the server major, so **addon↔base version compatibility is a gate, not
advice**. `spec.customization.extension.testMatrix` already exists as the field —
but it is currently documentary and would have to be *enforced*. Installing an
incompatible addon must fail closed.

---

## 5. Migration

* **Odoo** — reshuffle only. Profiles move `odoo/<mod>/` → `odoo/addons/`, and leaf
  names are unchanged, so `metadata.name` is stable. Per
  [backlog.md](backlog.md), a stable leaf name means ArgoCD updates the Application
  source path **in place** — no prune, no data loss.
* **Nextcloud** — a real data migration. A tenant on `nextcloud-suite-me` must land
  on base + the equivalent addon set with its files and database intact. **Do not
  reuse the demo-tenant rename shortcut here**: that worked only because the data
  was disposable. Sequence: publish base + addons alongside, migrate the tenant,
  retire the package profile.
* Addons that were previously baked into the image are already installed in the
  running instance — the migration must *adopt* them (mark active) rather than
  reinstall.

---

## 6. Open questions

1. **Singletons.** Do element / xwiki / openproject / litellm / activepieces /
   app-store / gentian-subscriptions get `<family>/<family>-<edition>` (two levels,
   no addon layer) or stay flat at `<family>-<edition>`? Blocks the singleton moves.
2. **Does a "package" survive as sugar?** A curated preset ("Suite = these 9
   addons") is a UI convenience over the addon mechanism, not a catalogue object.
   Worth keeping as a preset, or drop entirely?
3. **`pro-super` / `pro-master`.** These add a fourth name segment. Per the
   path-encodes-mutable-fact rule already applied twice in this repo, sub-tiers
   should be a field (`plan`/`sku`), not a longer filename. Confirm.
4. **Addon↔base compatibility across editions.** Do `ce`, `me` and `od` bases accept
   the same addons? `od` is a different upstream chart, so almost certainly not —
   needs declaring, not assuming.
5. **Scale.** One AppProfile CR + one ArgoCD Application per addon. ~50 Odoo modules
   = ~50 Applications, invisible in the store but real in ArgoCD. Acceptable?
6. **`gentianOdooModules`** — rename to something addon-generic, or leave as an
   Odoo-internal Keycloak attribute? It is persisted state; renaming is a migration.

---

## 7. Documentation to adapt

Terminology counts are current occurrences of "module", to size the edit.

| Document | What changes | Scale |
|---|---|---|
| `gentian-os/docs/app-customization.md` | **Largest.** §2.4 defines L3 in module language throughout; `extension.mechanism` examples (`odoo-addon`, `nextcloud-app`), `modulePath`, `module-profile` delivery, the §2.4 per-tenant namespace rule, the L2-vs-L3 tie-break table, and the rung→repo map row for L3. | 51 hits |
| `gentian-apps/docs/app-profile-guide.md` | §0 layout (base/addons shape), "Base + module profile bundles" section, annotations-vs-composition table, `deployment-role` references. | 8 hits, 3 role refs |
| `gentian-apps/docs/customization-ladder.md` | Bundle layout block, rung table L3 row, the `profiles/<family>/<app>/<name>/` example. | 3 hits |
| `gentian-apps/AGENTS.md` | Ladder procedure step 3 wording, rung→location line, layout rules section. | 2 hits |
| `gentian-apps/README.md` | Structure tree — currently shows `drive/office/suite`. | tree block |
| `gentian-apps/docs/backlog.md` | Close the edition-vocabulary open item (resolved in §2 here); update the family/app/tier description. | 1 item |
| `profiles/*/customization.md` | Per-app ladder docs describing L3 delivery — `odoo/base/odoo-base-ce`, `nextcloud/drive/nextcloud-drive-ce`, `activepieces`. | 3 files |
| `gentian-apps/docs/custom-app-guide.md` | Check for module/package language. | verify |
| `gentian-app-template/customization/extensions/README.md` | "how to write a plugin" — align vocabulary to addon. | verify |

**Do not rename in the CRD field names themselves without checking:**
`spec.customization.extension.modulePath` is an API field; renaming it is a CRD
change with the same admission-ordering constraint as everything else in §3.1.

---

## 8. Suggested order

1. Settle §6 open questions (1–3 block layout work).
2. gentian-os: CRD changes — `Tenant.spec.apps[].addons`, role rename with alias,
   `edition` enum. Ship and verify synced **before** step 3.
3. gentian-apps: Odoo reshuffle to `base/` + `addons/` (low risk, no rename).
4. gentian-os: addon activation reconciler; invert/remove implicit base install.
5. gentian-ui + app-store: store filter, selection window, Edit button, git write path.
6. Nextcloud conversion (§4) — the long pole.
7. gentian-deployments: migrate the demo tenant off the suite package.
8. Documentation sweep (§7), done last so it describes what shipped.
