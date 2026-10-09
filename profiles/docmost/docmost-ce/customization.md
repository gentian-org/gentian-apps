# Customization ladder — Docmost (family `docmost-ce`)

**Grade: D** · rubric score **2/8** · characterised 2026-08-11

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | [Environment variables](https://docmost.com/docs/self-hosting/environment-variables) |
| Declared drop-in directories | 0 | No ConfigMap-mountable config file surface (env-var config only) |
| Documented plugin/addon API | 0 | Docmost is a monolithic NestJS + React app with no plugin/extension mechanism |
| Plugin API versioned + deprecation policy | 0 | N/A — no plugin API |
| Published HTTP API with a spec | 0 | Docmost's REST API is session-cookie authenticated for its own frontend, not a published bearer-token integration surface |
| Upstream accepts patches | 1 | Active GitHub project, PR flow, AGPL-3.0 core |
| Plugin ABI survives minor releases | 0 | N/A — no plugin ABI |
| Test harness for plugin authors | 0 | N/A — no plugin system |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `charts/docmost` values → Docmost env vars (`APP_URL`, `STORAGE_DRIVER`, `MAIL_DRIVER`, …) |
| **L1** Drop-in | not yet | Docmost has no declarative config-file surface to mount a drop-in against — everything is env vars |
| **L2** Companion | always | consume Docmost's REST API from a separate app (session-cookie auth only today — see rubric). The sign-in handler is one: see below |
| **L3** Extension | **no** | Docmost has no plugin/extension mechanism to extend |
| **L4** Repackage | yes | first-party chart (`charts/docmost`, `chartOwnership: gentian-owned`) wrapping the unmodified upstream image + `extraValues` |
| **L5** Patch | **no** | not permitted — no build pipeline for a patched image exists |
| **L6** Fork | **no** | not permitted |

## Notes

Docmost ships no upstream Helm chart at all (docker-compose only), so — like Mathesar — `charts/docmost`
is a **first-party Gentian chart** wrapping the official, unmodified `docmost/docmost` image, not a
vendored/patched upstream chart. `repackage.chartOwnership: gentian-owned` reflects that; there is no
upstream chart repo to point `patch.buildRepo`/`fork.repo` at.

## Sign-in: the platform's sidecar and this profile's handler

Docmost's own single sign-on (SAML, OIDC, LDAP) is entirely behind a paid subscription
(`apps/server/src/ee/`), so `requires.services.identity.oidc` is not used — using it would need a
licence, which the platform's licensing-bypass prohibition forbids working around. The profile
declares `requires.services.identity.sidecar` instead: the platform runs its sign-in sidecar
beside Docmost and the sidecar runs [`assets/sign-in-handler.js`](assets/sign-in-handler.js).
The record is [`customizations/sign-in-sidecar.yaml`](customizations/sign-in-sidecar.yaml).

### What the handler does

Checked against the server build in `docker.io/docmost/docmost:0.95.0`, and run against that
container (`images/gentian-sidecar-sso-saml/e2e/docmost.e2e.js`):

| Step | By | Docmost's own way |
|---|---|---|
| The workspace, at the first sign-in ever | `POST /api/auth/setup`, inside the cluster | yes — the call its first-run page makes |
| An account for a person who has none | `POST /api/workspace/invites/create`, then `…/invites/accept`, inside the cluster, as a member | yes — the free edition's invitation, created with a one-minute token for the workspace's owner |
| The invitation's id and token | read from `workspace_invitations` | no — read from the database instead of through `invites/link` |
| The password those two calls demand | a random value, then `password` set to NULL | no — the row is written |
| The session | a row in `user_sessions` and a token `{sub, email, workspaceId, type: access, sessionId}` signed with `APP_SECRET`, issuer `Docmost` | the same row and token `SessionService.createSessionAndToken` makes, made here |
| Who administers Docmost | `POST /api/workspace/members/change-role` to `admin` or `member`, inside the cluster, with a one-minute token for the workspace's owner, when the account is not what the platform's App Admin role says it should be | yes — the call an owner changes a member's role with |
| A space of the person's own, at their first sign-in | `POST /api/spaces/create`, then `…/spaces/members/add` with the person as its `admin`, with the same kind of token | yes — an ordinary space. Not Docmost's paid "personal spaces": see below |
| Membership of the tenant's group, at the first sign-in | `POST /api/groups/members/add`, with the same kind of token | yes |
| An account switched off in Docmost | refused | — |
| A person who holds the address of the account the workspace was created with | refused | — |

The session lasts what the sidecar says: at most an hour, in the token and in the row. Signing out
in Docmost revokes the row, and the token is then refused by Docmost itself.

Signing out at the platform ends it too. The realm tells the sidecar, inside the cluster, and the
handler's `onLogout` deletes the person's rows of `user_sessions` — all of them, in every
browser. Docmost looks a token's session up on every request, so each of that person's tokens is
refused from then on, with most of its hour still left. Nobody else's session is touched. The
realm tells once: if the sidecar is not running at that moment the session lasts its hour.

### Who administers Docmost

Who holds the platform's **App Admin** role, and nobody else: not the tenant's administrator for
being that, not the first person in.

The role is the tenant's group `gentian:tenant:<tenant>:app-admins`. A tenant's administrator
gives it in the admin console — *Groups*, under *Roles*, the group `app-admins`: add the person;
or the person's own page, under their groups — and takes it away in the same place. It is one role for
the tenant: who holds it administers every app of the tenant that is signed in to this way.

The sidecar tells the handler whether the realm's signed answer says the person holds the role
(`person.appAdmin`). At every sign-in the handler makes the account what it should be, before it
makes the session: the workspace role `admin` for a person who holds the role, `member` for a
person who does not. So the role given takes effect the next time the person opens Docmost, and
the role withdrawn at their next sign-in — within the hour a session lasts; Docmost reads the
role on every request, so a session from before administers nothing either. An administrator
somebody made in Docmost itself, who does not hold the role, is a member again at their next
sign-in. The role `owner` stays with the account the workspace was created with, which is
nobody's.

An administrator of the workspace manages its members, groups and settings, and its spaces —
every space, a person's own included.

### What a tenant's Docmost has from the start

Made by the profile's post-install job (`spec.hooks.postInstall`), with Docmost's own calls,
inside the cluster, as the account the workspace is created with:

| What | When | Who sees it |
|---|---|---|
| The workspace | once, at install (the handler makes it too if a person is there first) | — |
| A space named after the tenant, at the address `/s/<tenant>` | once, at install | everybody: it is shared for writing with the group Docmost puts every member in |
| A group named after the tenant | once, at install | administrators of the workspace, in its settings. It gives access to nothing by itself; it is there to share a space with the tenant's people and not with every account |

And by the handler, at a person's first sign-in:

| What | When | Who sees it |
|---|---|---|
| A space named after the person, at the address of the part of their e-mail address before the `@`, with the person as its administrator | first sign-in | the person, and whoever they share it with; administrators of the workspace can manage it |
| Membership of the tenant's group | first sign-in, last — it is what says the first sign-in is done | — |

So a person sees three spaces: Docmost's own "General", the tenant's, and their own.

- The job is told the tenant's name. The handler is not: it finds the tenant's group as the one
  group the workspace's own account made, so the group may be renamed.
- Nothing is made twice. The job runs again from time to time; a tenant's space or group that
  was deleted comes back. A person's space is made once: one they deleted stays deleted, and an
  address already taken — by somebody of the same name at another domain, or by a space somebody
  made — is left alone, so that nobody is put into a space that already existed.
- The job holds what Docmost itself holds — its database and `APP_SECRET` — and no password. It
  listens on nothing.
- **Open, for the owner.** Docmost 0.95 sells "personal spaces" in its paid edition
  (`apps/server/src/ee/personal-space`, switched on per workspace behind a licence check). That
  feature is not used, switched on or touched: what is made here is an ordinary space of the free
  edition with one member, as the program this replaces made it before Docmost had the feature.
  The result resembles what the paid feature gives. Whether that is acceptable to the vendor is
  the owner's judgement; taking the per-person space out again is deleting `welcome`'s first half
  in the handler.

### What it is handed

Docmost's database, Docmost's `APP_SECRET`, and Docmost's own port inside the cluster. With these
the sidecar can become any user of this Docmost. That is what a sign-in helper is; it is why the
handler is part of this bundle and why the platform runs one only from a bundle an install is
pinned to. The sidecar can reach nothing else, and nothing in the tenant can reach it but the
platform's edge.

### What is different from before

The profile used to run a second program in Docmost's pod that derived a password per person from
a secret and signed in with it, and held an administrator's password. That program, its secret,
the administrator's password and the port it listened on are gone: nobody has a password now, and
nothing accepts "sign this address in" from the tenant's network.

What it did besides signing in — a space named after the tenant shared with everybody, a space
per person, and a group named after the tenant — is made again, without it: the tenant's space
and group by a job that runs at install, a person's space and membership by the handler at their
first sign-in ("What a tenant's Docmost has from the start").

### What remains weak

- An account is found by e-mail address. A person given an address somebody else had before gets
  that account.
- A person removed at the platform keeps their account and their pages in Docmost. They cannot
  reach it — the front door refuses them — but nothing deletes it.
- The workspace's owner is an account nobody can sign in as. Who administers it is who holds the
  platform's App Admin role, which is one role for all of the tenant's apps of this kind.
- The post-install job and the handler depend on more of Docmost than the sign-in did: the tables
  `groups`, `group_users` and `spaces`, and the calls for spaces and groups.
- The handler depends on two tables (`users`, `user_sessions`), on the invitation table, and on
  the token's fields. Docmost promises none of them. The end-to-end run is what notices.
- A person signed in to Docmost at two devices who signs out at the platform at one is signed out
  of Docmost at both; the other is taken through the sign-in again, silently.
- After the hour the person is taken through the sign-in again and lands on the home page, not
  on the page they were on. What they typed is kept by Docmost as they type.
