# Signing out of apps that sign people in themselves

End-to-end runs for the catalogue's apps that have an OIDC client of their own and declare
`requires.services.identity.oidc.backchannelLogout`: the app's real image, Keycloak 26.8.0, and
the client and sign-out address the platform would register from the app's profile.

Each run shows the same thing. A person signs in to the app through Keycloak. They sign out at
Keycloak. Keycloak posts its logout token to the address the platform builds from the profile —
`http://<backend service>.<namespace>.svc.cluster.local:<port><path>`, the app's own Service
inside the cluster — and the app's session cookie opens nothing afterwards, while another
person's goes on working. A token signed with another key, and an unsigned one, end nothing.

| Run | App | Image |
|---|---|---|
| `nextcloud.e2e.js` | `nextcloud-base-ce` | the profile's own (`ghcr.io/gentian-org/nextcloud`), with the profile's settings file and its post-installation hook |
| `xwiki.e2e.js` | `xwiki-ce` | `ghcr.io/gentian-org/xwiki`, with the profile's `oidc.*` settings |

```bash
e2e/oidc-sign-out/run.sh            # both
e2e/oidc-sign-out/run.sh nextcloud
```

What stands in for the cluster (`lib/oidc.js`):

- Keycloak with the platform's own hostname settings, answering inside the network under its
  Service's name, and — for an app that reads the realm at its public address — under
  `id.e2e.test` over TLS;
- the app's Service: a relay under the name the address is built from, which passes each request
  on as it came and keeps what Keycloak posted;
- a network outside the private address ranges, so that no app takes the caller for its reverse
  proxy and skips checking the name it is called by.

The browser is scripted (`images/gentian-sidecar-sso-saml/e2e/lib/browser.js`). The apps that
are signed in to through the platform's sign-in sidecar have their runs beside the sidecar, in
`images/gentian-sidecar-sso-saml/e2e`.

An app is added here before its profile declares `backchannelLogout`. Not yet run, and marked so
in their profiles: `nextcloud-base-od`, `open-webui` (which also needs Redis and a switch to end a
session at all).
