# Open WebUI — backlog

## Edge-authenticated sessions instead of a seeded admin account

**Status:** considered and deferred, 2026-08-20. Not scheduled.

### Why it is here

Open WebUI's sign-in page only auto-redirects to SSO once an account already
exists, and this profile disables the local sign-in form. A fresh instance
therefore has nothing to render and nothing to click: the tab shows the logo
and stops, and the only action that would clear it — signing in — is the one
being blocked. Every newly provisioned tenant hit this.

What ships today closes that loop from inside the app: the post-install job
creates the tenant administrator's account, which clears onboarding, and
`OAUTH_MERGE_ACCOUNTS_BY_EMAIL` hands it to its owner at their first SSO
sign-in. It is small, contained in this profile, and reversible.

The alternative was to stop the app doing its own sign-in at all.

### The alternative

Authenticate at the gateway and pass the result inward as a header, with
`WEBUI_AUTH_TRUSTED_EMAIL_HEADER`. Envoy Gateway's `SecurityPolicy` (oauth2 or
extAuth) is the mechanism; the CRDs are installed on every cluster because they
ship with Envoy Gateway, and no cluster uses one yet.

**What it would buy:** no local account anywhere; no per-app OIDC client for
apps that can take a header; immunity to this whole class of first-run
bootstrap deadlock. It is a platform capability, not an app fix — six
catalogue profiles declare `kernelRequirements.identity.oidc` today and could
eventually share it.

**What it would cost, and why it was not taken now:**

- Trusted-header auth means anything that can reach the Service directly can
  claim to be any user by setting the header. Tenant namespaces currently allow
  same-namespace traffic, so this needs NetworkPolicy work before it is safe.
  A mistake here is account takeover, against a worst case today of one unused
  account.
- Session handling moves to the edge — cookies, refresh, logout — which is new
  platform surface with no existing implementation to extend.
- Admin rights would likely regress. This profile grants them from the
  `groups` claim (`OAUTH_ROLES_CLAIM` / `OAUTH_ADMIN_ROLES`), and a trusted
  header carries an address, not group membership, so the "AI Config" tile
  would need another mechanism.

### If it is picked up

The two are independent: the seeding job can be deleted the moment edge auth
authenticates this app, and nothing else in the profile depends on it. Start
with the NetworkPolicy question — if the app cannot be made unreachable except
through the gateway, the rest is not worth designing.
