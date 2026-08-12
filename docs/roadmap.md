# Gentian Apps — Catalogue Roadmap

Planned, numbered work items for the app catalogue: profiles, charts, images, and
the platform behaviour they depend on. Items are numbered so they can be
referenced from a Kanban board and in commit messages.

This is not the same document as [backlog.md](backlog.md), and the two should
not be merged. Backlog holds unscheduled ideas and proposals in prose, including
ones later abandoned; a roadmap item is work someone intends to do, broken into
checkable steps.

Kernel-side work is tracked separately in
[gentian-os/docs/roadmap.md](https://github.com/gentian-org/gentian-os/blob/main/docs/roadmap.md).
An item appears **here** when it was found characterising a catalogue app or
changes what profiles may assume, even when the fix itself lands in gentian-os —
in that case the item says so explicitly, so nobody goes looking in the wrong
repository.

Priority markers follow the gentian-os convention: `(*)` near-term, `(**)`
planned, `(***)` larger or longer-horizon.

---

## 1. Security & Hardening

### 1.1 Revoke PUBLIC CONNECT on Per-App PostgreSQL Databases (**)
* **Target Domain**: Tenant Data Isolation
* **Implementation lands in**: `gentian-os` — `buildRoleScript` in
  `internal/controller/database_reconciler.go`. Tracked here because it was
  found while characterising a catalogue app's data access, and because it
  changes an isolation property every profile relies on.
* **Context**: Every tenant app role can open a connection to every *other*
  tenant app's database on the shared CloudNativePG cluster. This is
  PostgreSQL's default — `CONNECT` is granted to `PUBLIC` on database creation
  and nothing revokes it — not a Gentian decision.

  **This is not currently a data leak, and the item should not be written up as
  one.** Reads were verified to fail in both catalogue layouts, as the app role
  of an unrelated app:

  | App layout | Result |
  |---|---|
  | App-schema (`odoo-base-ce`) | `ERROR: permission denied for schema demo_odoo_base_ce` |
  | Public-schema (`activepieces-me`) | `ERROR: permission denied for table migrations` |

  Table and schema privileges are owner-only and are never granted to `PUBLIC`,
  and PostgreSQL 15+ already revokes `CREATE` on `public` from `PUBLIC`. What an
  open `CONNECT` does expose is `pg_catalog`: one app can enumerate another's
  schemas, tables, columns and role names — structure, not contents — and can
  create temporary tables on the connection. It is a missing layer of
  defence-in-depth, and it is the gate that would matter first if any app ever
  granted table privileges more broadly.

  Database ACLs show the default `=Tc/"<owner>"` (empty grantee is `PUBLIC`,
  with CONNECT+TEMP) on every tenant database except `demo_nextcloud_base_ce`,
  which carries only its owner entry. So the revoke has been applied once,
  somewhere, and never made uniform — worth finding, because whatever did it is
  either a fix to generalise or a manual change to delete.
* **Proposed Solution**: Revoke `CONNECT` from `PUBLIC` on every per-app
  database at provisioning time, so a database denies unrelated roles from
  creation onward rather than relying on table ownership as the only barrier.
  The role Job is the right place: it already runs on every reconcile, so
  existing databases converge without a migration.
* **Risks to check before doing it**: an app that legitimately shares a database
  across more than one role would start failing and needs an explicit grant;
  and the revoke must not strip the owner's own access. Both are covered by
  provisioning a two-app tenant and confirming each app still connects.
* **Backlog Items**:
  - `[ ]` Add `REVOKE CONNECT ON DATABASE "<db>" FROM PUBLIC;` to `buildRoleScript`, after the owner grant.
  - `[ ]` Confirm existing databases converge on the next role Job, with no separate migration.
  - `[ ]` Find what revoked `CONNECT` on `demo_nextcloud_base_ce` and either generalise it or remove it.
  - `[ ]` Add a test asserting an unrelated app role cannot connect to another app's database.
  - `[ ]` Note the isolation guarantee in [app-profile-guide.md](app-profile-guide.md) so profiles can rely on it.
