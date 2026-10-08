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
| An account that is not `ACTIVE` | refused | — |

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

### What it is handed

Activepieces' database, its `AP_JWT_SECRET`, and its own port inside the cluster. With these the
sidecar can become any user of this Activepieces. That is what a sign-in helper is; it is why the
handler is part of this bundle and why the platform runs one only from a bundle an install is
pinned to.

### What is different from before

- Every person was made an administrator of the whole installation. Everybody is a member now.
- The session lasted seven days and was also put in three cookies a page's script could read. It
  lasts at most an hour, and is in `localStorage` only.
- The page that stored the session was built by pasting the person's name into a script. The
  sidecar now writes that page, and a name is data in it.
- Identifiers came from `Math.random`. They come from the system's random source.
- A job seeded the `platform` row by hand, with `embeddingEnabled` set — a switch the community
  edition leaves off. The job is gone; Activepieces creates its platform itself.
- Activepieces' own nginx proxied the sign-in to the sidecar and rewrote the app's pages at start.
  The platform routes the sign-in now; nginx serves one script.

### What remains weak

- The token is in `localStorage`, where any script running on the app's pages can read it. That is
  how Activepieces is built. It is good for an hour, and only through the front door.
- An account is found by e-mail address. A person given an address somebody else had before gets
  that account.
- A person removed at the platform keeps their account and flows. Their flows keep running.
- Nobody administers the installation: its owner is an account nobody can sign in as.
- The handler depends on the `user` and `project` tables and on the token's fields. Activepieces
  promises none of them, and 0.28.0 is an old release. The end-to-end run is what notices.
- After the hour the person is taken through the sign-in again and lands on the list of flows.
