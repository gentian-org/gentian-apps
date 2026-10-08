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
| An account switched off in Docmost | refused | — |

The session lasts what the sidecar says: at most an hour, in the token and in the row. Signing out
in Docmost revokes the row, and the token is then refused by Docmost itself.

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

With it went what it did besides signing in: a space named after the tenant shared with everybody,
a personal space per person, and a group named after the tenant. Docmost 0.95 creates its own
"General" space and has personal spaces of its own. If the tenant-named space and group are
wanted back they belong in a job that runs once, not in the code that signs people in.

### What remains weak

- An account is found by e-mail address. A person given an address somebody else had before gets
  that account.
- A person removed at the platform keeps their account and their pages in Docmost. They cannot
  reach it — the front door refuses them — but nothing deletes it.
- Everybody is a member. Nobody administers the workspace: its owner is an account nobody can
  sign in as. Making somebody an administrator is a change in Docmost's database today.
- The handler depends on two tables (`users`, `user_sessions`), on the invitation table, and on
  the token's fields. Docmost promises none of them. The end-to-end run is what notices.
- After the hour the person is taken through the sign-in again and lands on the home page, not
  on the page they were on. What they typed is kept by Docmost as they type.
