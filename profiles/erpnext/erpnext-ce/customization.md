# Customization ladder — ERPNext (family `erpnext`)

**Grade: B** · rubric score **5/8** · characterised 2026-10-19

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | [Frappe site and bench configuration](https://docs.frappe.io/framework/user/en/basics/site_config) (`site_config.json`, `common_site_config.json`) |
| Declared drop-in directories | 0 | Frappe reads two JSON files, no directory; `charts/erpnext` writes them from values |
| Documented plugin/addon API | 1 | Frappe apps: hooks, doctypes, whitelisted methods ([docs](https://docs.frappe.io/framework/user/en/basics/apps)) |
| Plugin API versioned + deprecation policy | 0 | Major versions break apps (v15 → v16 moved the desk to `/desk`); no written deprecation policy |
| Published HTTP API with a spec | 0 | REST at `/api/resource` and `/api/method`, documented, no machine-readable spec |
| Upstream accepts patches | 1 | Active GitHub projects (frappe/frappe, frappe/erpnext), PR flow |
| Plugin ABI survives minor releases | 1 | An app built for a major version runs across its minor releases |
| Test harness for plugin authors | 1 | `bench run-tests`, Frappe's test case classes |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `charts/erpnext` values: site name, sign-in, default role, mail, Redis limits, gunicorn, resources |
| **L1** Drop-in | no | nothing to drop in: Frappe's configuration is two JSON files the chart owns |
| **L2** Companion | always | Frappe's REST API, with an API key of a user made for the companion |
| **L3** Extension | not yet | a Frappe app has to be in the image (`bench get-app` at build time); there is no image build for one here, so nothing delivers it |
| **L4** Repackage | yes | `charts/erpnext` (`chartOwnership: gentian-owned`), the unmodified upstream image |
| **L5** Patch | no | no build pipeline for a patched image |
| **L6** Fork | no | not permitted |

In-app customization (custom fields, Customize Form, workflows, print formats, server and client
scripts) is the tenant's own data in the site's database, made by the tenant's System Managers.
It is not a rung: it travels with a backup and survives upgrades the way ERPNext's own data does.

## Notes

**Why the chart is the platform's.** Frappe's chart (frappe/helm) creates the site with the
database server's root account, runs a root container to chown the volume and adds `CAP_CHOWN`
to every container, splits the bench over eight Deployments sharing a ReadWriteMany volume, and
brings its own MariaDB and Redis. Each of those is in most of its templates, so a patch series
would replace nearly all of it. `charts/erpnext` keeps the image and the commands and runs every
process in one pod on one ReadWriteOnce volume. That pod is one replica: more needs
ReadWriteMany storage and the processes split apart.

**Database without an administrator.** `bench new-site --no-setup-db` loads the site into a
database and user that already exist; `db_user` is a site setting since Frappe v16, so the user's
name need not be the database's. The image's mariadb client (11.8) asks for TLS by default,
which the platform's server does not offer; the chart's `my.cnf` says `skip-ssl`
(`database.tls: false`).

**Redis in the pod.** Frappe's shared keys (assets manifest, app hooks, concurrency semaphores)
are not prefixed per site, and realtime events and client-cache invalidations use fixed pub/sub
channels. On the platform's shared Redis every tenant's ERPNext would be one bench. Two Valkey
processes on 127.0.0.1 in the pod replace it; nothing is persisted, so a restart loses queued
background jobs.

**Realtime.** Frappe's socket server checks a socket's Origin against its Host and then asks the
backend, at that Origin, whose session it carries. nginx checks the Origin against the site and
points the socket server at itself inside the pod, so the call does not leave the pod.

**Sign-in.** Frappe's built-in Keycloak login (Social Login Key `keycloak`), written on every
start. A first sign-in finds an existing account by email, or creates one with the role
"Desk User". The password form is off (`signIn.passwordLogin: false`); Frappe refuses that
while no other way in exists, so the chart turns it on again when the realm's sign-in is not
configured. While the form is off, the chart's nginx adds a script to Frappe's login page that
follows its Keycloak link, so nobody sees the page. Frappe implements no back-channel logout, so
a portal sign-out leaves the ERPNext session to expire on its own, and ERPNext's own logout
signs the person straight back in while their realm session lasts.

**App administrators.** `hooks.provisioning` converges System Manager to exactly the tenant's
app administrators, through Frappe's REST API as Administrator with the API key the chart writes
on every start. Administrator itself is never changed. An administrator who has not signed in
yet gets an account by email, which their first sign-in takes.

**Upgrades.** The configure step records the image's Frappe and ERPNext versions beside the
site and runs `bench migrate` when they differ. An upgrade across a major version (v16 → v17)
needs Frappe's own notes read first; nothing here prevents one.

## Restore

The start after a restore renames the site's directory to this host when it was written under
another, writes the database, credentials and address it is given now, and migrates when the
bundle came from another version. `restore.post` clears Frappe's cache; `restore.verify` opens
the database through the site's configuration (`bench execute frappe.ping`). Frappe's own
backups in `private/backups` are left out of the capture.
