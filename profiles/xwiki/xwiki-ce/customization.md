# Customization ladder — XWiki (family `xwiki-ce`)

**Grade: A** · rubric score **7/8** · characterised 2026-08-06

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `xwiki-ce.cfg` / `xwiki-ce.properties` reference |
| Declared drop-in directories | 1 | `/usr/local/xwiki-ce/data/` config and `lib/` extension dirs |
| Documented plugin/addon API | 1 | XWiki components + XAR extensions |
| Plugin API versioned + deprecation policy | 1 | XWiki keeps a long deprecation cycle and documents it per release |
| Published HTTP API with a spec | 1 | REST API |
| Upstream accepts patches | 1 | active Jira + PR flow |
| Plugin ABI survives minor releases | 1 | components are stable within a cycle |
| Test harness for plugin authors | 0 | test tooling exists but is not packaged for downstream authors |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → upstream `xwiki-contrib/xwiki-helm` values |
| **L1** Drop-in | yes | `xwiki-properties` (`/usr/local/xwiki-ce/data/`, properties) and `skin` (static assets, tenant-editable) |
| **L2** Companion | always | consume the XWiki REST API from a separate app |
| **L3** Extension | yes | XAR extension installed through the Extension Manager, or a wiki-page-as-code import |
| **L4** Repackage | yes | upstream chart + `extraValues` + composition |
| **L5** Patch | **no** | not permitted |
| **L6** Fork | **no** | not permitted |

## Notes

XWiki blurs L1 and L3 more than most apps: much of what other systems need a plugin for is
authored as **wiki pages** (velocity/groovy in-page). Treat page-as-code imports as L3 — they
are versioned artifacts loaded by the app, not configuration — and keep them in an addon repo
rather than editing pages in a live instance, which would be a Rung X hotfix in disguise.

Extension installation is a runtime operation; drive it from `spec.postInstallJob`, not values.

## Signing out

When a person signs out at the platform, the realm tells XWiki, and XWiki ends that person's
sessions: `requires.services.identity.oidc.backchannelLogout` names the path
`/oidc/authenticator/backchannel_logout` on the entry `web`, and the platform registers it with
the realm at XWiki's own Service inside the cluster
(`http://xwiki-ce.<namespace>.svc.cluster.local:80/…`), not at `wiki.<domain>`.

What the OIDC authenticator 2.20.2 checks before it ends anything
(`BackChannelLogoutOIDCEndpoint`): with a provider configured (`oidc.provider`, which this
profile sets) it validates the logout token — signature against the keys the realm publishes,
issuer, audience — and then ends **every** session of the person the token names, not only the
one that signed out. It reads the realm's keys at the realm's public address, so XWiki has to
be able to reach `id.<domain>` from inside the cluster and trust its certificate, as it has to
for signing in.

Shown against the catalogue's image (`ghcr.io/gentian-org/xwiki`) and Keycloak 26.8.0 in
`e2e/oidc-sign-out/xwiki.e2e.js`, with this profile's `oidc.*` settings: the realm posts to the
Service's address, the session of the person who signed out is nobody's afterwards, another
person's goes on, and a token signed with another key or not signed at all ends nothing. The
realm posts once: if XWiki is not running at that moment the session lasts as long as XWiki
keeps it.
