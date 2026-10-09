# Customization ladder — OpenProject (family `openproject-ce`)

**Grade: B** · rubric score **5/8** · characterised 2026-08-06

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `configuration.yml` + `OPENPROJECT_*` env reference |
| Declared drop-in directories | 0 | no upstream-documented config drop-in directory |
| Documented plugin/addon API | 1 | Rails engines registered via a plugins Gemfile |
| Plugin API versioned + deprecation policy | 0 | no published plugin deprecation policy |
| Published HTTP API with a spec | 1 | APIv3, documented |
| Upstream accepts patches | 1 | active PR flow |
| Plugin ABI survives minor releases | 0 | engines routinely break across releases |
| Test harness for plugin authors | 1 | the Rails/RSpec suite is usable by plugin authors |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → upstream `charts.openproject-ce.org` values, `OPENPROJECT_*` env |
| **L1** Drop-in | limited | `branding` only (static assets, tenant-editable). There is no config drop-in directory — a config *file* mount is L4 here, not L1 |
| **L2** Companion | always | **the recommended path.** APIv3 is complete and stable; the `project-management` contract exists. The sign-in handler is one: see below |
| **L3** Extension | yes, expensive | a Rails engine, delivery `image-layer` only — plugins are resolved at build time, so every change is an image rebuild |
| **L4** Repackage | yes | upstream chart (`charts.openproject.org`) + `extraValues`, rendered by the platform's own composition |
| **L5** Patch | **no** | not permitted |
| **L6** Fork | **no** | not permitted |

## Prefer L2

OpenProject is the catalogue's clearest "grade B ⇒ go side-by-side" case. L3 is technically
available but carries the full cost of an image rebuild per change *and* an unstable engine
ABI, while APIv3 is complete enough that most requests can be met by a companion app that
survives upgrades untouched.

Only choose L3 when the function must appear inside OpenProject's own work-package UI and
extend its data model — and when you do, pin `testMatrix` and expect to re-verify on every
upstream minor.

## Gotchas

- Theming beyond the logo is an Enterprise feature. Do not patch to unlock it — see the
  licensing prohibition in `app-profile-guide.md`.
- Seeding (`SEED_*`) runs on first boot only; changing seed data later is a runtime job, not
  a values change.

## Sign-in: the platform's sidecar and this profile's handler

OpenProject's own single sign-on (OIDC, SAML) is part of its paid edition: without a token for
that edition it refuses every provider that is configured
(`modules/auth_plugins/lib/open_project/plugins/auth_plugin.rb`). So
`requires.services.identity.oidc` is not used. The profile declares
`requires.services.identity.sidecar` instead: the platform runs its sign-in sidecar beside
OpenProject and the sidecar runs [`assets/sign-in-handler.js`](assets/sign-in-handler.js). The
record is [`customizations/sign-in-sidecar.yaml`](customizations/sign-in-sidecar.yaml).

A person who is signed in at the platform opens OpenProject and is in: no second sign-in, no
password. OpenProject sends a browser without a session to `/login`; the platform sends a page
load of `/login` to the sign-in; the person lands on OpenProject's front page.

### What the handler does

Checked against the source in `docker.io/openproject/openproject:16.6.10-slim`, and run against
that container, started with this profile's values as the chart starts it
(`images/gentian-sidecar-sso-saml/e2e/openproject.e2e.js`):

| Step | By | OpenProject's own way |
|---|---|---|
| An account for a person who has none | `POST /api/v3/users`, inside the cluster, as the service account the profile configures (global basic auth) | yes — its published interface. An ordinary account |
| Who administers OpenProject | `PATCH /api/v3/users/<id>` with `admin` true or false, as the same service account, when the account is not what the platform's App Admin role says it should be | yes — except taking the flag from the last active administrator, which OpenProject refuses and the handler writes (see "Who administers OpenProject") |
| The password that call demands | a random value, then its row in `user_passwords` deleted | no — the row is deleted in the database |
| An account somebody invited the person's address to | its status set from invited to active, with the name the platform knows the person by | no — written to `users`; OpenProject's own way is a form that sets a password |
| A "stay signed in" token for the account | a row in `tokens` (`Token::AutoLogin`), its value stored as OpenProject stores one: SHA-256 of the value and `secret_key_base` (`app/models/token/hashed_token.rb`) | no — the row is written; the token itself is OpenProject's own feature |
| The session | `GET /login` inside the cluster with the token as the cookie `autologin`: OpenProject signs the account in, answers with its session cookie and links the session to the token (`app/controllers/concerns/accounts/current_user.rb`, `app/services/users/login_service.rb`) | yes — OpenProject makes its own session. No cookie is forged |
| The token, afterwards | its stored value is replaced, so the value opens nothing again; the handler then reads back that the session is this person's and came from this token | — |
| An account locked in OpenProject, or waiting for approval | refused | — |

The browser is given only the session cookie OpenProject made, for as long as the sidecar says:
at most an hour. On OpenProject's side the token's row carries the same end, and the handler
deletes a session whose token has run out — at every sign-in and once a minute. OpenProject has
no lifetime of its own for a session; it deletes a session when its token is destroyed through
its own pages (`app/models/sessions/autologin_session_link.rb`), and the handler does the same
for a token that has run out. Signing out in OpenProject deletes the person's sessions.

### OpenProject's own sign-in is off

`OPENPROJECT_DISABLE__PASSWORD__LOGIN` is set: a password posted to `/login` is answered 404,
and registering, resetting and changing a password go with it
(`app/controllers/account_controller.rb`). That is why `/login` can be the page that leads to the
platform's sign-in although OpenProject's form posts to the same address: the platform redirects
a page load only, and what is posted reaches an OpenProject that accepts no password.
`/account/register`, `/account/lost_password` and `/account/change_password` are refused at the
front door as well.

`OPENPROJECT_AUTOLOGIN` is `1` because `0`, the default, switches the token off altogether. It is
the lifetime in days of a token OpenProject makes itself, which it does only from the password
form that is off.

### Who administers OpenProject

Who holds the platform's **App Admin** role, and nobody else: not the tenant's administrator for
being that, not the first person in.

The role is the tenant's group `gentian:tenant:<tenant>:app-admins`. A tenant's administrator
gives it in the admin console — *Groups*, under *Roles*, the group `app-admins`: add the person;
or the person's own page, under their groups — and takes it away in the same place. It is one role for
the tenant: who holds it administers every app of the tenant that is signed in to this way.

- The sidecar tells the handler whether the realm's signed answer says the person holds the role
  (`person.appAdmin`). At every sign-in the handler makes the account what it should be, before
  it makes the session: an administrator's for a person who holds the role, an ordinary one for
  a person who does not. So the role given takes effect the next time the person opens
  OpenProject, and the role withdrawn at their next sign-in — within the hour a session lasts.
  An administrator somebody made in OpenProject's own pages, who does not hold the role, is an
  ordinary account again at their next sign-in.
- It is done through OpenProject's own interface, as the service account (`api_admin`, password in
  the vault under the app's `internal/api_admin_password`), inside the cluster:
  `PATCH /api/v3/users/<id>` with `{"admin": true}` or `{"admin": false}`, and only when the
  account is not already what it should be.
- One case is written to the database instead: OpenProject does not take the flag from its last
  active administrator. Here it has to go — the role was withdrawn — and an installation without
  an administrator is what a new one is anyway, until somebody is given the role. The handler
  then sets `users.admin` to false itself.
- The administrator OpenProject seeds (`admin`, `openproject-admin@<tenant domain>`) is created
  **locked**. It has a password in the vault that nothing accepts. A person at the platform who
  holds that address is refused, like anybody whose account is locked. The handler leaves it as
  it is.

An administrator of OpenProject sees every project and every account in it, and changes its
settings.

### What it is handed

OpenProject's database, its `secret_key_base`, the service account's password, and
OpenProject's own port inside the cluster. With these the sidecar can become any user of this
OpenProject. That is what a sign-in helper is; it is why the handler is part of this bundle and
why the platform runs one only from a bundle an install is pinned to. The sidecar can reach
nothing else, and nothing in the tenant can reach it but the platform's edge.

`secret_key_base` is new in this profile. The image ships the placeholder `OVERWRITE_ME` and the
chart sets none, so an install without it shares a key with every other such install.

### What is different from before

The profile brought a composition of its own that ran a second program (the "portal bridge"):
it fetched a user name and a password for the person from a portal that no longer exists and
typed them into OpenProject's form. The composition, the program, its page, the two settings that
switched OpenProject's second factor off for it, and the OIDC client and settings that had no
effect without a paid token are gone. The profile is rendered by the platform's composition like
any other.

With the composition went one thing it did besides: on a cluster that held a token for
OpenProject's paid edition it seeded the token and sent the sign-in page straight to Keycloak.
That belongs to a profile for the paid edition, which declares `identity.oidc`; this one is the
community edition's.

### What remains weak

- An account is found by e-mail address. A person given an address somebody else had before gets
  that account, with whatever it may do in OpenProject.
- A person removed at the platform keeps their account and their work in OpenProject. They cannot
  reach it — the front door refuses them — but nothing deletes or locks it.
- A session that is still in use is ended by the handler's sweep, not by OpenProject: if the
  sidecar is down, a session OpenProject already made lives until the sidecar is back. The
  browser drops its cookie after the hour either way.
- OpenProject writes the new account's request to its own log, with the address and the random
  password in clear. The password is deleted in the same second and no password is accepted, but
  it is in that log.
- The handler depends on four tables (`users`, `user_passwords`, `tokens`, `sessions` with
  `autologin_session_links`) and on how a token's value is hashed. OpenProject promises none of
  them. The end-to-end run is what notices.
- After the hour, or after signing out in OpenProject, the person is taken through the sign-in
  again and lands on the front page, not on the page they were on.
- OpenProject's second factor is no longer switched off, and is never asked for: it belongs to
  the password form.
