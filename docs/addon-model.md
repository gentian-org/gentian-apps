# The addon model — bases, addons, editions and packages

How a Gentian app is split into a deployable **base**, the **addons** activated
inside it, the **editions** that distinguish who supplies it, and the **packages**
that are only presets over a selection. This is the settled model, not a plan: it
is the rung-L3 shape referenced from the `AppProfile` and `Tenant` CRD field
documentation.

This document replaces `L3-cleanup.md`, which tracked the migration onto this
model. That migration is complete and its bookkeeping is in git history
(`gentian-apps` up to `54b38d4`). Section numbering under §2 is preserved from it,
because the published CRD descriptions cite §2.1, §2.2 and §2.3 by number.

**Companion to:** [app-profile-guide.md](app-profile-guide.md) §0 (repo layout),
[customization-ladder.md](customization-ladder.md),
[gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md) (rung L3)

---

## 1. Why one model

Before this, "addon" meant three different things: an Odoo module profile carrying
a `requires-profile` annotation, a Nextcloud app baked into a bundle image, and a
package of apps sold as one catalogue entry. Each had its own install path, its own
vocabulary, and its own idea of what a user was choosing. The result was that
selecting an addon and installing an app were the same operation in one place and
different operations in another.

One model: a **base** is deployable, an **addon** is activation state inside a base
and never installs on its own, an **edition** says who supplies a profile, and a
**package** is a preset over a selection with no deployable of its own.

---

## 2. The model

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

### 2.4 What a user sees

Addons are absent from the App Store grid — they are not installable on their own.
After install or provision, a window opens with the addon list, pre-selected if a
package was chosen, and Buy buttons on `pro` addons. An **Addons** button on the
installed app reopens the same list later.

Each addon offers **Install**, **Provision** and **Remove** rather than a checkbox:
install turns it on and leaves access to be granted by group membership, provision
turns it on and grants it to every existing user. A checkbox cannot express that
difference. Remove is not symmetric across bases and the window says which applies
— see §5.

---

## 3. The Nextcloud bundle

How the model was applied to the largest app; the shape the image and
`versions.env` still follow.

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

## 4. Resolved decisions

| # | Question | Decision |
|---|---|---|
| 1 | Singleton layout | `profiles/<family>/<family>-<edition>/` — two levels, no third layer. |
| 2 | Do packages survive? | Yes, as **UI presets** in a `packages/` folder — very small files pre-selecting a subset of addons. Not deployable. |
| 3 | Sub-tier names (`pro-super`, `pro-bigTec`) | Names are free-form. `spec.edition` is authoritative; CI must not derive edition from a name. Implies a `vendor` field. |
| 4 | Addon↔base compatibility across editions | Editions stay compatible. **Authorization** (paid licence) decides whether an edition may run; **version** manages technical compatibility. No per-edition matrix. |
| 5 | Scale: one Application per addon | **Individual CRs per addon, one bundle each.** Packages absorb the resulting UI complexity. See §6.1. |
| 6 | Rename `gentianOdooModules`? | No — Odoo calls its addons modules, so an Odoo-specific attribute using Odoo's word is correct. |

### 4.1 On Q5 — why one bundle per addon

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

## 5. Notes for whoever works on this

**Removal is not symmetric, and the UI says so.** A base declaring `addonActivation`
reconciles on every start, so Remove genuinely switches an addon off and keeps its
data. Odoo activates through a composition Job using `odoo-bin -i`, which has no safe
inverse — uninstalling a module drops its tables — so Remove stops it being added and
leaves an installed module in place. `build_addon_window` derives which of the two
applies from whether the base declares `addonActivation`, rather than hardcoding a
family, and the window words its Remove line accordingly.

This regressed once and is worth guarding. The selection UI was later changed from
checkboxes to explicit **Install / Provision / Remove** buttons — because a checkbox
cannot distinguish *install* from *provision*, which differ in whether access is
granted to everyone — and the rewrite dropped the derived wording. `deselectBehaviour`
kept being computed and sent, and the window stopped reading it, so every base was
described with Odoo's semantics. Nextcloud users were told nothing would be switched
off when in fact it would be.

**Odoo module visibility is gated in gentian-ui, not by the operator.** Tile visibility
for an Odoo addon depends on a `gentianOdooModules` grant on one of the user's Keycloak
groups. That gate had been inert since the profile rename and is now keyed on
`spec.customization.addon`. It remains Odoo-specific code sitting in the portal; it
belongs with the entitlement model.

**`crossplane/tests/unit/render/app-odoo` in gentian-os holds a copy** of a composition
that lives in this repo, because git cannot symlink across repos. It drifts silently —
it did — so refresh it when changing `profiles/odoo/base/base-ce/composition.yaml`. See
the README in that directory.
