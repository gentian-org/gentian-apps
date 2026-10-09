# Customization ladder — Nextcloud (family `nextcloud`)

**Grade: A** · rubric score **7/8** · characterised 2026-08-06
Applies to `nextcloud-base-ce` and the `nextcloud-office-*` / `nextcloud-suite-*` profiles.

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `config.php` admin manual |
| Declared drop-in directories | 1 | `config/*.config.php` is an upstream-documented drop-in dir |
| Documented plugin/addon API | 1 | Nextcloud apps (OCP) + AppAPI ExApps |
| Plugin API versioned + deprecation policy | 1 | `max-version` in `appinfo/info.xml`; OCP deprecation cycle |
| Published HTTP API with a spec | 1 | OCS + WebDAV; `file-store` / `filepicker` contracts |
| Upstream accepts patches | 1 | active GitHub PR flow |
| Plugin ABI survives minor releases | 1 | apps pin a server major; OCP is stable within it |
| Test harness for plugin authors | 0 | app test tooling exists but is not a supported harness |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → upstream `nextcloud/nextcloud` chart values |
| **L1** Drop-in | yes | `config` (`/var/www/html/config`, PHP fragments — **not** tenant-editable: it is executable config) and `theming` (static assets, tenant-editable) |
| **L2** Companion | always | consume `file-store` / `filepicker`; or ship an **ExApp**, which is Nextcloud's own name for a side-by-side extension |
| **L3** Extension | yes | a Nextcloud app installed via `occ app:install` from `spec.postInstallJob` |
| **L4** Repackage | yes | upstream chart + `extraValues`; composition for bootstrap sequencing |
| **L5** Patch | **no** | not permitted — the app and ExApp surfaces are rich enough that a patch signals a wrong turn |
| **L6** Fork | **no** | not permitted |

## L2 vs L3 here

Nextcloud is the clearest case in the catalogue of both rungs being first-class, and upstream
names them: a **PHP app** runs inside the server (L3); an **ExApp** (AppAPI) is a container
alongside it (L2). Apply the framework's tie-breaker — if the function must appear in the
Nextcloud UI and touch its data model, write an app; otherwise write an ExApp or a Gentian
companion, which survives major-version upgrades unchanged.

## Gotchas

- `config/*.config.php` fragments are **executable PHP**. They are declared `tenantEditable:
  false` deliberately — a tenant-supplied fragment would be arbitrary code execution.
  Tenant self-service is limited to `theming` assets.
- App installation is a runtime operation via `occ`; it is not idempotent across chart
  re-renders, so it belongs in a post-install Job, not in values.
- `appcodechecker` rejects apps using private APIs — a good early signal that a customization
  is reaching past the supported extension point.

## Signing out

When a person signs out at the platform, the realm tells Nextcloud, and Nextcloud ends that
person's session: `requires.services.identity.oidc.backchannelLogout` names the path
`/apps/user_oidc/backchannel-logout/gentian` on the entry `web`, and the platform registers it
with the realm at Nextcloud's own Service inside the cluster
(`http://nextcloud.<namespace>.svc.cluster.local:8080/…`), not at `cloud.<domain>`.

What `user_oidc` 8.10.1 checks before it ends anything (`lib/Controller/LoginController.php`,
`backChannelLogout`): the logout token's signature against the realm's published keys; that its
audience is this client; that it carries the back-channel logout event and no nonce; and that a
session it recorded at sign-in exists for the token's session id, person and issuer together. It
then invalidates that one session's Nextcloud token. A token that fails any of these ends
nothing.

It ends the session of the browser that signed out, by the realm's session id; the same person
signed in elsewhere from another realm session stays signed in there.

Nextcloud answers under its Service's name without that name being listed under
`trustedDomains`: `overwritehost` is set (`gentian-proxy.config.php`), and Nextcloud does not
hold a request to that list then.

Shown against the catalogue's image and Keycloak 26.8.0 in `e2e/oidc-sign-out/nextcloud.e2e.js`:
the realm posts to the Service's address, the cookie of the person who signed out is refused
afterwards, another person's is not, and a token signed with another key, an unsigned one and
the realm's own token a second time end nothing. The realm posts once: if Nextcloud is not
running at that moment the session lasts as long as Nextcloud keeps it.
