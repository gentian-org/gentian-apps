# Backlog

Ideas and proposals not yet scheduled for implementation.

## Restructure `profiles/` — group by family, drop the flat layout

**Problem:** `profiles/` is a flat list of 21+ directories. It already conflates three
different relationships that the flat listing hides: base+module bundles (`odoo-cb-*`,
9 entries), edition variants of one product (`nextcloud-{base,office,office-plus,suite}`),
and true singleton apps. This only gets worse as more Odoo modules or split-module apps
(OX) are added.

**Constraint found during research:** the catalogue sync
(`gentian-os/kernel/bootstrap/catalogue-applicationset.yaml.tmpl`) is an ArgoCD
`ApplicationSet` with a git **directory generator** on `path: profiles/*` — exactly one
level deep, one Application per immediate subdirectory. Two more places assume the same
one-level depth today and would need to change alongside it:

- `scripts/validate-profile-tiles.py` — `PROFILES.glob("*/profile.yaml")`
- `.github/workflows/apps-ci.yaml` (`validate-profiles` job) — `for d in profiles/*/`

None of this affects the operator at runtime — `AppProfile` CRs are loaded cluster-wide
into a flat map keyed by `metadata.name`
(`gentian-os/internal/controller/appprofile_index.go`), with zero awareness of directory
layout. Reorganizing `profiles/` is a pure CI/GitOps discovery change.

**Proposed layout** — group by `spec.family`, nested one level further by "app"
(edition/flavor) only where an app actually has multiple sibling variants; leave true
singletons flat. Leaf directory names are unchanged (`odoo-cb-base`, not shortened) so
migration is a plain `git mv` with no CR renames:

```
profiles/
  odoo/
    base/
      odoo-cb-base/
    hr/
      odoo-cb-hr/
    erp/
      odoo-cb-erp-solid/
  nextcloud/
    base/
      nextcloud-base/
    office/
      nextcloud-office/
      nextcloud-office-pro/
      nextcloud-office-pro-opendesk/
    office-plus/
      nextcloud-office-plus/
    suite/
      nextcloud-suite-solid/
  activepieces/        # singleton, stays flat
  app-store/
  element/
  gentian-subscriptions/
  litellm/
  openproject/
  xwiki/
```

**Generator fix:** switch the ApplicationSet from a *directory* generator to a git
*files* generator matching `profiles/**/kustomization.yaml`. This supports the mixed
depth (singletons at depth 1, grouped families at depth 2) without an exclude-list of
"known family folders" to maintain. Derive the Application name from the full relative
path (not `path.basename`) so two families can never collide on a shared leaf name.

**Explicitly rejected:** a third literal `tier` directory level
(`family/app/tier/...`). `pro-opendesk` (a branded variant *within* `pro`, not a sibling
of it) shows tier isn't a clean fixed enum — nesting it just reopens the same "how many
levels is enough" problem one level deeper. Tier only has real value as a queryable
field (App Store badges, operator entitlement gating, CI stub checks), not as physical
locality — unlike `family`/`app`, a `pro` bundle and a `free` bundle of the same app
share almost nothing on disk. Encode tier as a suffix in the leaf name for humans, and
as a real `spec.tier: free | pro | solid` field (new, not yet implemented) for machines,
so path and field can't drift apart into two disagreeing sources of truth.

## Pro / Solid tiers in the catalogue

**Pro apps must be listed in the App Store**, not hidden until purchase. Folders in
`gentian-apps/profiles/` for pro (and possibly solid) tiers are stubs *beyond the
AppProfile bundle*: `profile.yaml` + `kustomization.yaml` (+ `composition.yaml` /
`assets/` if the app needs them) live here like any other profile, but there is no
`apps/<id>/` implementation folder (no backend/frontend/Dockerfile source — Gentian
doesn't own that code), and `spec.chart.repository` points at a **private** OCI
registry host instead of `ghcr.io/gentian-org/charts`.

This matches the target model already documented (but not yet executed) in
`gentian-pro/README.md` and `gentian-corp/docs/architecture.md`:

- `gentian-apps/profiles/` stays the single source of truth for *all* catalogue
  metadata, free and commercial alike (commercial entries carry `license: proprietary`).
- `gentian-pro` shrinks to hosting only the private chart/image artifacts those
  `chart.repository` coordinates reference — the `od-*` bundles currently living there
  in full (with `composition.yaml`) are a pending migration into `gentian-apps`, not the
  intended end state.
- `gentian-corp` (+ `gentian-frontpage`) is the commercial/entitlement layer: Buy button
  → checkout → the operator verifies an install grant against it before pulling the
  private chart. Gating happens **at install time by the operator**, not by hiding
  catalogue metadata — pro/solid tiles stay visible in the Store, just locked until
  entitled.

**New "solid" tier:** a set of apps curated by Gentian itself (as opposed to `pro`,
curated by third-party suppliers) for MSP customers to rely on. Whether `solid` sits
behind a paywall is undecided — model it so that decision is a single field flip, not a
structural one: give it `spec.tier: solid` and let a separate field (e.g. `license` or a
`paywalled` boolean) decide whether the operator's entitlement check applies. That way
turning the paywall on/off later needs no directory or repo move.

**Open items:**
- Design and add the `spec.tier` field (name TBD) on `AppProfile`, plus CI enforcement
  that `pro`/`solid` stub bundles don't accidentally ship implementation source or a
  public `chart.repository`.
- Decide the App Store UI treatment for `solid` (badge/messaging distinct from `pro`).
- Migrate `gentian-pro/profiles/od-*` bundles into `gentian-apps/profiles/` per the
  target model above.
