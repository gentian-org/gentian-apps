# Backlog

Ideas and proposals not yet scheduled for implementation.

Once something is actually intended, it moves to [roadmap.md](roadmap.md) as a
numbered item that can be referenced from a board. Entries here may also simply
be abandoned — that is the point of keeping the two apart.

## ~~Restructure `profiles/` — group by family, drop the flat layout~~ — **done**

Implemented 2026-08-06 (`gentian-apps` 4bc20fa, `gentian-os` 5500d2f). The rationale
now lives in [app-profile-guide.md](app-profile-guide.md) §0, which generalizes it into
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
(openDesk). A maintained edition (`me`: the community edition's code, curated and
maintained by Aluvian, which runs it itself) keeps the `-ce` name; its edition is
the `gentianos.io/profile-edition` label. `nextcloud-office` (the old standard edition) was dropped; the office
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

