# Backlog

Ideas and proposals not yet scheduled for implementation.

## ~~Restructure `profiles/` — group by family, drop the flat layout~~ — **done**

Implemented 2026-08-06 (`gentian-apps` 4bc20fa, `gentian-os` 5500d2f). The rationale
now lives in [app-profile-guide.md](app-profile-guide.md) §0, which generalises it into
the distribution-repo model the whole repo layout follows.

**What shipped:** multi-profile families moved one level deeper
(`profiles/odoo/odoo-cb-*/`, `profiles/nextcloud/nextcloud-*/`); the 7 true singletons
stayed flat. Leaf directory names unchanged, so no CR renames.

**Two deviations from the original proposal, both deliberate:**

- **No third "app" level.** The proposal nested edition/flavor between family and leaf
  (`nextcloud/office/nextcloud-office/`). No app currently has sibling variants of one
  edition, so that level would have been a single-child directory everywhere. Added when
  a real sibling group appears (e.g. `nextcloud-office` + `nextcloud-office-pro`), not
  before.
- **Application names still use `path.basename`, not the full relative path.** The
  proposal wanted full-path naming for collision safety. But leaf names must equal
  `metadata.name`, and `AppProfile` is cluster-scoped — so leaf names are globally unique
  *by construction*, and CI now enforces that invariant directly. Basename naming means
  regrouping a profile updates its Application's source path in place instead of
  renaming it; with the ApplicationSet running `prune: true`, a rename would have
  deleted and recreated every live `AppProfile` CR. The migration ran with zero
  Application churn as a result.

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
