# gentian-sidecar-sso-saml — the platform's sign-in sidecar

Signs a person in to an app that can do neither OIDC nor SAML itself, so that somebody who is
signed in at the platform opens the app and is in: no second sign-in, no password.

This directory is the one copy of it. The platform runs the image built here beside every app
whose profile declares `requires.services.identity.sidecar`; nothing else deploys it, and it has
no chart. The platform's side — the declaration, what is composed for it and how its two paths
are routed — is in gentian-os: `docs/app-customization.md` ("The sign-in sidecar") and
`docs/design/security.md`.

## What it does

It is a SAML service provider towards the tenant's realm, on the app's own host:

| Path | Reached | Does |
|---|---|---|
| `GET /sso/login` | behind the front door, so only by a person who may use the app | sends the browser to the realm with a SAML request |
| `POST /sso/acs` | without a session, because the realm posts its answer from its own address | checks the answer, then asks the app's **handler** to make a session |
| `POST /sso/logout` | by the realm only, inside the cluster, under the sidecar's own Service name; not routed from outside | checks the realm's sign-out request, then asks the handler to end that person's sessions in the app |
| `GET /healthz`, `GET /readyz` | by the kubelet | ready means the realm's signing certificate is known |

The realm recognises the person from the sign-in at the platform and answers without asking.

## What it accepts as an answer

Everything in this list, or nothing (`lib/signin.js`; each line has a test in `test/`):

- signed by a certificate of the realm, twice: the response as a whole and the assertion in it;
- issued by the realm it was told about;
- addressed to it: `Destination` and the assertion's `Recipient` are its own address, and the
  audience is its own name;
- an answer to a request this process sent (`InResponseTo`), not answered before, at most five
  minutes old;
- posted by the browser that was sent away with that request (a cookie set at that moment);
- about the person the front door admitted when the request was sent (the address the realm
  vouches for is the address in the front door's identity header);
- inside its validity period, with exactly one assertion, in clear, not presented before, and
  no document type declaration.

## Signing out

When a person signs out at the platform, the realm ends its session and tells every client that
session was used at. For the sidecar that is SAML single logout over the back channel: the realm
posts a signed `LogoutRequest`, server to server, to the address the platform registered for the
sidecar's client — `http://<app>-sign-in.<namespace>.svc.cluster.local:8081/sso/logout`, the
sidecar's own Service. Nothing public is opened for it: the path is not among the routes of the
app's host, and the sidecar answers it only under that Service name.

Keycloak 26.8.0 posts the request once, when the person signs out or an administrator ends the
session; not again if the sidecar did not answer, and not when a session merely runs out. It
reads the answer's status and nothing else, so the sidecar answers `200` with no SAML message.

What is accepted as such a request (`lib/signout.js`; each line has a test in `test/`):

- signed by a certificate of the realm, over the request as a whole;
- a `LogoutRequest`, issued by the realm the sidecar was told about;
- addressed to it: `Destination` is its own sign-out address;
- issued within the last two minutes and not in the future, and not past its `NotOnOrAfter`
  where it carries one;
- not presented before;
- naming one person, by e-mail address (`NameID`), in clear — the same name the sign-in reads;
- exactly one request in the post, and no document type declaration.

The person is the one the request names. Its `SessionIndex` is the realm session; the sidecar
remembers which person each realm session signed in here, and a request that names a session for
somebody else is refused. That memory is the process's own: after a restart a request is taken
on the person it names alone.

The handler's `onLogout` is then called with that person. **A handler without `onLogout`** is a
handler for an app whose session cannot be ended from outside: the realm is answered `200`, the
log says `no-sign-out-handling`, and the app's session ends when its hour does.

A request that is refused ends nobody's session. The most a forged one could do, were it
accepted, is sign a person out of one app; it could never sign anybody in.

## Who administers the app

One more thing is read from the answer, and from nowhere else: whether the person administers the
app. The platform's role for that is **App Admin** — membership of the tenant's group
`gentian:tenant:<tenant>:app-admins`, which a tenant's administrator gives and takes away in the
admin console. The platform gives the sidecar's client at the realm one role,
`gentian-app-admin`, grants it to that group, and has the realm list a person's roles at this
client in the assertion, in the attribute `Role` (gentian-os,
`crossplane/compositions/app-default.yaml`). The client is not given the realm's other roles, so
the list is that one role or nothing.

The sidecar reads the attribute from the assertion as the realm signed it and hands the handler
`person.appAdmin`: `true` when the assertion's own attribute `Role` has the value
`gentian-app-admin`, `false` in every other case — no attribute, another name, another value. No
header, form field, cookie or address is read for it: on the path the answer is posted to nothing
has vouched for the request, and an answer changed after it was signed is refused whole
(`test/signin.test.js`, `test/server.test.js`, and against Keycloak in `e2e/sidecar.e2e.js`).

A tenant's administrator is not an app's administrator for being that, and neither is the first
person to open the app.

A refusal spends the request it answered. The browser is told that the sign-in failed and a
reference; the reason is in the log under that reference. The log names nobody: no address, no
name, no assertion, no cookie, no token.

Requests waiting for their answer are remembered in the process, so the sidecar runs as one
replica, and a restart in the middle of a sign-in means that sign-in is started again.

## Settings

All given by the platform. Nothing is assembled from a tenant's name and a domain.

| Variable | |
|---|---|
| `SSO_ENTITY_ID` | the sidecar's name at the realm, `https://<app host>/sso` |
| `SSO_ACS_URL` | where the realm posts, `https://<app host>/sso/acs`; the app's host is taken from it |
| `SSO_LOGIN_PATH` | `/sso/login` |
| `SSO_IDP_ENTITY_ID` | the realm, as its answers name it |
| `SSO_IDP_SSO_URL` | where browsers are sent |
| `SSO_IDP_DESCRIPTOR_URL` | the realm's SAML descriptor inside the cluster, for its signing certificate |
| `SSO_REALM` | the realm's name; a person of another realm begins no sign-in |
| `SSO_HANDLER_SHA256` | sha256 of the handler; a file that is not that file is not loaded |
| `SSO_LOGOUT_URL` | optional; where the realm tells the sidecar of a sign-out, `http://<app>-sign-in.<namespace>.svc.cluster.local:8081/sso/logout`. Plain http, because it is inside the cluster; never on the app's public host. Without it the sidecar has no sign-out path |
| `SSO_SESSION_MAX_SECONDS` | optional; may lower the session's hour, never raise it |

## A handler

The app's part: one file, `handler.js`, from the app's catalogue entry. It knows how this app
keeps a session and nothing about SAML.

```js
module.exports = {
  // person: { email, name, appAdmin }
  //                           email is what the realm vouched for, in lower case.
  //                           name is for display only (it comes from the front door).
  //                           appAdmin is true when the realm's signed answer says the
  //                           person holds the platform's App Admin role, else false.
  // ctx:    { sessionSeconds, origin, log(event, fields) }
  async onLogin(person, ctx) {
    // find or make the person's account in the app; make it an administrator's
    // or an ordinary one, as person.appAdmin says; make a session that ends
    // after ctx.sessionSeconds
    return {
      redirect: '/home',                                  // a path on the app's own host
      cookies: [{ name: 'authToken', value: token }],     // the app's session cookies
      // localStorage: { token: '…' },                    // for an app whose page keeps its session there
    };
    // or: return { refuse: true };                       // this person is not signed in
  },

  // Optional. The person signed out at the platform.
  // person: { email }        the address the realm's signed request names, in lower case.
  // ctx:    { origin, log(event, fields) }
  async onLogout(person, ctx) {
    // end every session this person has in the app, in every browser
    // answers nothing; throwing tells the realm the sign-out failed here
  },
};
```

**A handler never writes to the browser.** It answers a description and the sidecar writes the
response, so these are the same for every app and are not a handler's to get wrong:

- every cookie is `Secure; SameSite=Lax; Path=/`, lasts `ctx.sessionSeconds`, and is `HttpOnly`
  unless the handler says `httpOnly: false` (only for an app whose own page must read it);
- `redirect` is a path on the app's own host. An address, `//host`, a backslash or a control
  character is refused;
- `localStorage` is written by a page the sidecar generates: the values are data in it, never
  code, whatever a person is called, and the page runs that one script and nothing else;
- anything else in the answer is an error, and so is a cookie under a name the front door keeps
  for itself. An error signs nobody in.

**A session ends when the sidecar says.** `ctx.sessionSeconds` is at most an hour and never
later than the realm session the answer came from. A handler that signs a token gives it that
lifetime. When it has run out the app sends the browser back to the sign-in, which is silent
while the person is still signed in at the platform.

**A session ends when the person signs out, where the app can end one.** `onLogout` ends that
person's sessions in the app: all of them, in every browser, because the handler is told who
signed out and not which of their sessions came from which browser. A person signed in at two
devices who signs out at one is asked nothing at the other — the app there sends the browser
through the sign-in again, which is silent while that device is still signed in at the platform.
`onLogout` creates nothing, changes no account and no role, and must be safe to call for a
person the app has never seen. It is written so that it works whether or not it is ever called:
a sidecar built before sign-out existed calls only `onLogin`.

Where `onLogout` exists, a sign-out ends the app's session at once, and the hour is what is left
when the realm's one notice did not arrive (the sidecar was restarting) or the realm session ran
out without a sign-out. Where it does not, the hour bounds how long an app session can show the
previous person to the next one at the same browser. Neither is what keeps a person out who was
removed — the front door does that, on every request, within minutes.

**What a handler has** is what the app's profile declared for it and nothing else: the app's
own database (`DB_HOST`, `DB_PORT`, `DB_NAME`, `DB_USER`, `DB_PASSWORD`), the app's own secrets
(`SECRET_<NAME>`), and the app itself inside the cluster (`APP_URL`). The image carries `pg`,
`mysql2` and `jsonwebtoken`; nothing is installed when the container starts, and the container
reaches nothing but what was declared.

**What a handler must not do:**

- sign anybody in with a shared account, or give a person rights in the app that the app's own
  free sign-up would not;
- make anybody an administrator of the app but a person whose `person.appAdmin` is `true`, or
  leave one an administrator whose `person.appAdmin` is not: the role is given and taken away at
  every sign-in, in the app's own way, before the session is made. A handler treats anything but
  `true` as no — a sidecar built before this was added says nothing, and nothing is no. The
  account the app keeps for itself (the one a workspace or an installation is created with) is
  nobody's: its role is left alone, and a person who holds its address is refused;
- give anybody a password, or keep one. Where the app's own calls demand one for a new account,
  a random value is given and removed again;
- log who signed in. `ctx.log` is for what happened, not to whom;
- touch a licence check or a switch of a paid feature in the app.

The handlers in this catalogue are the reference:
`profiles/docmost/docmost-ce/assets/sign-in-handler.js` and
`profiles/activepieces/activepieces-me/assets/sign-in-handler.js`, which sign a session token
with the app's own key, and `profiles/openproject/openproject-ce/assets/sign-in-handler.js`, for
an app that keeps its sessions in its database: it signs nothing, and has the app make the
session itself from a token that works once. Each settles who administers its app; what an
administrator is in each app is in the profile's `customization.md`.

Docmost's and OpenProject's end a person's sessions in `onLogout`: each app looks a session up
in its database on every request, so deleting the rows ends it. Activepieces' has no `onLogout`:
at 0.28.0 its token is checked by signature and end alone, against nothing a handler could
change, so its session lasts its hour.

## Tests

```bash
npm ci && npm test                 # the checks above, against responses signed in the test

docker build -t sso-sidecar:e2e .  # then, with docker, against the real things:
node --test e2e/sidecar.e2e.js       # Keycloak 26.8.0, at the three kinds of address an app has; sign-in and sign-out
node --test e2e/docmost.e2e.js       # + Docmost 0.95.0, with the profile's handler and its post-install job
node --test e2e/activepieces.e2e.js  # + Activepieces 0.28.0, started as the chart starts it
node --test e2e/openproject.e2e.js   # + OpenProject 16.6.10, started as its chart starts it with the profile's values
```

Each app's run signs a person out at Keycloak and shows what became of the app's session: ended
for that person and for nobody else in Docmost and OpenProject, still good until its hour in
Activepieces; and that a sign-out request the realm did not send, or sent before, ends nothing.

The end-to-end runs start their own containers and remove them. `E2E_NETWORK` names the docker
network and prefixes Keycloak's container, for two runs on one machine. The browser and the front door
in them are scripted (`e2e/lib/browser.js`): the cookie rules of a browser are followed, a real
browser is not run. Run the app's one before moving the app's image tag: it is what notices
that the app keeps its session differently now.
