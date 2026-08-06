# L3 cleanup — one addon model

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

Same slot, incompatible semantics, scaling badly in opposite directions — one floods
the catalogue, the other cannot express what tenants want.

Both are the *same underlying thing*: customization-ladder rung **L3 (Extension)**.
The platform already has one working implementation (Odoo). The cleanup makes that
the only implementation, and stops calling it "module".

## 2. Target model

```text
profiles/<family>/
  base/       <family>-base-<name>        # deployable
  addons/     <family>-<addon>-<name>     # deployable, activated inside a base
  packages/   <family>-<package>          # NOT deployable — a UI preset

profiles/<family>/                        # families with no L3 support
  <family>-<name>                         # two levels, no base/addons/packages
```

* **"addon" is the only word.** `deployment-role: module` → `addon`. No "module",
  no "plugin" in Gentian vocabulary. Upstream may still say module (Odoo) or app
  (Nextcloud) — that is their word, not ours.
* **The addon mechanism is unchanged** — exactly what `odoo-*-ce` does today:
  delivery into a module path, per-tenant activation, one AppProfile per addon.
* **install/provision and uninstall/purge are unchanged.** No new lifecycle verbs.
* **Apps without L3 get no third layer** — no single-child `base/` folders.

### 2.1 Editions

Three, and only three: **`ce` · `me` · `pro`**.

| | Before | After |
|---|---|---|
| `spec.edition` enum | `minimal · standard · full · performant` | `ce · me · pro` |
| meaning | footprint/feature-breadth, read by nothing | the edition |

`od` is **not** an edition — openDesk is a *vendor*. `nextcloud-office-od` is a
**`pro` edition supplied by openDesk**.

**Editions are technically compatible with each other.** What determines whether an
edition may run is **authorization** — whether a licence was paid for. Technical
addon↔base compatibility is managed by **version**, not by edition. This removes the
per-edition compatibility matrix entirely: there is one addon set per family, gated
by entitlement and constrained by version.

### 2.2 Naming is a hint, not a contract

Leaf and folder names are **free-form**. A `-pro` profile and a `-bigTec` profile may
both be `edition: pro` from different vendors. It is good practice for the name to
suggest the edition, but nothing may depend on it.

**Consequence: `spec.edition` is authoritative; CI must NOT enforce name ↔ edition.**
This is the same principle already applied twice in this repo — a path may not encode
a fact that a field owns. It also means a `spec.vendor` field is likely needed, so the
App Store can render "Pro edition by openDesk" rather than parsing `-od` out of a name.

### 2.3 Packages become UI presets

A package is **not a deployable profile**. It is a very small file that adds an option
to the UI which pre-selects a subset of addons — the user can then adjust the
selection before installing.

```yaml
# profiles/nextcloud/packages/nextcloud-suite.yaml  (shape TBD)
kind: AppPackage
metadata:
  name: nextcloud-suite
spec:
  family: nextcloud
  displayName: Nextcloud Suite
  addons: [richdocuments, forms, mail, calendar, contacts, tasks, deck, collectives, spreed]
```

This keeps the curated bundles as a convenience while removing them as artifacts —
the flexibility problem and the curation benefit stop being in tension.

### 2.4 What changes for a user

Addons leave the App Store grid. After install/provision, a window opens with the
addon list — pre-selected if a package was chosen — and Buy buttons on `pro` addons.
Afterwards an **Edit** button on the installed app reopens the same list.

---

## 3. Work by repository

### 3.1 `gentian-os` — CRD + operator

| # | Change | Notes |
|---|---|---|
| 1 | `Tenant.spec.apps[].addons: []string` | Selected addon set for that app. Additive. |
| 2 | `ProfileDeploymentRoleModule` → `…Addon`; annotation value `module` → `addon` | `api/v1alpha1/catalogue_types.go`, `catalogue_helpers.go`. Accept `module` as a deprecated alias for one release to avoid a flag day. |
| 3 | **Invert `implicit_base_apps.go`** | Today installing a module profile injects its `requires-profile` base. Target: install base, select addons — addons never appear in `spec.apps`. This logic becomes dead; confirm before deleting. |
| 4 | Addon activation reconciler | Reconcile `spec.apps[].addons` → native activation (Odoo `-i`, Nextcloud `occ app:enable`). Generic; no per-app branching (platform boundary). |
| 5 | `spec.edition` enum → `ce · me · pro` | Admission-validated → **deploy before** any profile uses a new value. |
| 6 | `spec.vendor` (new, §2.2) | So the store can show the supplier without parsing names. Confirm the name. |
| 7 | Entitlement gates edition **and** pro-addon activation | Per §2.1 this is what makes editions interchangeable — authorization, not technical compatibility. |
| 8 | Addons stop being App claims | An addon is activation state inside the base app, not its own workload. Check `app_reconciler.go`. |
| 9 | `AppPackage` kind (§2.3) | Or an equivalent lightweight object the App Store can read. Not deployable, no reconciler. |

**Ordering trap (hit twice already):** CRD enum/field changes are admission-validated,
so gentian-os ships and syncs *before* gentian-apps uses the new values. Same lesson
as the `patched` chartOwnership enum and the catalogue ApplicationSet generator.

### 3.2 `gentian-apps` — catalogue

| # | Change | Notes |
|---|---|---|
| 10 | Odoo: `profiles/odoo/<mod>/odoo-<mod>-ce` → `profiles/odoo/addons/odoo-<mod>-ce` | 9 profiles. Base → `profiles/odoo/base/odoo-base-ce`. Leaf names unchanged → no CR rename. |
| 11 | `deployment-role: addon` on all 9; drop `requires-profile` once (3) lands | |
| 12 | Nextcloud: collapse packages → base + addons + presets | See §4 — the real work. |
| 13 | Singletons → `profiles/<family>/<family>-<edition>/` | element, xwiki, openproject, litellm, activepieces, app-store, gentian-subscriptions. Two levels, no third layer. |
| 14 | `spec.edition` rewritten to `ce`/`me`/`pro` on all profiles | `nextcloud-office-od` → `edition: pro`, `vendor: opendesk`. |
| 15 | CI: `addons/` members carry `deployment-role: addon`; `packages/` members are presets, not profiles | **Do not** validate name ↔ edition (§2.2). |

### 3.3 `gentian-ui` + `apps/app-store` — the UI change

| # | Change | Notes |
|---|---|---|
| 16 | Store grid filters out `deployment-role: addon` and renders packages as presets | `gentian-apps/apps/app-store/frontend/src/pages/StorePage.tsx`. |
| 17 | Addon selection window after install/provision | Pre-selected from the chosen package; Buy button on `pro`. |
| 18 | **Edit** button on installed apps → same list | Add/remove after the fact. |
| 19 | Writes go through the **git** path, not the live CR | `Tenant` is GitOps-managed with `selfHeal: true`; a direct patch is reverted and violates the no-hand-patching rule. The existing `admin-demo` flow (`feat(demo): uninstall … (via admin-demo)` commits in gentian-deployments) is the precedent. |

`gentianOdooModules` (`gentian-ui/backend/app/services/keycloak_admin_store.py`,
`api/routes/admin.py`) **stays as-is** — Odoo calls its addons modules, so an
Odoo-specific attribute using Odoo's word is correct.

### 3.4 `gentian-deployments`

| # | Change | Notes |
|---|---|---|
| 20 | MAC waiver allowlist follows any profile rename | `profiles/_base.yaml`. |
| 21 | Demo tenant re-installs from the new catalogue | No migration needed — all apps are uninstalled. |

---

## 4. The Nextcloud conversion (the actual work)

Today `images/nextcloud/Dockerfile` is a **cumulative inheritance chain** —
`base → office → officeplus → suite` — each `curl`-ing release tarballs into
`/usr/src/nextcloud/apps/` with versions pinned as Dockerfile `ARG`s. That is the
package model baked into the image, and it is why only four combinations exist.

**Apps currently baked in, and where they go:**

| Image target | Apps | Becomes |
|---|---|---|
| `base` | `user_oidc` | stays in base — platform SSO, not optional |
| `office` | `richdocuments`, `forms` | 2 addon profiles |
| `officeplus` | `mail`, `calendar`, `contacts`, `tasks` | 4 addon profiles |
| `suite` | `deck`, `collectives`, `spreed` | 3 addon profiles |

The old bundles survive as **presets** (§2.3) listing exactly these sets.

**Why this is tractable: the seam already matches Odoo.**

| | Odoo (today) | Nextcloud (target) |
|---|---|---|
| delivery | git-sidecar → `/opt/odoo/custom-addons` | sidecar → `custom_apps` |
| registration | `addons_path` in `odoo.conf` | `apps_paths` in `config.php` |
| activation | `-i <module>` | `occ app:enable <app>` |
| per-tenant set | `gentianOdooModules` group attribute | same pattern |

`custom_apps` is Nextcloud's standard *writable* second app directory — the direct
analogue of `custom-addons`. Both activate against a live instance and run
migrations; neither is image content, despite the current Dockerfile implying so.

**Steps:**

1. Collapse four image targets to one base image (`nextcloud` + `user_oidc`).
2. Register `custom_apps` in `apps_paths` via the chart.
3. Move the nine apps out of the Dockerfile into addon profiles; version pinning
   moves from Dockerfile `ARG`s into each addon profile.
4. Deliver addon tarballs by the same sidecar pattern Odoo uses.
5. Activate per tenant with `occ app:enable`.
6. Add the three presets (`drive`, `office`, `suite`) under `packages/`.

**Version constraint (technical, not edition-related — see §2.1):** Nextcloud apps
declare a `max-version` against the server major, so addon↔base *version*
compatibility is a gate. `spec.customization.extension.testMatrix` already exists as
the field, but is currently documentary — it would have to be enforced, failing
closed on an incompatible pairing.

---

## 5. Migration

**None required.** All apps are uninstalled from the cluster and there is no live
tenant data, so profiles can be renamed, moved and rebuilt freely. The demo tenant
re-installs from the new catalogue once it exists.

This is the one window in which this cleanup is cheap. A rename of a profile with
live installs would tear down the App claim, Helm release, templated PVC and
per-tenant database — see [backlog.md](backlog.md).

---

## 6. Resolved decisions

| # | Question | Decision |
|---|---|---|
| 1 | Singleton layout | `profiles/<family>/<family>-<edition>/` — two levels, no third layer. |
| 2 | Do packages survive? | Yes, as **UI presets** in a `packages/` folder — very small files pre-selecting a subset of addons. Not deployable. |
| 3 | Sub-tier names (`pro-super`, `pro-bigTec`) | Names are free-form. `spec.edition` is authoritative; CI must not derive edition from a name. Implies a `vendor` field. |
| 4 | Addon↔base compatibility across editions | Editions stay compatible. **Authorization** (paid licence) decides whether an edition may run; **version** manages technical compatibility. No per-edition matrix. |
| 5 | Scale: one Application per addon | **Keep one bundle per addon.** See below. |
| 6 | Rename `gentianOdooModules`? | No — Odoo calls its addons modules. |

### 6.1 On Q5 — why one bundle per addon

The Application count comes from the catalogue ApplicationSet generating one
Application per directory containing a `kustomization.yaml` — not from the CR count.
So granularity is a choice:

* **One bundle per addon (chosen).** ~60 Applications. ArgoCD routinely runs
  thousands; the real costs are UI clutter and marginal repo-server polling. Keeps
  per-addon ownership (CODEOWNERS, independent versioning, third-party
  contribution) and preserves the leaf-dir == `metadata.name` invariant.
* **One bundle per family's addons.** ~10 Applications. But `path.basename` naming
  collides (`odoo/addons` and `nextcloud/addons` both basename to `addons`), so
  Application naming would have to become path-derived; the invariant becomes
  conditional; and one malformed addon file fails the whole family's addon sync.
  **This is the escape hatch** if the addon count ever reaches the high hundreds.
* **Addons inline in the base profile.** Rejected — a third-party vendor shipping a
  pro addon would have to edit Gentian's base profile. Wrong ownership boundary.

---

## 7. Documentation to adapt

Counts are current occurrences of "module", to size the edit.

| Document | What changes | Scale |
|---|---|---|
| `gentian-os/docs/app-customization.md` | **Largest.** §2.4 defines L3 in module language throughout; `extension.mechanism` examples, `modulePath`, `module-profile` delivery, the per-tenant namespace rule, the L2-vs-L3 tie-break table, the rung→repo map row for L3. | 51 hits |
| `gentian-apps/docs/app-profile-guide.md` | §0 layout (base/addons/packages), "Base + module profile bundles", annotations-vs-composition table, `deployment-role` refs. | 8 hits, 3 role refs |
| `gentian-apps/docs/customization-ladder.md` | Bundle layout block, rung table L3 row, path examples. | 3 hits |
| `gentian-apps/AGENTS.md` | Ladder procedure step 3, rung→location line, layout rules. | 2 hits |
| `gentian-apps/README.md` | Structure tree — currently shows `drive/office/suite`. | tree block |
| `gentian-apps/docs/backlog.md` | Edition vocabulary resolved here; update the family/app/tier description. | 1 item |
| `profiles/*/customization.md` | Per-app L3 delivery docs — `odoo-base-ce`, `nextcloud-drive-ce`, `activepieces`. | 3 files |
| `gentian-apps/docs/custom-app-guide.md` | Check for module/package language. | verify |
| `gentian-app-template/customization/extensions/README.md` | "how to write a plugin" → addon vocabulary. | verify |

**Do not rename CRD field names casually:** `spec.customization.extension.modulePath`
is an API field; renaming it carries the same admission-ordering constraint as
everything else in §3.1.

---

## 8. Suggested order

1. gentian-os: CRD changes — `Tenant.spec.apps[].addons`, role rename with alias,
   `edition` enum, `vendor`, `AppPackage`. Ship and verify synced **before** step 2.
2. gentian-apps: Odoo reshuffle to `base/` + `addons/` (leaf names unchanged → no
   CR rename), singletons to two levels, `spec.edition` rewrite.
3. gentian-os: addon activation reconciler; invert/remove implicit base install.
4. gentian-ui + app-store: store filter, preset rendering, selection window, Edit
   button, git write path.
5. Nextcloud conversion (§4) — the long pole.
6. gentian-deployments: re-install the demo tenant from the new catalogue.
7. Documentation sweep (§7), last, so it describes what shipped.
