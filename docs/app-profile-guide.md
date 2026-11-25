# Writing a component profile

A `ComponentProfile` is the catalog entry that tells a Gentian OS cluster how an
app is installed into a tenant: which chart, what the app needs from the
platform, how people sign in, where it answers, and how its data is captured.
This guide is the short list of practices that make a profile good. It is
written for the people and the coding agents who write profiles for this
catalog, and it applies to any catalog.

It does not repeat the reference. Read these first, and cite them rather than
copy them:

| Question | Where it is answered |
|---|---|
| What does each field mean, and what may a profile ask for? | gentian-os [custom-catalogs.md §4.1](https://github.com/gentian-org/gentian-os/blob/develop/docs/guides/custom-catalogs.md), field by field, and the CRD vendored at `contracts/platform/<line>/gentianos.io_componentprofiles.yaml` |
| What is the model behind the fields: classes, requirements, privileges, exposure? | gentian-os [app-catalog.md §13 to §19](https://github.com/gentian-org/gentian-os/blob/develop/docs/concepts/app-catalog.md) |
| What is a bundle, and which companions may travel with a profile? | [profile-bundles.md](profile-bundles.md) |
| How is an installed app customized, and what is `spec.customization`? | gentian-os [app-customization.md](https://github.com/gentian-org/gentian-os/blob/develop/docs/guides/app-customization.md) and [customization-ladder.md](customization-ladder.md) |
| Which branch publishes what, and how are versions numbered? | [releasing.md](releasing.md) |
| How is a first-party app built, as opposed to packaged? | [custom-app-guide.md](custom-app-guide.md) |

The reference profiles in this catalog are
[`profiles/paperless-ngx/paperless-ngx-ce/profile.yaml`](../profiles/paperless-ngx/paperless-ngx-ce/profile.yaml)
(a first-party chart, OIDC sign-in, a companion, both hooks, a backup contract)
and [`profiles/docmost/docmost-ce/profile.yaml`](../profiles/docmost/docmost-ce/profile.yaml)
(the sign-in sidecar for an app without single sign-on). When this guide and a
reference profile disagree, the profile is more likely to be right: say so in a
pull request.

## 1. What a profile is

A profile **declares**; the platform **fulfills**. The profile says the app
needs a PostgreSQL database, a bucket, outbound mail and a sign-in client; the
operator makes each of them for every tenant that installs the app and hands
the app the credentials. The profile never names a database host, a mail
server, a realm or a namespace: those differ per cluster and per tenant, and
the platform knows them.

The kind is generic. It has no field for any one app, and no reconciler in
gentian-os knows a profile's name. When an app needs something the platform
does not offer, there are two honest answers: extend the contract in gentian-os
so every profile can declare it, or carry the behavior in the app's own bundle
(its chart, its hooks, its composition). Hardcoding one app's case into the
operator is neither, and is refused in review.

Two rules have no exception:

- **No cluster hotfix.** Nothing is changed on a live cluster by hand. A fix is
  a commit in the repository that owns the behavior, built by CI and rolled out
  by the platform ([app-customization.md §2.8](https://github.com/gentian-org/gentian-os/blob/develop/docs/guides/app-customization.md)).
- **No license bypass.** A profile installs the edition its license allows and
  configures nothing that unlocks a paid feature without the key the vendor
  sells. Where single sign-on is a paid feature, the answer is the platform's
  sign-in sidecar (§5.4), never a patch.

## 2. The repository: a distribution, not a monorepo

`gentian-apps` packages software that is mostly written elsewhere, the way a
Linux distribution does. Its layout follows from that:

```text
profiles/     catalog bundles, one directory per profile, found by profile.yaml at any depth
charts/       charts this repository authors, published to oci://ghcr.io/gentian-org/charts
images/       Dockerfiles this repository builds, published to ghcr.io/gentian-org
apps/         first-party app source (apps/_template is the scaffold)
contracts/    the vendored platform CRDs and the cross-app contracts
scripts/      the validators CI runs
e2e/          the suites that run an app's real image against the profile
```

- **A profile references its chart by coordinate**, `spec.package.chart`
  (`repository`, `name`, `version`), never by path. Charts and images are flat
  trees of their own: one chart backs many profiles (`charts/odoo` backs the
  Odoo family), and most profiles wrap charts this repository does not contain.
  Do not move a chart or an image into a profile directory.
- **Keep the recipe, not the output.** CI publishes charts and images to the
  registry; nothing built is committed. When an upstream chart needs a change,
  measure the difference before copying it: `helm pull --untar` the pinned
  version and `diff -ruN`. A few hundred lines is a patch series under
  `patches/` with `chartOwnership: patched`, not a fork. A copy is
  `chartOwnership: vendored`, and a reviewer will ask why.
- **Write a first-party chart when upstream has none.** Paperless-ngx, Docmost
  and Mathesar ship docker-compose files only; each has a small chart under
  `charts/` that wraps the official image unmodified, runs it as its own
  non-root user, and takes every platform value as a chart value (§4).
- **Directory names are free; `metadata.name` is not.** Profiles are
  cluster-scoped, and the catalog publishes each under its `metadata.name`, so
  the name is unique across the catalog. Families with addons use
  `profiles/<family>/{base,addons,packages}/<dir>/`; everything else
  `profiles/<family>/<name>/`. A `profile.yaml` without a sibling
  `kustomization.yaml` is a CI error.

## 3. The profile file

### 3.1 What every profile carries

```yaml
# SPDX-License-Identifier: AGPL-3.0-only
# ComponentProfile — <App> (<one line on what it does>)
#
# Source: … where the chart and image come from, and why this shape
# ── Sign-in ── how people get in, and who administers the app
# Secret inventory: what the platform provides, what is generated, and what each is for
apiVersion: gentianos.io/v1alpha1
kind: ComponentProfile
metadata:
  name: example-ce
  labels:
    gentianos.io/profile-name: example-ce
    gentianos.io/profile-family: example
    gentianos.io/profile-edition: ce
spec:
  classes: [app]
  trustTier: certified
  version: "0.5.1-dev"
  package:
    chart: {repository: "oci://ghcr.io/gentian-org/charts", name: example, version: "1.0.0"}
    valueMapping: {…}            # §4.2
    extraValues: {…}             # §4.1
  requires:
    platform: ">=0.5"
    services: {…}                # §1, §5
  secrets: {…}                   # §8
  expose: [{…}]                  # §7
  customization: {…}             # §12
  launch: tile
```

- **The first line is the app's license**, as an `SPDX-License-Identifier:`
  comment. A profile without one is not accepted.
- **The header comment is part of the profile.** The recent profiles open with
  the source of chart and image, how sign-in works and why, who administers
  the app and how that is applied, and an inventory of every secret: which the
  platform provides, which the profile generates, and what each is for. Write
  it for the reviewer who has never seen the app. A field that is deliberately
  absent gets a comment saying why (Paperless-ngx on `backchannelLogout`,
  Docmost on `cache`); an unexplained gap reads as an oversight and invites
  someone to fill it wrongly.
- **Required fields**: `classes`, `launch`, `trustTier`, `version` and
  `package`. None has a default, on purpose: "nobody opens this" and "nothing
  checks this caller" have to be words somebody wrote.
- **Edition and family are labels, never part of the name.** The edition is
  `ce`, `me`, `ie`, `pe` or `ee` ([AGENTS.md](../AGENTS.md) says which is
  which); this catalog holds `ce` and `me`, and both are named `<app>-ce`.
  Display name, summary, description, categories and logo are the App Store's
  and are not in the profile; only the tile is (§7.2).
- **`requires.platform`** is the oldest platform version line the bundle runs
  on. Raise it when the profile uses a field a newer line introduced, and
  vendor that line's CRDs under `contracts/platform/` first.

### 3.2 Declare only what the app needs

Every entry under `requires.services` makes infrastructure and opens network
paths: a database and a role, a bucket, a cache user, a realm client, a mail
relay path. Each is reconciled for every tenant on every install. Declare what
the app reads, and nothing on the chance it might. Two that bite:

- `cache` provisions a Redis ACL user. An app that cannot authenticate with a
  username (Docmost) runs a pod-local Redis instead and declares nothing.
- `llm` gives the app a key at the model gateway and holds the app's release on
  a cluster that serves no models. Declare it when the app cannot run without
  a model, and leave the app's optional AI features off otherwise, with a
  comment saying how to switch them on.

Most profiles are `classes: [app]`, `trustTier: certified`, `launch: tile`.
`platform` trust unlocks what reaches beyond the tenant (`forwardToken`,
`rights`, `vouching`) and a composition of the bundle's own, and is for the
platform's own components.

## 4. The chart and its values

### 4.1 What every chart deployment sets

```yaml
extraValues:
  fullnameOverride: "example-ce"        # the Service name; equals metadata.name
  ingress:
    enabled: false                       # the platform routes; a chart Ingress collides
  podAnnotations:
    reloader.stakater.com/auto: "true"   # restart on credential rotation; or
    # secret.reloader.stakater.com/reload: example-ce-sensitive-values, for this app's Secret only
```

- **`fullnameOverride` is the Service name**, and it is `metadata.name`. Every
  `expose[].backend.service` and every in-cluster address in a hook refers to
  it. A Helm release name is not stable; this is.
- **Every pod template takes `podLabels`.** The operator writes
  `gentianos.io/app` and `gentianos.io/tenant` into the chart's `podLabels`,
  and the tenant's network policies select the app's pods by them. A pod a
  chart renders without them has no network path. A first-party chart applies
  `.Values.podLabels` to every Deployment, StatefulSet, CronJob and Job it
  renders.
- **Resources, probes and the security context are chart values.** There is no
  profile-level field for them. A first-party chart ships sensible requests and
  limits, readiness and liveness probes, and runs as a non-root user with a
  read-only root filesystem where the app allows it. Where the app needs a
  waiver, ask for it as a privilege with a reason
  (`requires.privileges.podSecurity`), never by weakening the chart silently.

### 4.2 Platform values arrive through `valueMapping`, and only there

`spec.package.valueMapping` maps each value the platform provides to the chart
key that reads it. Map every key the chart needs: a database block maps all
five of `hostKey`, `portKey`, `nameKey`, `userKey` and `passwordKey`, an S3
block the endpoint, bucket, access key, secret key and region. A key left
unmapped falls back to the chart's default, which is empty or wrong, and the
failure shows up as a connection error far from its cause.

**Never write a platform value into `extraValues` as well.** The two land on
the same values path; the fixed one wins or loses by rendering order, and the
result is a profile that works on one cluster and not another. The database
host, the bucket name, the mail relay, the OIDC issuer and client secret are
all platform values. What belongs in `extraValues` is what is the same for
every tenant on every cluster: feature flags, the app's own addresses built
from placeholders, sizes.

For sign-in, map `valueMapping.oidc.issuerKey` and `clientSecretKey` and let
the app discover its endpoints from the issuer server-side. Spelling the
authorization, token and userinfo endpoints into `extraValues` by hand is a
maintenance burden and a source of drift.

### 4.3 Five placeholders

The operator substitutes these in `extraValues`; a hook script gets the first
four, and the sign-in client's addresses `${TENANT_DOMAIN}` and
`${KERNEL_DOMAIN}`. An extension's values additionally take `${SIDECAR_ID}`,
the extension's own name, and `${NODE_IP}` where a cluster states one (for a
TURN edge):

| Placeholder | Value |
|---|---|
| `${TENANT_DOMAIN}` | the tenant's domain; the app answers at `<subDomain>.${TENANT_DOMAIN}` |
| `${TENANT_ID}` | the tenant's name, and its realm |
| `${TENANT_NAMESPACE}` | the tenant's namespace |
| `${APP_ID}` | this profile's name |
| `${KERNEL_DOMAIN}` | the cluster's own domain; the identity provider is `id.${KERNEL_DOMAIN}` |

Anything else between `${` and `}`, and `${KERNEL_DOMAIN}` in a hook script,
reaches the container as literal text. Never
write a cluster's address, a namespace or a realm by hand: a value that holds
on one cluster is wrong on the next.

### 4.4 Public addresses for browsers, Service names for servers

The browser reaches the app at `https://<subDomain>.${TENANT_DOMAIN}`. Every
call made from inside the cluster, by the app, a hook, a companion or a sync
Job, uses the Service name instead: `http://example-ce:8000` within the
namespace, or `http://example-ce.${TENANT_NAMESPACE}.svc.cluster.local:8000`
from another. The public name resolves in-cluster to the edge gateway, which
means a sign-in redirect for a server, a staging certificate the client
refuses, and a round trip that never needed to leave the node. Nextcloud's
Collabora callback is the worked example: the editor's URL is public, its WOPI
callback is the Nextcloud Service.

An app that refuses a `Host` it does not know has to trust its own Service
name, since that is what the realm's back-channel logout and the platform's
in-cluster callers send.

### 4.5 Switch off what calls the internet

Egress from a tenant is closed unless a privilege opens it. An app that
phones home anyway does not fail cleanly; it waits for the timeout, on the hot
path, on every request. Before publishing, read the app's configuration for
telemetry, update checks, breached-password lookups, avatar and gravatar
fetches, license pings and public CDN assets, and switch each off in
`extraValues`, or in the app's own configuration from a hook where it has no
value for it: Docmost's `telemetry.disabled` is the first, Nextcloud's
`occ config:app:set password_policy enforceHaveIBeenPwned --value=false` in
its start-up script the second.

What the app legitimately needs from outside is a request under
`requires.privileges.egress`, answered by the tenant's perimeter approver.
Each request states exactly one of three forms (§4.7 maps every need, in
and out, to its declaration):

| Form | When | How it leaves |
|---|---|---|
| `hosts: [...]` | the names are known when the profile is written | the outgoing gateway, which passes only the granted names and records each connection; port 443 unless the host says `:port` |
| `hostsAtApproval: true` | the installation chooses the hosts, such as the operator's own ERP or bucket | the outgoing gateway; the approver names the hosts |
| `rule:` | destinations chosen at run time, or a protocol that names no host (mail to other servers, a database protocol) | the component's own NetworkPolicy, by address; not in the gateway's record |

```yaml
requires:
  privileges:
    egress:
      - name: vendor-api
        hosts: [api.example.com, uploads.example.com:8443]
        reason: "Synchronizes the documents with the vendor's hosted API."
```

```yaml
requires:
  privileges:
    egress:
      - name: customer-erp
        hostsAtApproval: true
        reason: "Reads orders from the ERP the operator connects."
```

```yaml
requires:
  privileges:
    egress:
      - name: outbound-mail
        rule:
          to: [{ipBlock: {cidr: 0.0.0.0/0}}]
          ports: [{protocol: TCP, port: 25}]
        reason: "Delivers mail to the recipients' servers, known only when a message is sent."
```

- **Never a rule when the names are known.** An approver reads a rule as
  addresses and ports, with no host to judge.
- **All known names in one request.** A profile names its hosts in one
  `hosts` request, answered once; a host is one name, not a pattern.
- **A `reason` an approver can judge**: what the app does there, for whom.
- **A host this cluster serves itself**, another app's address or an inside
  entry (§7.1), is still requested, and is reached directly at the edge, not
  through the gateway.
- **An approval is a person's**, the tenant's perimeter approver's, or a
  trusted domain's: a `hosts` request whose every host is in a domain the
  cluster or the tenant trusts counts as granted. No catalog is pre-approved.

The model is gentian-os [edge.md](https://github.com/gentian-org/gentian-os/blob/develop/docs/concepts/edge.md); approving,
trusted domains and troubleshooting are in the operating guide
[edge.md](https://github.com/gentian-org/gentian-os/blob/develop/docs/guides/edge.md).

### 4.6 Pin what you ship

A profile pins a chart version and, where this repository builds the image, an
image tag. On `develop`, that is the `<version>-develop.<sha7>` chart and the
`develop-<sha7>` image CI published for the commit; before `develop` is merged
into `main`, the profile goes back to plain versions ([releasing.md](releasing.md)).
CI checks that every chart and image a profile names exists where it says.

### 4.7 Which way in, which way out

Declare the narrowest way that serves the need.

| The app needs | Declare | Answered by |
|---|---|---|
| people to use it in a browser | `expose`: `surface: gateway`, `authMode: oidc` (§7.1) | nobody: it sits behind the session |
| its own token in the `Authorization` header behind sign-in | a gateway entry with `clientAuthorization: app` | the perimeter approver |
| anyone on the internet to reach some paths | `surface: perimeter`, `authMode: none` | the perimeter approver, per install |
| outside programs to call it with a credential the app issued | `surface: perimeter`, `authMode: app` | the perimeter approver, per install |
| only the cluster's own pods to call it, with such a credential | `surface: inside`, `authMode: app`, `subDomain` | the perimeter approver, per install; each caller needs an egress grant for the host |
| to call outside hosts known in advance | `egress[].hosts` (§4.5) | the perimeter approver, or a trusted domain |
| to call hosts the installation chooses | `egress[].hostsAtApproval: true` | the perimeter approver, who names them |
| destinations chosen at run time, or a protocol with no host name | `egress[].rule` | the perimeter approver, who reads addresses |

The full table for catalog authors is in gentian-os
[custom-catalogs.md](https://github.com/gentian-org/gentian-os/blob/develop/docs/guides/custom-catalogs.md).

## 5. Sign-in

### 5.1 Exactly one of three

`requires.services.identity` is `oidc`, `saml` or `sidecar`; declare one (the
sidecar excludes the other two), and configure nothing by hand in the realm. The platform creates the client in the
tenant's realm, hands the app its secret through `valueMapping.oidc`, and
removes the client with the app.

### 5.2 The OIDC client

```yaml
requires:
  services:
    identity:
      oidc:
        clientId: "gentian-example"
        name: "Example"
        accessType: CONFIDENTIAL
        redirectUris:
          - "https://example.${TENANT_DOMAIN}/auth/callback"
        postLogoutRedirectUris:
          - "https://example.${TENANT_DOMAIN}/"
          - "https://desktop.${TENANT_DOMAIN}/"
        backchannelLogout:
          exposure: web                       # an entry of this profile's expose
          path: /auth/backchannel-logout      # the app's endpoint, as a path
```

- **`clientId` is `gentian-<app>`**, and `accessType` is `CONFIDENTIAL` for any
  app with a server. `PUBLIC` is for an app that is only a browser.
- **Redirect addresses are on the tenant's domain**, built from
  `${TENANT_DOMAIN}`; the desktop is among the post-logout addresses so that
  signing out of the app lands a person where they started.
- **Declare back-channel logout as a path**, never as an address. The platform
  builds the in-cluster address from the entry's Service and registers it; the
  realm then posts its logout token to the app, server to server, when a
  person signs out anywhere. The app must verify that token (signature,
  issuer, audience, the logout event) before it ends a session; read the app's
  code for this and record what it checks in the profile's `Customization`
  record. An app whose
  library has no such endpoint (django-allauth) cannot declare it: write the
  comment, and the limitation is known rather than hidden.
- **Prove it.** `e2e/oidc-sign-out/` signs in through a real Keycloak, signs
  out, and checks the app's session is gone. Add the app there with its
  declaration.

### 5.3 What the realm tells the app

The token says who the person is; it carries no `groups` claim, and nothing in
it is a right by itself. Who may use the app is the platform's rights store:
the front door refuses a person who holds no role on the app before the app
sees a request. What the app may learn of a person's roles, and how, is §6.

**Watch the app's default allow-list.** Several apps ship one that names roles
like `user,admin`; it only works when the token carries those names. Either
give the app's roles those names in `spec.roles` and point the app at the
claim (Open WebUI: `OAUTH_ROLES_CLAIM=gentian_app_roles`,
`OAUTH_ALLOWED_ROLES=user,admin`, `OAUTH_ADMIN_ROLES=admin`), or set the app's
"everyone who signs in is a member" switch and let the front door be the
boundary. An allow-list the token never satisfies refuses every person after a
successful sign-in, which reads as a broken login.

The `email` claim is a person's workspace address. The person's `sub` and the
realm's issuer are what is unique; a username is unique within one realm only.

### 5.4 The front door, and the app that has no single sign-on

A `surface: gateway`, `authMode: oidc` entry sits behind the tenant's session.
The front door tells the app who is asking in the `x-gentian-subject`,
`-email`, `-name`, `-realm` and `-session` headers, strips the client's
`Authorization` header and the session's cookies, and does not hand the app
any token unless
the profile asks: `exchangeToken: true` gives the app a short-lived token
whose audience is the app alone, which it verifies against the realm's keys.
An app that signs people in through its own OIDC client needs neither.

An app that, in the edition published, can do neither OIDC nor SAML declares
the platform's **sign-in sidecar** (Docmost, OpenProject):

```yaml
requires:
  services:
    identity:
      sidecar:
        entryPaths: ["/", "/login"]      # the app's front page and its own sign-in page
        database: true                   # what the handler is given, and no more
        secrets: [app_secret]
        appPort: 3000
expose:
  - name: web
    surface: gateway
    authMode: oidc
    denyPaths: [/api/auth/login, /api/auth/setup]   # the app's own ways in, refused at the front door
    backend: {service: "example-ce", port: 3000}
```

The handler, one JavaScript file in the bundle as the ConfigMap
`<profile>.sign-in-handler`, is the program that knows how this app keeps a
session. It can become anybody in the app, so it is the last resort and comes
with a `Customization` record (rung L2) that says what it writes itself. Who
administers the app is who holds its `admin` role (`person.appAdmin`, §6.2),
and the handler gives and takes the app's own administrator role at every
sign-in.
Refuse the app's first-run or setup call under `denyPaths`: whoever reached it
first would own the installation. The full contract is
[app-customization.md §2.3a](https://github.com/gentian-org/gentian-os/blob/develop/docs/guides/app-customization.md)
and [`images/gentian-sidecar-sso-saml/README.md`](../images/gentian-sidecar-sso-saml/README.md);
`images/gentian-sidecar-sso-saml/e2e/` runs the handler against the real app.

## 6. Rights

Who may do what in an app is the platform's to say, in the app's own words.
The model is gentian-os [iam.md §1.2](https://github.com/gentian-org/gentian-os/blob/develop/docs/concepts/iam.md)
(roles and positions) and [§1.8](https://github.com/gentian-org/gentian-os/blob/develop/docs/concepts/iam.md)
(roles inside apps); the fields are
[app-customization.md §1.1 and §1.2](https://github.com/gentian-org/gentian-os/blob/develop/docs/guides/app-customization.md).
This section is what a profile has to decide.

### 6.1 The app's roles

Every app has `user` and `admin`; `admin` holds every other role of the app.
Roles between the two are declared in `spec.roles.declared`, and each role says
what it is called inside the app (`inApp`). Odoo's base names its two; the
declared roles below show the shape:

```yaml
spec:
  roles:
    user:
      inApp: [base.group_user]
    admin:
      inApp: [base.group_system, base.group_erp_manager]
    declared:
      - name: sales-manager
        title: Sales manager
        description: Runs the sales team and its pipeline.
        includes: [salesperson]
        inApp: [sales_team.group_sale_manager]
      - name: salesperson
        title: Salesperson
        inApp: [sales_team.group_sale_salesman]
```

An add-on declares its own `spec.roles` (the Odoo add-ons under
`profiles/odoo/addons/`). A role on an add-on lets a person into its base app,
and the base's administrators administer the add-on. Its roles reach the
token of the base app it is activated in: under their in-app names, or, where
the token carries the platform's names, as `<add-on>/<role>`
(`odoo-sales-ce/admin`). An add-on's own `claim` is not read.

### 6.2 How the app learns a person's roles

Pick one:

| Way | The profile declares | What the app gets | For |
|---|---|---|---|
| Token claim | `spec.roles` with `inApp` names | In the ID token, access token and userinfo: `gentian_app_roles` (or `spec.roles.claim`), the in-app names of the roles held, and `gentian_app_roles_mapped`, every in-app name the platform decides. The app gives the first, takes away the rest of the second and leaves alone what is in neither. A role without `inApp` names is not in the token; a profile and add-ons that name none get no claim | an app with its own OIDC client that maps a claim to its roles (Odoo, Open WebUI) |
| Exchanged token | `exchangeToken: true` on a `gateway`/`oidc` entry | The access token the front door hands the app carries `gentian_app_roles` in the platform's names: `user`, `admin`, declared roles, `<add-on>/<role>` | an app behind the front door without a client of its own |
| Hand-over | `requires.services.authorization.roles: handOver` | In its own store, one tuple `user:<realm>/<subject> holder role:<name>` per role held. The model declares `type role` with `define holder: [user]`; the app writes no role tuple (the arbiter answers 403) | an app that decides per record in its own model ([app-authorization.md §2.6](https://github.com/gentian-org/gentian-os/blob/develop/docs/concepts/app-authorization.md)) |
| Sync Job | `hooks.provisioning.privilegedRole` and `syncJob` | Two lists in files: who holds `admin` (for an add-on, also its base's administrators) and who holds any role. Not which declared role | an app that keeps its own administrator flag and reads no claim (§6.3) |
| Sign-in sidecar | `requires.services.identity.sidecar` | `person.appAdmin`, true for a holder of `admin` | an app with neither OIDC nor SAML (§5.4). Give `admin` no `inApp` name: the sidecar recognizes only `gentian-app-admin`, the name the platform uses when the profile names none |

A role given takes effect at the person's next sign-in. A role taken ends the
person's sessions in the realm, and an app told of the sign-out
(`backchannelLogout`, §5.2) drops its own; a person left with no role on the
app is stopped by the front door at once. A handed-over store follows within
seconds, and the sync Job runs again whenever either list changes.

### 6.3 The sync Job

How an app grants its own administrator flag is the app's business, so the
profile supplies the Job; the platform reads the lists from the rights store
and runs it whenever they change:

```yaml
hooks:
  provisioning:
    privilegedRole:
      kind: group
      name: superuser                   # descriptive; the script is what it means
    syncJob:
      image: ghcr.io/example/app:1.2.3  # usually the app's own image
      env:
        - name: ADMIN_PASSWORD
          secretKeyRef:
            name: example-ce-sensitive-values
            key: internal-admin_password
      script: |
        #!/bin/sh
        set -eu
        # converge the app to exactly the administrators in $GENTIAN_APP_ADMINS_FILE
```

The Job is given `GENTIAN_APP_ADMINS_FILE` (a JSON array of `{id, username,
email}`, the holders of `admin`), `GENTIAN_APP_USERS_FILE` (the same shape,
everyone who holds a role on the app), `GENTIAN_PRIVILEGED_ROLE`,
`GENTIAN_TENANT` and `GENTIAN_APP`. Write the script to **converge**: everyone
in the file gets the role, everyone else loses it, and nothing is written when
the app already matches. It re-runs on every change and on every failure.
Exclude the technical account it authenticates as, or a sync locks itself out.
An account that does not exist yet (the person has not signed in) is named in
the log and promoted on a later run. Bind credentials with `env` and
`secretKeyRef`, not `envFrom`: the Secret's keys are hyphenated, and Kubernetes
drops those from `envFrom` without a word. A `privilegedRole` without a
`syncJob` is reported as `AppPrivilegesReady: False`, not silently ignored.

Whichever way the app learns its roles, `admin` must administer it; an app
where administrators can do no more than members reads as "this app has no
settings".

### 6.4 Positions, seen from the app

People hold roles through positions, which the tenant gives. Four exist in
every tenant: User (`user`, the desktop and no app), All apps (`all-apps`,
`user` on every installed app and add-on), App administrator
(`app-administrator`, `admin` on every installed app) and Tenant administrator
(`tenant-administrator`, the tenant and no app). For a profile that means:

- **An install reaches few people.** The app goes to the holders of All apps
  and App administrator, and to the positions named at install
  (`kubectl gentian apps install <app> --tenant <t> --positions <a,b>`, or the
  console's Apps tab), each of which holds `user` on it. A person who holds
  only User does not see the app until somebody gives them a position.
- **Declared roles reach people only through positions the tenant declares**
  (`Tenant.spec.positions`, roles `{app, role}`) or given to one person
  directly. No shipped position holds a declared role; `admin` holds them all.
- **There is no install "for everyone".** `defaultGrant` and `addonGrants` on
  a tenant's app, and `requires.services.authorization.groups: mirror`, are
  accepted and have no effect; do not write them.

### 6.5 Testing rights

1. Give a test person a position that reaches the app, or one role beside
   their positions: the console's Members tab, the person opened. To test a
   declared role, declare a position for it in the test tenant first.
2. Have them sign in to the app again: a role given takes effect at the next
   sign-in. The console's Access tab shows what the person holds and through
   which position.
3. Check what the app was told:
   - **Token claim:** decode the ID token or the userinfo answer the app
     received; `gentian_app_roles` lists the in-app names held and
     `gentian_app_roles_mapped` every name the platform decides. For an
     exchanged token, decode the bearer the front door hands the app.
   - **Hand-over:** from the app, `POST /v1/read` on `AUTHORIZATION_URL` with
     `{"tuple": {"user": "user:<realm>/<subject>", "relation": "holder", "object": "role:"}}`
     lists the roles the person holds there.
   - **Sync Job:** the tenant's condition `AppPrivilegesReady`, and the log of
     the Job `<profile>-privilege-sync` in the tenant's namespace.
   - **Sidecar:** the handler's log at the next sign-in, and the account's
     role in the app.
4. Take the position again. The person's sessions end; after the next sign-in
   the role is gone from the claim, the store or the app, and a person left
   with no role on the app is refused at the front door.

## 7. Exposure and the desktop

Which surface fits which need is the table in §4.7.

### 7.1 Entries

```yaml
expose:
  - name: web
    surface: gateway
    authMode: oidc
    subDomain: "example"                  # example.${TENANT_DOMAIN}
    backend: {service: "example-ce", port: 8000}
    tile: {…}
```

- **One entry per host and purpose**, `surface: gateway` with `authMode: oidc`
  for anything a person uses. The other gateway mode, `bearer`, is a token
  entry for a profile of `platform` trust.
- **The backend is this app's own Service** on the port the chart serves; an
  addon's entry names its base with `backend.component` (§11.1).
- **Some names are the platform's** in every tenant: `desktop`, `admin`,
  `store`, `console`, `id`, `auth`, `login` and a few more. An entry that
  takes one is refused at install ([custom-catalogs.md §4.1](https://github.com/gentian-org/gentian-os/blob/develop/docs/guides/custom-catalogs.md)).
- **A second entry on the same host** serves a companion under its own paths:
  Nextcloud's Collabora entry shares `subDomain: nextcloud`, lists its `paths`
  and puts the editor's administration under `denyPaths`. Deny wins over allow.
- **Anything for the internet without a session is a `perimeter` entry.**
  `authMode: none` is for anyone (approval kind `public`); `authMode: app`
  passes the caller's `Authorization` header to the app, which checks it
  (kind `publicAppCredential`, or `publicAppSignIn` with `signInCookies`).
  It publishes nothing until the tenant's perimeter approver enables it for
  the install, with a review date and, where it is temporary, an expiry. It
  is a request, not a setting.
- **What only the cluster's own pods call is an `inside` entry**:
  `surface: inside`, `authMode: app`, a `subDomain` of its own, no `apex`.
  The internet has no route and no public DNS record for it; it is reachable
  only by the cluster's pods that hold an egress grant for its host. The
  perimeter approver enables it like a perimeter entry (kind
  `insideAppCredential`). Prefer it to a perimeter entry whenever nobody
  outside the cluster calls.

  ```yaml
  expose:
    - name: sync-api
      surface: inside
      authMode: app
      subDomain: "example-sync"          # example-sync.${TENANT_DOMAIN}, inside only
      paths: [/api]
      backend: {service: "example-ce", port: 8000}
  ```
- **Only two annotations exist on an entry**:
  `gentianos.io/gateway-frame-ancestors` and
  `gentianos.io/gateway-escaped-slashes-action` (the latter for WOPI and
  WebSocket paths with encoded slashes). Never write `Content-Security-Policy`
  or `X-Frame-Options` anywhere: the operator owns the frame policy of every
  route it makes, and a chart that sends its own CSP has it replaced.

### 7.2 The tile

```yaml
    tile:
      displayName: "Paperless-ngx"        # the product's own name
      displayNames: {de_DE: "Paperless-ngx"}
      description: "Scan, OCR and archive your paper"
      image: assets/tile.png              # the committed file …
      logo: data:image/png;base64,…       # … inlined; scripts/sync-profile-tile.py keeps them equal
      path: /                             # optional; where the tile leads
      relation: can_launch                # what the person must hold
```

The tile is the one piece of presentation in a profile, because the desktop
must show what the cluster routes without asking a service outside it. Use the
product's own name: the App Store shows this label for an entry it has no
listing for, and a generic word there reads as a different app. The logo is a
128x128 PNG, the project's own mark or the neutral glyph
`scripts/render-default-tile.py` draws, inlined by
`scripts/sync-profile-tile.py`; CI refuses a stale one. `launch: tile` says the tile is how people reach the app; an entry with
no tile is an API, and an app nobody opens says `launch: none` in words.

### 7.3 Running inside the desktop

The desktop opens a tile as an iframe in one browser tab, so an app that is
embedded well:

- **draws no window chrome of its own**: detect the iframe client-side
  (`window.self !== window.top`) and hide the app's header, the space reserved
  for it, and its own wallpaper. The app is also reachable directly at its own
  host, where it needs its navigation. Nextcloud's image does this in its
  entrypoint, re-applied from the pristine template on every start.
- **shares browser storage with every other tile on the same origin.** All
  tiles of an app family share one host, so `localStorage` and
  `sessionStorage` are one store across them; an app that remembers "the last
  thing this session did" shows one tile's state in another. Derive state from
  the tile's own URL, not from storage.
- **follows the shell's theme default** rather than pinning one.

## 8. Secrets

Three kinds, three places:

| The secret | Where it is declared |
|---|---|
| a credential the platform makes for a requirement (database, bucket, client secret, mail) | nowhere: it arrives through `valueMapping` |
| a value the app needs that has no counterparty: a session signing key, a bootstrap admin password, a companion's account password | `secrets.generated[]`, with the chart `valuePath` that receives it |
| a credential only a person can provide: a payment provider's keys, a token of a service outside the cluster | `secrets.supplied[]`; the tenant's administrator is asked for it in the console |

Generated secrets are made once per tenant, kept in the vault and reach the
chart as values; they are also in the Secret `<profile>-sensitive-values`
under the key `internal-<name>`, which is how a hook or a companion reads the
same value the app holds. **Pin every key the app signs with**, or every
session dies at each restart. A secret is never in `extraValues`, never in a
composition's own vault write, and never in git.

## 9. Bootstrap through the app's own API

Some state can be set only through the app's own interface after it runs: an
account for a companion, a workflow, a group's permissions, a first-boot value
the app copied into its database and ignores from the environment ever after.
That is `hooks.postInstall`:

```yaml
hooks:
  postInstall:
    image: ghcr.io/example/app:1.2.3     # usually the app's own image, for its CLI or runtime
    envFrom: [example-ce-env]            # Secrets in the tenant namespace, by name
    script: |
      #!/bin/sh
      set -eu
      …                                  # ${TENANT_ID} and the other placeholders are substituted
```

Before writing one, check that the platform does not already do the thing
generically: databases, buckets, caches, sign-in clients, mail and credentials
are declarations, not scripts. A hook is for the app's own protocol. Write it
to **exit non-zero until the app answers** (the Job retries, ten times) and to
**change nothing once the state matches** (it runs again whenever its script
changes). Call the app by its Service name. Keep what it does in the header
comment: a reviewer reads the comment, not the script.

The fields are `image`, `script`, `envFrom` (Secret names only), an optional
`serviceAccountName` and, rarely, a `readOnlyPVC` for a value only the app's
own data holds. There is deliberately no pod spec passthrough.

## 10. Backup and restore

`requires.services` tells the platform which stores the app has; the default,
scale the app to zero, dump every store, archive every volume the release
owns, is right for a plain app. `spec.backup` holds only the deviations:

```yaml
backup:
  quiesce:
    mode: command                                   # the app has a real maintenance mode
    pre:  [php, occ, "maintenance:mode", --on]      # argv, never a shell line
    post: [php, occ, "maintenance:mode", --off]     # must be safe when pre never ran
    container: app
  volumes:
    excludePaths: ["**/data/index"]                 # what the app rebuilds; never configuration or keys
  restore:
    post:
      - [python3, manage.py, document_index, reindex]
    verify: [python3, manage.py, check]             # always: a restore must prove the app can read its data
```

- **Commands are argument vectors.** A shell string is valid YAML and fails on
  a live tenant; CI refuses it.
- **Exclude only what the app rebuilds**: thumbnails, previews, search
  indexes, caches. Excluding configuration or key material looks like a
  saving and makes the backup unrestorable; CI refuses paths that look like
  either.
- **An app that remembers where it ran** (its address, its database's name)
  rewrites that in `restore.post`, using the `GENTIAN_RESTORE_SOURCE_*` and
  `GENTIAN_RESTORE_TARGET_*` variables the platform passes. An app whose data
  cannot move to another domain (a Matrix server) says `domainBound: true`.
  `e2e/restore-rewrites/` runs the app under one domain, restores it under
  another and runs these commands as the platform would: add the app there.
- Schedule, retention, encryption and destination are the tenant's policy and
  are not in a profile.

The sequence and the bundle format are gentian-os
[data-lifecycle.md](https://github.com/gentian-org/gentian-os/blob/develop/docs/concepts/data-lifecycle.md).

## 11. Addons, extensions and compositions

### 11.1 An addon flips a switch in its base

An addon runs nothing. It names its base and the switch, and routes its tile
into the base's Service:

```yaml
metadata:
  annotations:
    gentianos.io/deployment-role: addon
spec:
  package:
    addon: {id: calendar, of: nextcloud-base-ce}
  expose:
    - name: calendar
      surface: gateway
      authMode: oidc
      subDomain: nextcloud
      backend: {component: nextcloud-base-ce, service: nextcloud, port: 8080}
      tile: {displayName: Calendar, path: /apps/calendar/, relation: can_launch, …}
  launch: tile
```

An addon carries no chart, no `customization` block and no
`requires.services` of its own, only `requires.platform`; the base declares
how a selection is activated
(`customization.addonActivation`, `addonValues`), and
[app-customization.md §4.2](https://github.com/gentian-org/gentian-os/blob/develop/docs/guides/app-customization.md)
is the model. A preset that bundles several addons is an `AppPackage` under
`profiles/<family>/packages/`, published for the App Store and never installed
as such.

### 11.2 An extension is a chart beside the app

A companion the app needs in its own namespace, an MCP server for example, is
an entry of `spec.extensions`: a chart, its values, its own generated secrets,
and a stable Service name and port the app reaches it by. It is deployed and
removed with the app, shares its credentials Secret where the two must hold
one value (Paperless-ngx's `mcp` extension and the account its hook creates),
and is reachable only inside the namespace.

### 11.3 A composition is the last resort

`spec.package.composition` names a Crossplane Composition the bundle brings,
`app-<profile>`, for an app whose rollout needs objects the chart cannot
express. It is rendered only for a profile of `platform` trust (the operator refuses it
with `CompositionRefused` otherwise, whatever the schema admitted), travels
only in a catalog of the whole cluster, and is used beside a chart: a
composition alone is `PackageUnsupported`. Everything a hook or an extension
can do is done there instead, and two apps that run together are two
profiles, the one people open naming the other in `comesWith` (Element and
the Synapse homeserver it talks to).

## 12. The customization declaration

Every profile that is not an addon declares its customization ladder:

```yaml
customization:
  grade: C                       # from the rubric score: A >= 7, B >= 5, C >= 3, else D
  rubricScore: 4
  supportedRungs: [L0, L4]       # never L2; L2 is always available
  ladderDocs: https://github.com/gentian-org/gentian-apps/blob/main/profiles/<family>/<name>/customization.md
  configure: {hotReload: false}
  repackage: {chartOwnership: gentian-owned}   # upstream | patched | gentian-owned | vendored
  patch: {allowed: false, seriesPath: patches/series, requiresApproval: platform-team}
  fork: {allowed: false}
```

`customization.md` beside the profile holds the assessment in prose, and
`customizations/<name>.yaml` records every deviation from rung L2 up, written
before the code. The rubric, the records and what CI checks on them are
[customization-ladder.md](customization-ladder.md); the ladder itself is
gentian-os [app-customization.md](https://github.com/gentian-org/gentian-os/blob/develop/docs/guides/app-customization.md).

## 13. Versions, bundles and what CI checks

- **A bundle is one file with one digest**: `profile.yaml` first, then every
  companion `kustomization.yaml` lists (a composition, an OIDC pack catalog,
  asset ConfigMaps, customization records), each named for its profile
  ([profile-bundles.md](profile-bundles.md)). A cluster installs by that
  digest, and a changed bundle reaches a tenant only when its install is moved
  to the new build.
- **`spec.version` moves with the bundle.** It is the catalog entry's version,
  not the app's. On `develop` it carries a `-dev` suffix (`0.5.1-dev.9`) and
  is bumped whenever the published bundle changes; a comment inside the
  profile counts, because the digest covers the bytes. The release from `main`
  sets the bare number and admits no `-dev` version, no `-develop.<sha7>`
  chart and no `develop-<sha7>` image.
- **CI runs every validator** in `.github/workflows/apps-ci.yaml` on every pull
  request; nothing needs to be run by hand, and each script can be run locally
  with `python3 scripts/<name>.py` (the kustomization check is a workflow step):

| Check | What fails it |
|---|---|
| `build-catalogue-source.py --check` | a kind other than `ComponentProfile`; a duplicate name; an edition outside `ce me ie pe ee`; a companion with the wrong kind, name or labels; an `argocd.argoproj.io/*` annotation; a bundle over 180 KiB |
| `validate-profile-versions.py` | a changed bundle with an unchanged `spec.version`; a `-dev` version or develop chart on `main` |
| `validate-platform-schema.py` | a profile that does not fit the CRD of every line from `requires.platform` up |
| `validate-chart-refs.py`, `validate-image-tags.py` | a chart or image that does not exist where the profile says; a `develop-<sha7>` image on `main` |
| `validate-pull-secrets.py` | a chart that renders the pull secrets it is given as plain names in a pod's `imagePullSecrets`; a chart that writes the list as it is needs `gentianos.io/standard-image-pull-secrets: "true"` on the profile |
| `validate-profile-tiles.py` | a `logo` that is not the 128x128 PNG of its `image` |
| `validate-ingress-annotations.py` | an entry annotation other than the two that exist |
| `validate-secret-refs.py`, `validate-secret-seeds.py` | a Secret name that is not this profile's; a composition that writes to the vault |
| `validate-backup-spec.py` | a shell-string command; an excluded path that looks like configuration or keys |
| `validate-customizations.py` | a missing or inconsistent `customization` block or record |

- **Three end-to-end suites** run the app's real image against the profile:
  `e2e/oidc-sign-out/` for a `backchannelLogout` declaration,
  `e2e/restore-rewrites/` for `backup.restore.post`, and
  `images/gentian-sidecar-sso-saml/e2e/` for the sign-in sidecar. A profile
  that declares one of these adds its `<app>.e2e.js` to the suite. Nothing
  enforces that, so a declaration that was never run says so in a comment.

## 14. Checklist

Before opening a pull request:

- [ ] First line is `# SPDX-License-Identifier: …`; the header says where the
      chart and image come from, how sign-in works, who administers the app
      and lists every secret
- [ ] `kind: ComponentProfile`; the three `gentianos.io/profile-*` labels;
      `classes`, `launch`, `trustTier`, `version`, `package` and
      `requires.platform` set
- [ ] The chart is referenced by coordinate and exists; develop builds are
      pinned by `-develop.<sha7>` and `develop-<sha7>`
- [ ] `fullnameOverride` equals `metadata.name` and every `backend.service`;
      the chart's `ingress` is off; a Reloader annotation is set; every pod
      template takes `podLabels`
- [ ] Every platform value the chart reads is in `valueMapping`, none of them
      repeated in `extraValues`
- [ ] Only the five placeholders appear; no cluster address, namespace or realm
      is written by hand; in-cluster calls use Service names
- [ ] Telemetry, update checks and other outbound calls are off; what the app
      needs from outside is an egress request with a reason, by `hosts`
      unless the names are unknown (§4.5)
- [ ] `identity` is one of `oidc`, `saml`, `sidecar`; an OIDC client has
      `redirectUris` and `postLogoutRedirectUris` on `${TENANT_DOMAIN}` and
      `backchannelLogout` as a path, or a comment saying why not
- [ ] The app's own allow-list default is dealt with: it names what the
      roles claim carries, or it is off and the front door is the boundary
- [ ] The app learns its people's roles one way (§6.2): `spec.roles` with
      `inApp` names for the claim, `roles: handOver`, a sync Job, or the
      sidecar; the app's `admin` role administers it
- [ ] A sync Job converges and excludes its own technical account
- [ ] Rights were tested with a position given and taken (§6.5); no
      `defaultGrant`, `addonGrants` or `groups: mirror` is written
- [ ] Every entry is `gateway` + `oidc` unless it is for the internet
      (`perimeter`) or for the cluster's pods alone (`inside`); no CSP
      or frame header anywhere; the tile is the product's name and a 128x128
      PNG kept in sync
- [ ] Generated secrets have a `valuePath`; keys the app signs with are
      generated, not random at start
- [ ] A post-install hook exits non-zero until the app answers and is a no-op
      once the state matches
- [ ] `spec.backup` holds only deviations; commands are argv; nothing
      configuration-like is excluded; `restore.verify` is set
- [ ] `customization` is declared (not for an addon) and `customization.md`
      exists
- [ ] `spec.version` is bumped if the bundle changed; the e2e suite the
      declarations call for has the app
