# L3 cleanup — one addon model

**Status:** In progress. Design settled (§6). **Shipped:** `spec.author` + `AppPackage`
(`a1b79c0`), the addon role + `Tenant.spec.apps[].addons` + ce/me/pro editions
(`6e0d19c`, narrowed `4a90d6d`), and the catalogue layout — odoo `base/`+`addons/`,
singleton family folders, editions and authors across all 22 profiles
(gentian-apps `2322f9a`). **Remaining:** the addon activation reconciler, the App
Store UI, and the Nextcloud conversion — §8 steps 3–7.
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
a fact that a field owns.

**`spec.author` — implemented** (gentian-os `a1b79c0`). Records who supplies and
maintains *this entry*: a company (vendor), an organisation, or an individual. It
describes the catalogue entry, not the upstream project, so one application can
appear as several profiles from different authors. `spec.edition` + `spec.author`
are the authoritative pair; the App Store renders "Pro edition by openDesk" from the
fields rather than parsing `-od` out of a name.

**Populated on all 22 profiles** by the agreed rule: `ce` → the upstream
organisation, `me` → Gentian, `pro` → the supplying vendor. That rule is why
`activepieces` and `litellm` are authored by Gentian rather than upstream — both are
`me` editions (Gentian carries a patch series for activepieces and runs litellm), and
attributing a maintained edition to upstream would misstate who is on the hook for it.
Odoo profiles credit **OCA**, not Odoo S.A., because the base image builds from
`OCA/OCB` (see `ocb/UPSTREAM`).

### 2.3 Packages become UI presets

A package is **not a deployable profile**. It is a very small file that adds an option
to the UI which pre-selects a subset of addons — the user can then adjust the
selection before installing.

**The `AppPackage` CRD is implemented** (gentian-os `a1b79c0`): cluster-scoped, no
`status`, no reconciler, no workload.

```yaml
# profiles/nextcloud/packages/nextcloud-suite.yaml
apiVersion: gentianos.io/v1alpha1
kind: AppPackage
metadata:
  name: nextcloud-suite
spec:
  family: nextcloud                    # required — offered only for this family
  displayName: Nextcloud Suite         # required
  description: Files, office, groupware and collaboration.
  addons:                              # required, min 1
    [nextcloud-richdocuments-ce, nextcloud-forms-ce, nextcloud-mail-ce,
     nextcloud-calendar-ce, nextcloud-contacts-ce, nextcloud-tasks-ce,
     nextcloud-deck-ce, nextcloud-collectives-ce, nextcloud-spreed-ce]
  author: Gentian
  tile: { icon: cloud }
```

The addon list is a **starting point, not a constraint**: the user may untick any
entry and add addons the preset omits. A preset may name a `pro` addon the tenant
is not entitled to — that renders with a Buy button rather than blocking install.

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
| 1 | ~~`Tenant.spec.apps[].addons`~~ **done** (`6e0d19c`) | Selected addon set for that app. Additive. |
| 2 | ~~role rename~~ **done** (`6e0d19c`) | `addon` is now the word; `module` kept as a deprecated input alias that normalises to Addon, with a regression test. |
| 3 | **Invert `implicit_base_apps.go`** | Today installing a module profile injects its `requires-profile` base. Target: install base, select addons — addons never appear in `spec.apps`. This logic becomes dead; confirm before deleting. |
| 4 | ~~Addon activation~~ **done** (`b0acd19`, `4aeaa8d`, `6b3e91d`) | Two shapes, both catalogue-driven. Odoo has its own composition and installs database-side via one `-i` Job. Chart-based apps declare `spec.customization.addonActivation` (values path + script) and `app-default` renders it — nothing in gentian-os knows what `occ` is. |
| 5 | ~~`spec.edition` → `ce · me · pro`~~ **done** (`6e0d19c` widen → `4a90d6d` narrow) | Migrated in two phases so old and new values were briefly both valid; narrowing caught `open-webui`, which ships from gentian-ui not the catalogue. Default is now `ce`. |
| 6 | ~~`spec.author`~~ **done** (`a1b79c0`, populated `2322f9a`) | Who supplies this entry — company, organisation or individual. Set on all 22 profiles per the §2.2 rule. |
| 7 | ~~Entitlement gates activation~~ **done** (`e7c53e9`, `90b42dc`) | `EntitledAddons` denies by default in the reconciler, and the lifecycle API rejects an unentitled selection before writing git. Per §2.1 authorization is the gate, never technical compatibility. |
| 8 | Addons stop being App claims | An addon is activation state inside the base app, not its own workload. Check `app_reconciler.go`. |
| 9 | ~~`AppPackage` kind~~ **done** (`a1b79c0`) | Cluster-scoped, no status, no reconciler. gentian-ui granted read access (`29545416`). |

**Ordering trap (hit twice already):** CRD enum/field changes are admission-validated,
so gentian-os ships and syncs *before* gentian-apps uses the new values. Same lesson
as the `patched` chartOwnership enum and the catalogue ApplicationSet generator.

### 3.2 `gentian-apps` — catalogue

| # | Change | Notes |
|---|---|---|
| 10 | ~~Odoo → `base/` + `addons/`~~ **done** (`2322f9a`) | Leaf names unchanged → source-path update in place, no prune. |
| 11 | ~~`deployment-role: addon` on all 9~~ **done** (`2322f9a`) | `requires-profile` still present; drop once (3) lands. |
| 12 | ~~Nextcloud: base + addons + presets~~ **done** (`6c7f2e1`, `1b91f4a`) | One image staging 9 apps disabled in `custom_apps/`; 2 bases, 9 addons, 2 presets. See §4. |
| 13 | ~~Singletons → `profiles/<family>/<family>-<edition>/`~~ **done** (`2322f9a`) | Genuine renames; cheap only because nothing was installed. |
| 14 | ~~editions + authors on all profiles~~ **done** (`2322f9a`, `66bcbc9a`) | Derived from the leaf tier; author follows ce=upstream / me=Gentian / pro=vendor. Corrected activepieces and litellm to Gentian — both are `me`. |
| 15 | ~~CI validates addon declarations~~ **done** (`1b91f4a`) | An addon must declare `customization.addon.{id,of}` and must **not** restate `grade`/`rubricScore`/`supportedRungs` — its ladder is the base's, and copying it forks a mutable fact. Name ↔ edition is still deliberately unvalidated (§2.2). |

### 3.3 `gentian-ui` + `apps/app-store` — the UI change

| # | Change | Notes |
|---|---|---|
| 16 | ~~Store grid filters addons~~ **done** (`1b91f4a`, `b98bc2d`) | Backend-side, so no client can list an addon as installable. Presets render as bundle buttons in the window. |
| 17 | ~~Addon selection window~~ **done** (`b98bc2d`) | `frontend/src/components/AddonWindow.tsx`. Unentitled commercial addons are shown but disabled. |
| 18 | ~~**Addons** button on installed apps~~ **done** (`b98bc2d`) | Shown only when the catalogue reports `hasAddons`, and only on Ready apps — an app still installing has no release to activate into. |
| 19 | ~~Writes go through the **git** path~~ **done** (`90b42dc`) | `PUT /v1/tenants/{tenant}/apps/{profile}/addons` in applifecycle commits to gentian-deployments. `Tenant` is GitOps-managed with `selfHeal: true`, so a direct patch would be reverted and would violate the no-hand-patching rule. |

`gentianOdooModules` (`gentian-ui/backend/app/services/keycloak_admin_store.py`,
`api/routes/admin.py`) **stays as-is** — Odoo calls its addons modules, so an
Odoo-specific attribute using Odoo's word is correct.

### 3.4 `gentian-deployments`

| # | Change | Notes |
|---|---|---|
| 20 | ~~allowlist + tenant refs follow the renames~~ **done** (`bfc2ff7`) | Both the `tenants/` and `definitions/` trees, incl. the `otro` tenant. |
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
| 5 | Scale: one Application per addon | **Individual CRs per addon, one bundle each.** Packages absorb the resulting UI complexity. See §6.1. |
| 6 | Rename `gentianOdooModules`? | No — Odoo calls its addons modules, so an Odoo-specific attribute using Odoo's word is correct. |

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

## 7. Documentation to adapt — **done**

The terminology sweep is complete (`24edf0f`+). "module" now appears only where it is
upstream's own word: Odoo modules, the Synapse Module API, and identifiers like
`odoo-modules`, `gentianOdooModules`, `initModules`, `git-modules`. References to
"module" remaining *in this document* are deliberate — it describes the rename.

API identifiers renamed with it: `extension.modulePath` → `addonPath`,
`extension.perTenantModules` → `perTenantAddons`, `delivery: module-profile` →
`addon-profile` (old value still accepted until the catalogue finishes migrating).

Counts below were the occurrences before the sweep.

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

## 8. Order — status

1. ~~gentian-os CRD changes~~ **done** — `Tenant.spec.apps[].addons`, role rename with
   alias, `edition` enum, `author`, `AppPackage`. Shipped and synced before step 2.
2. ~~gentian-apps reshuffle~~ **done** — Odoo to `base/` + `addons/`, singletons to two
   levels, `spec.edition` rewrite.
3. ~~Addon activation~~ **done** — both shapes (Odoo composition Job, `addonActivation`
   for chart-based apps). Inverting the implicit base install is the one item left; see
   the note below.
4. ~~app-store~~ **done** — store filter, preset rendering, selection window, Addons
   button, git write path.
5. ~~Nextcloud conversion (§4)~~ **done** — one image, 2 bases, 9 addons, 2 presets.
6. gentian-deployments: re-install the demo tenant from the new catalogue.
7. ~~Documentation sweep (§7)~~ **done** for the framework and profile guides.

### Still open

**Retire `implicit_base_apps.go` (item 3).** It is deliberately still live. It injects an
addon's base when the addon appears in `spec.apps`, which is now the *old* way to install
one — but until every caller selects addons through the window instead, deleting it would
break the only path that still works for anything not yet migrated. Remove it once no
tenant file lists an addon under `spec.apps`, and drop `requires-profile` (item 11) and
the `module-profile` delivery enum value in the same change.

**Odoo's per-addon composition branch.** Still present alongside the new base-side
activation Job for the same reason: it is what installed addons before, and removing it
is a separate, verifiable step.

**Deselection on Odoo.** Nextcloud reconciles — deselecting disables the app and keeps its
data. Odoo's `-i` only installs; deselecting an Odoo addon stops activating it but does not
uninstall the module, because uninstalling an Odoo module drops its tables. That asymmetry
is intentional and should be surfaced in the UI before Odoo addons are offered to tenants.
