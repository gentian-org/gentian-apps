# Customization ladder — Activepieces (family `activepieces-me`)

**Grade: A** · rubric score **7/8** · characterised 2026-08-06

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `AP_*` environment reference |
| Declared drop-in directories | 1 | the pieces directory, synced by the git-modules sidecar |
| Documented plugin/addon API | 1 | the Pieces framework (TypeScript) |
| Plugin API versioned + deprecation policy | 1 | pieces declare a framework version; breaking changes are versioned |
| Published HTTP API with a spec | 1 | REST API |
| Upstream accepts patches | 1 | active PR flow |
| Plugin ABI survives minor releases | 1 | pieces are stable within a framework major |
| Test harness for plugin authors | 0 | no packaged harness for downstream authors |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `AP_*` values on the chart |
| **L1** Drop-in | yes | `branding` static assets (tenant-editable) |
| **L2** Companion | always | REST API, or a webhook-triggered service |
| **L3** Extension | yes | a **custom piece**, delivered by the `git-sync` sidecar already declared on this profile (`gentian-sidecar-git-modules` 0.1.7) |
| **L4** Repackage | yes | `charts/activepieces/` — pinned upstream + a DEP-3 patch series, `chartOwnership: patched` |
| **L5** Patch | **no** | not permitted — see below |
| **L6** Fork | **no** | not permitted |

### L4 patches the chart; L5 would patch the app — only one of those is allowed

`charts/activepieces/` carries a 5-patch series against upstream `adnoctem/helm`
(3 upstream bug fixes, 2 Gentian extension points). That is **L4 Repackage**: a
chart is *packaging*, and patching packaging is what a distribution repo does.

**L5 remains forbidden**, because at this rung the patch target would be the
Activepieces application itself — its server bundles and database flags — and
that is precisely where the licence-bypass temptation lives (see below). The
distinction is the target, not the technique.

## L3 is the intended path

Custom pieces are Activepieces' native extension unit and the sidecar wiring already exists on
this profile — adding a piece is a push to the addon repo, not a platform change. Anything
phrased as "add an integration/connector/step" is L3 here, not L2.

## Licensing — read before customizing

Several capabilities (SSO, custom appearance, git sync of flows, advanced RBAC) are Enterprise
features gated by a licence key. Configure them by supplying a valid `AP_LICENSE_KEY`, never by
patching bundles or flipping database flags. This is an explicit absolute prohibition — see
`app-profile-guide.md`. It is also why `patch.allowed` is `false` for this app: the temptation
lives exactly here.

Upstream chart provenance and licence terms are pinned in
[`charts/activepieces/UPSTREAM`](../../charts/activepieces/UPSTREAM); the local delta is
[`charts/activepieces/patches/`](../../charts/activepieces/patches/). Nothing about that
series touches licensing — it is 3 upstream bug fixes plus 2 additive extension points.

## Sign-in: the platform's sidecar and this profile's handler

Single sign-on is one of the licence-gated capabilities above and is not used. The profile
declares `requires.services.identity.sidecar`: the platform runs its sign-in sidecar beside
Activepieces and the sidecar runs [`assets/sign-in-handler.js`](assets/sign-in-handler.js). The
record is [`customizations/sign-in-sidecar.yaml`](customizations/sign-in-sidecar.yaml); the nginx
side is [`customizations/nginx-sso-routing.yaml`](customizations/nginx-sso-routing.yaml).

### What the handler does

Checked against `activepieces/activepieces:0.28.0`, and run against that container started the way
the chart starts it (`images/gentian-sidecar-sso-saml/e2e/activepieces.e2e.js`):

| Step | By | Activepieces' own way |
|---|---|---|
| The platform, at the first sign-in ever | `POST /api/v1/authentication/sign-up`, inside the cluster, for an account nobody can sign in as | yes — the first sign-up creates the platform, with the edition's own settings. No row or switch of `platform` is written |
| An account and a project for a person who has none | rows in `user` and `project`, platform role `MEMBER` | **no — see below** |
| The password column, which cannot be NULL | the empty string, which no password matches | no — the row is written |
| The session | a token `{id, type: USER, projectId, platform: {id}}` signed with `AP_JWT_SECRET`, issuer `activepieces` | the token the sign-in call returns, made here |
| Where the session is kept | `localStorage` (`token`, `currentUser`), written by a page the sidecar generates | where Activepieces' page keeps it. No cookie carries it |
| Who administers Activepieces | `POST /api/v1/users/<id>` with `platformRole` `ADMIN` or `MEMBER`, inside the cluster, as the account the installation was created with (a one-minute token the handler signs), when the account is not what the platform's App Admin role says it should be | yes — the call an administrator of the installation changes a person's role with. The community edition has the two roles and gives `ADMIN` by invitation too |
| An account that is not `ACTIVE` | refused | — |
| A person who holds the address of the account the installation was created with | refused | — |

### What the handler writes itself — open, for the owner

The community edition's own interface makes an account for a second person only by invitation, and
then refuses the sign-in with *"No project found for user"*: it creates a project for the first
account only, and creating more is behind the `manageProjectsEnabled` switch, which is a paid
feature. So the handler writes the person's account and one project of their own into the
database, as the handler before it did. It writes no switch, shares no project and gives no role.

Whether one project per person, written this way, is within the community licence or is going
around a paid feature is a judgement this catalogue cannot make for the owner. The rule of this
repository is not to bypass licensing; until the question is answered this profile should be
treated as not cleared for a tenant that has not been told.

### Who administers Activepieces

Who holds the platform's **App Admin** role, and nobody else: not the tenant's administrator for
being that, not the first person in.

The role is the tenant's group `gentian:tenant:<tenant>:app-admins`. A tenant's administrator
gives it in the admin console — *Groups*, under *Roles*, the group `app-admins`: add the person;
or the person's own page, under their groups — and takes it away in the same place. It is one role for
the tenant: who holds it administers every app of the tenant that is signed in to this way.

The sidecar tells the handler whether the realm's signed answer says the person holds the role
(`person.appAdmin`). At every sign-in the handler makes the account what it should be, before it
makes the token: the installation's role `ADMIN` for a person who holds the role, `MEMBER` for a
person who does not. So the role given takes effect the next time the person opens Activepieces,
and the role withdrawn at their next sign-in — within the hour a token lasts; Activepieces reads
the role when it is asked, so a token from before administers nothing either. An administrator
somebody made in Activepieces itself, who does not hold the role, is a member again at their next
sign-in. The account the installation was created with keeps its role and is nobody's.

An administrator of the installation sees its accounts and its settings pages, and — as
Activepieces is built — may be taken to a project that is not their own
(`project-service.ts`, `getOneForUser`). The handler signs them in to their own project.

### What it is handed

Activepieces' database, its `AP_JWT_SECRET`, and its own port inside the cluster. With these the
sidecar can become any user of this Activepieces. That is what a sign-in helper is; it is why the
handler is part of this bundle and why the platform runs one only from a bundle an install is
pinned to.

### What is different from before

- Every person was made an administrator of the whole installation. Now a person is one while
  they hold the platform's App Admin role, and everybody else is a member. An installation that
  kept its database from before has administrators from then: each becomes a member at their next
  sign-in unless they hold the role.
- The session lasted seven days and was also put in three cookies a page's script could read. It
  lasts at most an hour, and is in `localStorage` only.
- The page that stored the session was built by pasting the person's name into a script. The
  sidecar now writes that page, and a name is data in it.
- Identifiers came from `Math.random`. They come from the system's random source.
- A job seeded the `platform` row by hand, with `embeddingEnabled` set — a switch the community
  edition leaves off. The job is gone; Activepieces creates its platform itself.
- Activepieces' own nginx proxied the sign-in to the sidecar and rewrote the app's pages at start.
  The platform routes the sign-in now; nginx serves one script.

### What it asks of the tenant's perimeter approver

The profile's entry declares `clientAuthorization: app`: Activepieces' page sends its token to
its own API in the `Authorization` header, and the front door removes that header on an entry
that does not say so. Until the tenant's perimeter approver has approved the entry (`kubectl
gentian exposures requests|approve --tenant <tenant>`, or the console's "Public addresses and
requests"), a person can sign in and every call the page then makes is refused by Activepieces;
the Component's `ClientAuthorization` condition says so. Approving it publishes nothing. Sign-in
and the right to use the app stay required, and no token of the platform's reaches Activepieces.

### What remains weak

- The token is in `localStorage`, where any script running on the app's pages can read it. That is
  how Activepieces is built. It is good for an hour, and only through the front door.
- **Signing out at the platform does not end the session in Activepieces.** The realm tells the
  sidecar, and the handler has nothing to end it with: at 0.28.0 Activepieces checks a token by
  its signature and its end alone (`authentication/lib/access-token-manager.ts`) and looks
  nothing up — no session row, no version of the token on the account, not even whether the
  account is still active. The one thing that would refuse it is another signing key, which
  would sign everybody out and restart the app. So the handler has no `onLogout`, the sidecar
  logs `no-sign-out-handling`, and the token lasts what is left of its hour: on a shared
  browser, the next person who opens Activepieces within that hour — through the front door, as
  somebody who may use it — is shown the previous person's flows. Activepieces today checks a token
  against a version kept with the account (`tokenVersion`); moving to such a release is what
  would close this.
- An account is found by e-mail address. A person given an address somebody else had before gets
  that account.
- A person removed at the platform keeps their account and flows. Their flows keep running.
- The installation's owner is an account nobody can sign in as. Who administers it is who holds
  the platform's App Admin role, which is one role for all of the tenant's apps of this kind.
- The handler depends on the `user` and `project` tables and on the token's fields. Activepieces
  promises none of them, and 0.28.0 is an old release. The end-to-end run is what notices.
- After the hour the person is taken through the sign-in again and lands on the list of flows.
