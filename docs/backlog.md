# Backlog

Ideas and proposals not yet scheduled for implementation.

Once something is actually intended, it moves to [roadmap.md](roadmap.md) as a
numbered item that can be referenced from a board. Entries here may also simply
be abandoned — that is the point of keeping the two apart.

## ~~Restructure `profiles/` — group by family, drop the flat layout~~ — **done**

Implemented 2026-08-06 (`gentian-apps` 4bc20fa, `gentian-os` 5500d2f). The rationale
now lives in [app-profile-guide.md](app-profile-guide.md) §0, which generalises it into
the distribution-repo model the whole repo layout follows.

**What shipped, in two passes.** The first pass grouped by family only
(`profiles/odoo/odoo-cb-crm/`) and deliberately skipped the proposal's third
"app" level, on the grounds that no app yet had sibling variants of one edition.
The second pass added it once those siblings became real, giving the full
`family / app / leaf` shape the proposal originally described:

```text
profiles/
  nextcloud/{drive,office,suite}/nextcloud-<app>-<tier>/
  odoo/{base,accounting,calendar,crm,…}/odoo-<app>-ce/
  <singleton>/                                   # 7 apps, still flat
```

Leaf names now carry an explicit tier suffix — `ce` (Community Edition), `od`
(openDesk), `me` (Managed/Maintained Edition, the build Gentian maintains for MSP
customers). `nextcloud-office` (the old standard edition) was dropped; the office
group is now the former `office-plus` content as `nextcloud-office-ce`.

**Application naming still uses `path.basename`, not the full relative path.** The
proposal wanted full-path naming for collision safety, but leaf names must equal
`metadata.name` and `AppProfile` is cluster-scoped — so leaf names are globally
unique *by construction*, and CI enforces that invariant directly.

**Cost of the second pass, recorded honestly:** because leaf name *is*
`metadata.name`, renaming a profile renames its Application, and with the
ApplicationSet running `prune: true` that deletes and recreates the live
`AppProfile` CR. For the three profiles the demo tenant had installed
(`odoo-cb-base`, `odoo-cb-accounting`, `nextcloud-suite`) this also tore down the
App claim, its Helm release, the chart's templated PVC and the per-tenant
database. That was accepted deliberately for a demo tenant. **On a tenant with
real data, a profile rename is a data migration, not a rename** — publish the new
name alongside the old, move tenants across, then retire the old profile.

**Also landed alongside:** `charts/packages/` (21 stale tarballs + `index.yaml` from a
pre-OCI Helm HTTP repo) removed — CI publishes to `oci://ghcr.io/gentian-org/charts`,
which is the artifact store. See app-profile-guide.md §0 "version packaging, never built
artifacts".

**Follow-up, now also done** (`ab12e1b`): `charts/activepieces/` was a full vendored copy
of upstream including Bitnami postgresql/redis subcharts. It now carries pinned upstream
(`UPSTREAM`) plus a 5-patch DEP-3 series — net −22,086/+495 lines. Three of those patches
turned out to be genuine upstream bugs that a copy had been hiding; they now have
`Forwarded:` headers so offering them upstream is tracked. Built by
`scripts/build-activepieces-chart.sh`, which CI runs on pull requests too so a stale
series fails review instead of merging.

Note the delta was only 240 lines across 4 files — worth checking before assuming any
other "vendored" chart needs to stay that way.

## L3 cleanup — one addon model, no packages

Moved to its own tracking document: **[app-customization.md](../../gentian-os/docs/app-customization.md) §4.2**.

The second directory layer currently means *addons* for Odoo (individually
installable, one profile each) and *packages* for Nextcloud (fixed plugin bundles
baked into an image) — the same slot with incompatible semantics, scaling badly in
opposite directions. The plan unifies both as customization-ladder rung L3
"addons", decommissions packages, and moves addon selection out of the App Store
grid into a post-install window plus an Edit button.

It also **settles the edition-vocabulary question** left open below:
`minimal · standard · full · performant` is replaced by **`ce · me · ee`**. `od` is
not an edition — openDesk is a *supplier*, so `nextcloud-office-od` is an `ee`
edition supplied by openDesk. Leaf names are free-form hints; `spec.edition` is
authoritative, and nothing may derive the edition from a name.

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
- Migrate the remaining `gentian-pro/profiles/od-*` bundles into `gentian-apps/profiles/`
  per the target model above. **`od-nextcloud` is done** — it now lives at
  `profiles/nextcloud/office/nextcloud-office-od` (still `license: proprietary`, still
  pointing at the openCode private registry, exactly as the model prescribes). The copy
  under `gentian-pro/profiles/od-nextcloud` is now redundant and should be removed in a
  gentian-pro commit. Remaining: `od-element`, `od-openproject`, `od-ox-appsuite`,
  `od-xwiki`.
- Reconcile the tier suffix with `spec.tier`. Leaf names now encode tier as
  `-ce` / `-od` / `-me`, but there is still no queryable field — so App Store badges and
  operator entitlement gating cannot read it. The suffix and the future field must not
  become two disagreeing sources of truth; add the field and derive/validate the suffix
  from it in CI.
