# AppProfile Authoring Guide

This guide covers **catalogue entries for existing upstream Helm charts** (profile
YAML only). To **build a new Gentian-native app** (FastAPI + React + Helm), see
[custom-app-guide.md](custom-app-guide.md).

This guide captures the accumulated learnings and best practices from the existing
AppProfile implementations. Read it before writing a new profile — every section
corresponds to a class of bug that was caught in git history.

## Platform boundary — **no app-specific hardcoding in gentian-os**

**Never** put app-specific values, profile names, or `case "myapp"` logic in gentian-os.
There are **only two** valid options:

1. **Many apps need it** — extend the **AppProfile** contract (spec, annotations, or
   composition hooks) **and** gentian-os so the operator implements the behaviour
   **generically** for every profile that declares it.
2. **Unique to one app** — implement it in **gentian-apps**: the profile,
   `composition.yaml`, assets, chart `extraValues`, bootstrap Jobs, and other
   app-owned artefacts — **not** in gentian-os reconcilers or kernel policy.

If neither path is ready yet, **leave the gap** (reconciler reports not implemented /
fails clearly) rather than hardcoding an exception for a single catalogue entry.

### MAC waivers (Stage 2)

Apps that cannot satisfy baseline Kyverno policies declare requests on
`AppProfile.spec.security.macWaivers`. **Cluster administrators** approve subsets on
the cluster singleton `PlatformSecurityPolicy` (Admin Console → **Platform** tab,
platform superadmin only). The operator intersects request ∩ allowlist, publishes
`gentian-platform-security` for compositions, and Kyverno excludes only labelled pods
— not cluster-wide PolicyExceptions.

---

## 1. Mandatory top-level fields

```yaml
apiVersion: gentianos.io/v1alpha1
kind: AppProfile
metadata:
  name: <app-id>                        # lowercase, kebab-case (unique CR name)
  labels:
    gentianos.io/profile-name: <app-id> # must match metadata.name (controller also sets family/version labels)
spec:
  deploymentMethod: crossplane          # ALWAYS crossplane — never tofu-controller
  family: <logical-app-id>
  catalogueVersion: "1.0.0"
  edition: full
  trustTier: certified              # platform | certified | experimental
  license: Apache-2.0               # SPDX; proprietary for gentian-premium
```

Commerce (customer, price, invoice) is handled in **CRM/ERP (Odoo)** — see
[business-logic-plan.md](../gentian-os/docs/design/business-logic-plan.md).

### Portal app-menu tiles

Gentian portal / app-menu icons use a **two-path** model on `AppProfile.spec.tile`:

| Path | Spec | Notes |
|---|---|---|
| **Catalogue** | `tile.icon: mail` | Pick from `gentian-ui/design-system/tiles/catalogue.json` |
| **Custom** | `tile.image: assets/tile.svg` → run `scripts/sync-profile-tile.py` | Inlines to `tile.logo` data URI |

Per sub-app overrides: `spec.portalTiles[].tile.icon` (e.g. OX mail vs calendar).

The gentian-os LDAP reconciler resolves `tile.icon` to a data URI when writing
`pathToLogo`. Legacy `spec.logo` still works but is deprecated.

CI: `scripts/validate-profile-tiles.py` (see `.github/workflows/apps-ci.yaml`).

### Base + module profile bundles

For apps with a shared runtime and thin module entries (Odoo, OX-style), use
**metadata annotations** — do not add per-app fields to `AppProfile` spec:

| Annotation | Values | Purpose |
|---|---|---|
| `gentianos.io/deployment-role` | `standalone` (default), `base`, `module` | How the operator/composition deploys this entry |
| `gentianos.io/requires-profile` | AppProfile name | Base profile auto-installed when `deployment-role=module` |
| `gentianos.io/platform-app` | `"true"` | Hidden from App Store listing (required base runtimes) |

App-specific install parameters (e.g. Odoo module technical name) belong in
`spec.extraValues` and the profile-scoped composition — not in gentian-os CRDs.

### Profile annotations vs composition — where to put app-specific config

Gentian-os should stay **generic**. When a behaviour is shared across apps or
owned by the **operator** (gateway routes, OIDC fallbacks, auto-install base
profiles), declare it on the **AppProfile metadata** using `gentianos.io/*`
annotations. When behaviour is **deploy sequencing**, **one-off Jobs**, or
**upstream-chart workarounds** that should eventually move upstream, put it in the
profile's **`composition.yaml`** (`app-ox`, `app-element`, …).

| Put it in… | When | Examples |
|---|---|---|
| **`spec.kernelRequirements` + `valueMapping`** | Any app needs a standard kernel function (OIDC, LDAP, DB, S3, mail) | `clientId`, `redirectUris`, `databasePerTenant` |
| **Profile annotation** | Operator or gateway reconciler must do the same thing for many apps; value is small and stable | `gentianos.io/deployment-role`, `gentianos.io/gateway-api-backends`, `gentianos.io/oidc-default-redirect-uris` |
| **`spec.extraValues`** | Helm chart needs non-secret structured config; composition passes it through | Odoo `module: crm`, chart feature flags |
| **`composition.yaml`** | Custom Crossplane MR graph, bootstrap Jobs, RBAC, chart-specific sequencing | OX bootstrap Job, Element Jitsi overlay, module install Jobs |
| **Upstream chart / vendor** | Fix belongs in the supplier chart long-term | OX `initconfigdb -i`, Keycloak client scopes in openDesk |

**Never** add per-app fields to the `AppProfile` CRD. **Never** hardcode
profile names or app-specific branches in gentian-os reconcilers — see
**Platform boundary** above. If you need a new operator behaviour,
add a **well-known annotation** (or extend an existing generic `spec` block used
by all apps) and set it from `gentian-apps/profiles/<name>/profile.yaml`.

#### Gateway annotations

| Annotation | Format | Purpose |
|---|---|---|
| `gentianos.io/gateway-root-redirect` | Path string | Redirect `GET /` on the app hostname (e.g. `/appsuite/`) |
| `gentianos.io/gateway-api-backends` | JSON array | Extra path prefixes routed to additional Services on the same host |
| `gentianos.io/gateway-frame-ancestors` | JSON object on **`ingress.annotations`** or **`additionalIngresses[].annotations`** | Override edge `frame-ancestors` for that host. Shape: `{"mode":"replace\|append","origins":["portal","mainApp",...]}`. Tokens: `portal` → `https://portal.<kernel>`; `mainApp` → primary ingress host (`https://<ingress.subDomain>.<tenant-domain>`). Use when a **secondary host** (e.g. office editor) is embedded by the main app UI, not the portal. |
| `gentianos.io/gateway-escaped-slashes-action` | `KeepUnchanged` on **`additionalIngresses[].annotations`** | Envoy `ClientTrafficPolicy` on the tenant (and kernel wildcard) gateway listener — required for WOPI/WebSocket paths with encoded slashes (`%3A`, `%2F`). |

```yaml
metadata:
  annotations:
    gentianos.io/gateway-root-redirect: /appsuite/
    gentianos.io/gateway-api-backends: |
      [{"pathPrefix":"/appsuite/api","serviceName":"appsuite-api"}]
```

#### OIDC redirect fallback

Prefer **`spec.kernelRequirements.identity.oidc.redirectUris`** (substitutes
`${TENANT_DOMAIN}`). When legacy Jobs cannot rely on spec alone, use:

| Annotation | Format |
|---|---|
| `gentianos.io/oidc-default-redirect-uris` | JSON array of URIs with `${TENANT_DOMAIN}` |

If both spec and annotation are empty, the operator falls back to
`https://{tenant-domain}/{profile-name}/*` (discouraged — set explicit URIs).

---

## 2. Placeholders (substituted at deploy time)

The **gentian-os operator** sets `App.spec.domain` from the tenant's
effective domain. **Crossplane app Compositions** replace placeholders in
`extraValues` and OIDC redirect URIs when rendering helm values and
`provider-keycloak` Client MRs. Use placeholders everywhere — never
hardcode cluster-specific addresses.

| Placeholder | Resolves to |
|---|---|
| `${TENANT_DOMAIN}` | Tenant effective domain (e.g. `demo.desk.gentian.org`) |
| `${TENANT_ID}` | Tenant name / Keycloak realm (e.g. `demo`) |
| `${TENANT_NAMESPACE}` | Kubernetes namespace (`tenant-{id}`) |
| `${KERNEL_DOMAIN}` | Cluster kernel DNS suffix (e.g. `desk.gentian.org`) |
| `${LDAP_HOST}` | UCS LDAP service hostname |
| `${LDAP_BASE_DN}` | LDAP base DN (e.g. `dc=swp-ldap,dc=internal`) |
| `${LDAP_BIND_DN}` | App-specific LDAP bind DN |
| `${SMTP_HOST}` | Postfix service address (injected by operator) |
| `${S3_ENDPOINT}` | MinIO API endpoint URL |
| `${MYSQL_HOST}` | MariaDB service (OX App Suite) |
| `${REDIS_HOST}` | Redis service (OX App Suite) |
| `${IMAP_HOST}` | Dovecot/IMAP service |
| `${NODE_IP}` | Node external IP (Jitsi TURN) |
| `${TURN_*}` | TURN credentials (Element/Jitsi, from kernel path) |

**Common mistake:** Using a hardcoded cluster-internal address like
`nubus-dev-ldap-server.gentian-dev.svc.cluster.local` instead of `${LDAP_HOST}`.
That value only works in one cluster and breaks on every other environment.

### `${TENANT_DOMAIN}` vs `${KERNEL_DOMAIN}` — where and why

| Placeholder | Use for | Why it matters |
|---|---|---|
| **`${TENANT_DOMAIN}`** | App-facing URLs on the tenant zone: `chat.${TENANT_DOMAIN}`, `meet.${TENANT_DOMAIN}`, OIDC `redirectUris`, Matrix `serverName`, public Jitsi URL, `mail.${TENANT_DOMAIN}` in OX | Browsers, Keycloak, and ingress must agree on the **same hostname** the user sees. A typo or hardcoded domain causes `redirect_uri` mismatch, broken cookies, or TLS on the wrong cert (`*.<effectiveDomain>`). |
| **`${KERNEL_DOMAIN}`** | Shared platform hosts: `portal.${KERNEL_DOMAIN}`, `id.${KERNEL_DOMAIN}`, post-logout redirect to portal | Kernel UIs and the Gentian Portal live on the **cluster** wildcard, not the per-tenant app wildcard. Mixing these (e.g. OIDC issuer on tenant domain when the app expects `id.<kernel>`) breaks SSO and iframe embedding from the portal. |

**Rule of thumb:** anything the tenant's users type in the address bar for an
**installed app** → `${TENANT_DOMAIN}` (plus `subDomain` in `AppProfile.spec.ingress`).
Anything on the **platform shell or IdP** → `${KERNEL_DOMAIN}`.

**Keycloak / `global.domain`:** charts build `https://{hosts.keycloak}.{global.domain}`
for OIDC. Set `global.domain: "${KERNEL_DOMAIN}"` and prefix tenant app host
labels with `${TENANT_ID}` (e.g. `jitsi: "meet.${TENANT_ID}"` →
`meet.demo.desk.gentian.org`). See `gentian-apps` commit `b1203d0`.

### Central IdP — required pattern (all profiles)

Gentian uses a **central Keycloak** on the kernel domain. Realms are **per tenant**
(`/realms/${TENANT_ID}`), but the IdP hostname is always **`id.${KERNEL_DOMAIN}`**
— never `id.${TENANT_DOMAIN}` or `id.${TENANT_ID}.…`.

| What | Placeholder / URL | Example (tenant `demo`, kernel `desk.gentian.org`) |
|---|---|---|
| IdP base | `https://id.${KERNEL_DOMAIN}` | `https://id.desk.gentian.org` |
| Realm | `/realms/${TENANT_ID}` | `/realms/demo` |
| Full issuer | `https://id.${KERNEL_DOMAIN}/realms/${TENANT_ID}` | `https://id.desk.gentian.org/realms/demo` |
| App login redirect | `https://{sub}.${TENANT_DOMAIN}/…` | `https://projects.demo.desk.gentian.org/…` |
| Portal / post-logout | `https://portal.${KERNEL_DOMAIN}` | `https://portal.desk.gentian.org` |

**Two configuration styles in existing profiles:**

1. **OpenDesk charts with `global.domain` + `global.hosts`** (Element, Jitsi,
   OpenProject, XWiki): set `global.domain: "${KERNEL_DOMAIN}"`,
   `global.hosts.keycloak: "id"`, and prefix **tenant app** host labels with
   `${TENANT_ID}` (`chat.${TENANT_ID}`, `projects.${TENANT_ID}`, …). OIDC
   redirect URIs and public app URLs still use `${TENANT_DOMAIN}`.
2. **Explicit OIDC property blocks** (OpenProject `openproject.oidc.*`, OX
   `com.openexchange.oidc.*`, XWiki `oidc.provider`): every endpoint and issuer
   must use `id.${KERNEL_DOMAIN}/realms/${TENANT_ID}`. Charts without
   `global.hosts.keycloak` (OX) may keep `global.domain: "${TENANT_DOMAIN}"`
   for the app hostname only — but must not derive IdP URLs from it.

The operator seeds OIDC issuer/client credentials in OpenBao as
`https://id.${KERNEL_DOMAIN}/realms/${TENANT_ID}` (stable across vanity
`spec.domain` overrides). Profiles that use `valueMapping.oidc.issuerKey`
(Element/Synapse) rely on that seed; do not hardcode a tenant-scoped IdP host.

**Common IdP mistakes:**

- `global.domain: "${TENANT_DOMAIN}"` with `hosts.keycloak: "id"` → resolves to
  `id.demo.desk.gentian.org` (404). Use `${KERNEL_DOMAIN}` instead.
- Hardcoded realm names (`opendesk`, `souvap`) instead of `${TENANT_ID}`.
- Redirect URIs on `${KERNEL_DOMAIN}` or portal host instead of `${TENANT_DOMAIN}`.

**ACME staging (dev):** when `tenantDNS01ClusterIssuer` contains `staging`,
compositions mount `gentian-staging-ca-tls` and (for Synapse) set
`use_insecure_ssl_client_just_for_testing_do_not_use` plus explicit OIDC
endpoints with `discover: false` and `user_profile_method: userinfo_endpoint` in
`additionalConfiguration.oidc_providers` (see `gentian-os/docs/design/security.md`
§9). `install.sh` and the gentian-os operator bootstrap `gentian-staging-ca-tls`
in `gentian-dev` and replicate it into each `tenant-*` namespace; run
`./update.sh --acme-issuers` to refresh the bundle after issuer or kernel cert
changes.

---

## 3. Secrets and valueMapping

Secrets are **never** placed in `extraValues`. They travel from OpenBao →
Crossplane `ExternalSecret` → flat Kubernetes `Secret` → Helm `set[]` values.

`valueMapping` maps each secret category to the Helm value path the chart expects:

```yaml
valueMapping:
  oidc:
    clientSecretKey: "openproject.oidc.secret"   # path in Helm values tree
  database:
    # Map ALL FIVE fields — missing any one causes the chart to fall back to
    # a default (usually empty or wrong). This is the most common database bug.
    hostKey:     "postgresql.connection.host"
    portKey:     "postgresql.connection.port"
    nameKey:     "postgresql.auth.database"
    userKey:     "postgresql.auth.username"
    passwordKey: "postgresql.auth.password"
  s3:
    secretKeyKey: "s3.auth.secretAccessKey"       # only the secret key is secret
  smtp:
    passwordKey: "environment.OPENPROJECT_SMTP__PASSWORD"
  ldap:
    bindPasswordKey: "environment.OPENPROJECT_SEED_LDAP_..._BINDPASSWORD"
```

Non-secret fields (S3 endpoint, S3 bucket name, S3 access key ID, LDAP host, SMTP
host) belong in `extraValues` using placeholders, **not** in `valueMapping`.

---

## 4. App-level secrets (appSecrets)

Use `appSecrets` for secrets that belong to the app itself and are not provisioned
by a kernel reconciler (e.g. initial admin passwords):

```yaml
appSecrets:
  - name: admin_password
    valuePath: "openproject.admin_user.password"
```

The orchestrator seeds these into OpenBao under
`gentian-os/tenants/{tenant}/apps/{app}/internal/{name}` and injects them via
the Crossplane `ExternalSecret` → Helm `set[]` pipeline at deploy time.

---

## 5. Edge routing, TLS and CORS

### 5a. How TLS is provisioned

Setting `spec.ingress` (with `tlsEnabled: true`, the default) tells the
gentian-os controller to create:

1. A Gateway API `HTTPRoute` at `{subDomain}.{effectiveDomain}` → `Service:{servicePort}`.
2. One **DNS-01 wildcard** cert-manager `Certificate` per tenant
   (`tenant-{tenant}-wildcard-tls`) covering `*.{effectiveDomain}`.

All app routes for that tenant reference the same TLS secret on the tenant Gateway.
**Do not** set per-app HTTP-01 issuers in profiles — `spec.ingress.clusterIssuer`
is reserved for a possible future mode and is **ignored** by the operator today.
See [gentian-os/docs/architecture.md](../gentian-os/docs/architecture.md) §6.1.

```yaml
ingress:
  subDomain: "projects"        # → projects.demo.desk.gentian.org
  serviceName: "openproject"   # must match the Kubernetes Service name
  servicePort: 8080
  tlsEnabled: true             # default
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "128m"  # bridged to Envoy policy
```

**`subDomain` capitalization matters.** The field is validated; `subdomain`
(lowercase) is silently ignored, leaving the app with no edge route.

### 5b. Always disable chart-managed ingress

Every chart that ships its own `Ingress` or Gateway route must have it disabled,
otherwise two edge routes collide on the same host:

```yaml
extraValues:
  ingress:
    enabled: false
```

### 5c. Predictable Service name

The Crossplane composition generates a random Helm release name. If the chart
derives its Service name from the release name, the operator cannot predict it.
Set `fullnameOverride` to lock the Service name:

```yaml
extraValues:
  fullnameOverride: "openproject"   # must match spec.ingress.serviceName
```

### 5d. CORS — why most apps need nothing extra

Gentian OS avoids browser CORS issues by architecture:

- Apps load in **iframes** from the Gentian Portal on `portal.{kernelDomain}`;
  app UIs are on `{sub}.{tenantDomain}` (cross-origin). The operator injects
  `frame-ancestors` for the kernel portal origin.
- **OIDC** token exchange is server-side — no `fetch()` to a foreign origin.
- When the shell itself needs to call an app's API, declare a
  `spec.browserProxy` route (see §5e). The shell server proxies the call
  server-side; the browser sees a same-origin request.

If your app's own UI calls back to its own backend (normal REST/XHR to the same
host), no CORS configuration is needed.

### 5e. Shell proxy for app APIs (`spec.browserProxy`)

Declare a `browserProxy` route when the gentian shell (not the app's own UI)
needs to call the app's API from the browser. The shell exposes
`/api/apps/{appName}/{path}` and forwards requests to the cluster-internal
service, injecting the user's bearer token.

```yaml
browserProxy:
  - path: api
    target: "http://openproject.{namespace}.svc/api/v3/"
    authMode: forward-bearer   # default — forwards the user's Bearer token
    stripPrefix: true          # default — strips /api/apps/{name}/api before forwarding
```

**When you need it:** the shell calls the app's REST API to show a widget,
badge count, or AI context. **When you don't:** the app's own UI calls its own
backend (same host, no CORS).

---

## 6. Portal iframe embedding (CSP / `frame-ancestors`)

Gentian apps open inside the **kernel portal** (`https://portal.${KERNEL_DOMAIN}`)
in an iframe (gentian-ui window manager). The app UI is cross-origin
(`https://chat.${TENANT_DOMAIN}`, etc.). Browsers block embedding unless the app
response explicitly allows the portal origin in **`Content-Security-Policy:
frame-ancestors`**.

### 6a. Firefox “will not allow … if another site has embedded it”

That message means the app's CSP (or `X-Frame-Options`) does **not** include
`https://portal.${KERNEL_DOMAIN}` in `frame-ancestors`, or Keycloak (`id.<kernel>`)
does not yet allow the app origin (`https://chat.<tenant>`, etc.) when OIDC loads
inside a WinBox iframe.

**Launch behaviour (gentian-ui):**

| Click | Behaviour |
|---|---|
| Normal click on an `embedded` tile | Opens in WinBox (portal shell iframe) |
| **Ctrl/Cmd+click** (any tile) | Opens in a **new browser tab** |
| `newwindow` tile (e.g. OX App Suite) | Normal click → new tab (app blocks iframes; use only when the app cannot run in WinBox) |

OIDC apps that work in the portal shell (Element, XWiki, …) should use **`linkTarget: embedded`**
in `portalTiles`. Reserve `newwindow` for apps that block iframe embedding (OX App Suite).

The gentian-os **KeycloakPlatformReconciler** converges `id.<kernel>` HTTPRoute CSP
and Keycloak realm `X-Frame-Options` for all tenants; `install.sh` verifies this
before declaring the cluster ready.

**Do not fix this in AppProfiles.** The gentian-os operator injects edge
`frame-ancestors` policy on every HTTPRoute it manages (via Envoy
`ResponseHeaderModifier` filters; AppProfile `nginx.ingress.kubernetes.io/*`
annotation keys are bridged to equivalent Envoy policy).

| Check | Action |
|---|---|
| Portal URL | Users must use `portal.${KERNEL_DOMAIN}` — **not** `portal.${TENANT_DOMAIN}` (404 on multi-tenant). |
| Profile `ingress.annotations` | **Never** add `X-Frame-Options`, `frame-ancestors`, or `Content-Security-Policy` — the operator owns this. Legacy per-tenant portal origins (`portal.${TENANT_DOMAIN}`) are stripped on reconcile. |
| `linkTarget` | `embedded` and `newwindow` both load inside gentian-ui; CSP must still allow the kernel portal. Default `newwindow` is fine. |
| Operator version | Reconcile the tenant after upgrading gentian-os so HTTPRoute policies are updated. |

### 6b. Double CSP headers (Element and similar)

Some charts (notably **Element** / opendesk-element-web nginx) already send:

```http
Content-Security-Policy: frame-ancestors 'self'
```

If ingress **appends** a second header with the portal origin, the browser
enforces **both** policies — `'self'` still blocks embedding from
`portal.${KERNEL_DOMAIN}`. Symptom: portal tile opens but the iframe is blank
with the Firefox message above; `curl -sI` shows **two** `content-security-policy`
lines.

The operator **replaces** upstream CSP for standard AppProfile routes by clearing
upstream `X-Frame-Options` and `Content-Security-Policy`, then setting a single:

```http
Content-Security-Policy: frame-ancestors 'self' https://portal.<kernel-domain>
```

**Exception — CryptPad** (`pad` / `pad-sandbox` kernel HTTPRoutes only): the
operator **appends** a second CSP header so upstream `script-src` (no
`'unsafe-eval'`) stays intact. Do not copy CryptPad's append-only pattern into
AppProfiles.

### 6c. AppProfile checklist (all profiles)

These profiles rely on the operator and need **no** CSP annotations:

- `app-store`, `element`, `openproject`, `ox-appsuite`, `xwiki`

Add only non-CSP `ingress.annotations` your chart needs (proxy timeouts, body size —
bridged to Envoy `BackendTrafficPolicy`):

```yaml
ingress:
  subDomain: chat
  annotations:
    nginx.ingress.kubernetes.io/proxy-body-size: "100M"
    # NO frame-ancestors / X-Frame-Options / Content-Security-Policy here
```

**No other app-level CORS setup is required** for normal same-origin app UIs.
TLS and `browserProxy` bearer forwarding are platform-managed (§5d–5e).

**Force edge route reconcile:** after an operator upgrade, bump the tenant to refresh
route policy (the `gentianos.io/reconcile` timestamp annotation alone does
not change `spec` — patch any field or delete the app HTTPRoute and let the operator
recreate it):

```bash
kubectl delete httproute -n tenant-demo httproute-demo-element
# operator recreates on next tenant reconcile (~seconds)
```

### 6d. Element SSO — OIDC redirect URI host

Element Web is served at `chat.<tenant-domain>` but the Matrix homeserver (Synapse)
and OIDC callback live at **`matrix.<tenant-domain>`** (synapse-web Service).
The `element` AppProfile declares `additionalIngresses` for `matrix` →
`synapse-web:8008`; the operator creates the HTTPRoute. The synapse-web Helm release
has chart ingress disabled to avoid duplicate routes.

Keycloak `redirectUris` must target the homeserver host:

```yaml
kernelRequirements:
  identity:
    oidc:
      redirectUris:
        - "https://matrix.${TENANT_DOMAIN}/_synapse/client/oidc/callback"
```

Using `chat.${TENANT_DOMAIN}` causes OIDC to fail after Keycloak login; Element
shows **“Invalid username or password”** even though credentials are correct.
Reconcile the tenant / identity jobs after fixing the AppProfile so the Keycloak
client `opendesk-synapse` picks up the new redirect URI.

On **ACME staging** clusters, the same message after the matrix host routes
correctly usually means Synapse failed the **token/userinfo exchange** (Twisted
HTTPS to `id.<kernel>` on the hairpin path). The `app-element` composition
points server-side OIDC endpoints at in-cluster Keycloak (`KEYCLOAK_INTERNAL_URL`
in `gentian-kernel-services`); confirm the Element XApp reconciled after the
operator upgrade.

**Matrix localpart:** use `matrixIdLocalpart: "opendesk_username"` (LDAP `uid`) and
request scope `opendesk-matrix-scope`. Do not use `preferred_username` — kernel-broker
tokens may carry `mailPrimaryAddress` there, which is not a valid Matrix localpart.

**Kernel IdP broker (tenant realm):** after portal login, Element/XWiki hit
`/realms/${TENANT_ID}/broker/kernel/endpoint`. A **502** on that URL (Synapse
`mapping_error`, empty localpart, or Firefox framing on a Cloudflare error page) is
usually **operator/IAM**, not AppProfile YAML: broker token exchange must use the
**in-cluster** Keycloak URL (not `https://id.${KERNEL_DOMAIN}` from inside the cluster),
and tenant-realm IdP mappers must import `opendesk_username` from the broker token
(LDAP `uid`). Confirm `keycloak-broker-idp-${TENANT_ID}` and OIDC pack jobs completed.
See `gentian-os/docs/design/iam.md`.

**Loading screen / `net.nordeck.element_web.module.opendesk` error:** the
`opendesk-element-web` image bundles the Nordeck OpenDesk module; `additionalConfiguration`
must include its `banner` URLs (`portal_url`, `ics_*`, `portal_logo_svg_url`) and
`custom_css_variables` — see `profiles/element.yaml`.

**Loading screen flicker / white page after SSO succeeds:** Matrix login can work
(Synapse logs show `POST /_matrix/client/v3/login` 200) while the Nordeck banner still
loops on ICS silent login. This is **kernel intercom (Pattern A)**, not tenant
Crossplane — Element's Nordeck config points at `https://ics.${KERNEL_DOMAIN}`.

**Loading screen flicker during SSO (Synapse `invalid_scope`):** tenant Crossplane.
The manifest-bridge OIDC pack Job creates `opendesk-matrix-scope`, but
provider-keycloak `Client` reconciliation can strip it from `opendesk-synapse`.
`app-element` emits matching `ClientDefaultScopes` MRs and sequences them before
Synapse/Element Helm releases. Symptom: Synapse logs
`Received OIDC callback with error: invalid_scope Invalid scopes: openid opendesk-matrix-scope`
and Element reloads in a tight loop. Verify:
`kubectl get clientdefaultscopes | grep element-keycloak-default-scopes`.

Common causes:

1. **Wrong ICS `BASE_URL` on the intercom pod** — with `ROUTING_MODE=gateway`, chart
   ingress is disabled and the Helm Secret defaults to `http://intercom-service-<env>:8008`.
   `kernel/services/intercom-service/values/gateway.yaml` must set `extraEnvVars`
   (`BASE_URL`, `INTERCOM_URL`, `NODE_EXTRA_CA_CERTS`) so they override `envFrom`.
   Argo CD `valuesFrom` on `intercom-gateway-values` alone is not reliable; re-sync
   `intercom-service-dev` after install/update. Symptom: ICS `/silent` HTTP 500 and logs
   `Issuer.discover() failed … unable to get local issuer certificate` when
   `NODE_EXTRA_CA_CERTS` is unset on the pod.

2. **Intercom cannot reach Redis** — ICS stores OIDC sessions in Redis. If intercom logs
   `Redis error: getaddrinfo ENOTFOUND redis-*`, fix the Redis host (use
   `redis-<env>-master.gentian-infra-<env>.svc.cluster.local`, not headless) and restart
   intercom after Redis is healthy:
   `kubectl rollout restart deployment/intercom-service-dev -n gentian-dev`.
   `install.sh` / `update.sh` run `verify_intercom_ics` to catch this.

3. **Stale ICS session cookies** — after Redis/BASE_URL fixes, intercom may still log
   `Error verifying ICS OIDC access_token` + `Silent login, logged in false` in a tight
   loop while Element's Nordeck banner flickers. The browser is retrying
   `https://ics.<kernel>/navigation.json` with an invalid ICS session cookie from an
   earlier broken deploy. **Clear site data for `ics.<kernel>`** (Firefox: Storage tab →
   delete all cookies for that host), reload the portal, then reopen Element.

4. **Silent login blocked in nested iframes** — Nordeck loads `ics_silent_url` inside
   `chat.<tenant>` inside the portal WinBox. If step 3 did not help, Firefox (and other
   browsers with strict third-party cookie rules) may not send the Keycloak kernel session
   cookie to `id.<kernel>` inside that hidden iframe (`login_required` / silent login
   false) even though portal login works. **Workaround:** Ctrl/Cmd+click the Element tile
   to open Chat in a top-level tab (gentian-ui `linkTarget: embedded` override).

**Wrong user after switching portal accounts:** portal login uses the **kernel** realm;
Element/Synapse OIDC uses the **tenant** realm (`demo`, …). A previous user's tenant-realm
SSO cookie or cached Matrix session in the browser can reopen Chat as the wrong person.
The Element AppProfile sets `logout_redirect_url`; gentian-ui app tiles pass `login_hint`
and `prompt=login` (and `#/logout` on `chat.*`) when opening SSO apps from the portal.

### 6e. IdP login inside a portal-embedded app (Keycloak `frame-ancestors`)

Portal tiles load tenant apps in an iframe (`portal.<kernel>` → `chat.<tenant>.<kernel>`).
OIDC SSO then loads **`id.<kernel>` inside the app iframe** (or a nested iframe such
as Nordeck ICS silent login on `ics.<kernel>`). Firefox blocks with
*“id… will not allow … if another site has embedded it”* when Keycloak's CSP only
allows `https://portal.<kernel>` — the **immediate parent** is the app origin, not
the portal.

CSP `host-source` allows at most one `*.` label. `https://*.<kernel>` does **not**
match `chat.demo.<kernel>`; each tenant needs **`https://*.<tenant-effective-domain>`**
(e.g. `https://*.demo.desk.gentian.org`).

| Layer | Who sets CSP | Must allow |
|---|---|---|
| App HTTPRoute (`chat`, `wiki`, …) | gentian-os operator | `https://portal.<kernel>` (§6a–6b) |
| IdP HTTPRoute (`id.<kernel>`) | gentian-os `KeycloakPlatformReconciler` (HTTPRoute patch + realm `X-Frame-Options` jobs) | `https://portal.<kernel>`, `https://*.<kernel>`, `https://*.<tenant-effective-domain>`, **and** explicit `https://{ingress.subDomain}.<tenant-effective-domain>` for every **installed OIDC AppProfile** (discovered automatically — no manual subdomain list) |

**Do not maintain a static IdP allowlist in AppProfiles or Nubus values.** When you add
a new OIDC app, declare `kernelRequirements.identity.oidc` and `ingress.subDomain`;
the operator adds the app origin to `id.<kernel>` on the next tenant or AppProfile
reconcile. `install.sh` step 16a verifies the IdP HTTPRoute converged.

Helm values provide the install baseline; the operator patches the Keycloak proxy
ingress on every tenant reconcile when tenants are added or removed. The operator
also clears Keycloak **`X-Frame-Options: SAMEORIGIN`** on kernel and tenant realms
(broker `/endpoint` callbacks fail in iframes even when `frame-ancestors` is correct).
After changing nubus values in Git, sync the nubus manifests app so Crossplane
reapplies the release. Verify:

```bash
curl -sI https://id.${KERNEL_DOMAIN}/ | grep -i content-security
# expect: frame-ancestors 'self' https://portal.<kernel> https://*.demo.<kernel> …
```

### 6f. Kernel diagram service (CryptPad)

Diagram editing from Nextcloud Files uses a **shared CryptPad kernel service**
(like Collabora in §9b of `gentian-os/docs/architecture.md`), not a per-tenant
AppProfile. One instance at `pad.<kernel_domain>` plus
`pad-sandbox.<kernel_domain>` for the crypto sandbox origin serves all tenants;
Nextcloud embeds it from `files.<kernel_domain>`.

There is **no portal tile** and **no tenant HTTPRoute** — manifests live under
`gentian-os/kernel/services/cryptpad/`. CSP `frame-ancestors` on the kernel
HTTPRoutes is computed centrally in the operator (`cryptpadSandboxFrameAncestorOrigins`):
**pad** + **portal** + **files** on `pad-sandbox`, **files** + **portal** on `pad`.
Do not duplicate CSP in AppProfile annotations.

### 6g. Nextcloud (App Store)

Nextcloud is an **App Store app** (`profiles/nextcloud/profile.yaml`), not a kernel
service. Each tenant gets a dedicated instance at `cloud.<tenant_domain>` with an
optional Collabora subchart at `collabora.<tenant_domain>`.

**Gateway policy (declared on the profile, not in gentian-os):** the Collabora
`additionalIngresses` entry sets `gentianos.io/gateway-frame-ancestors` so the
editor allows embedding from the main `cloud.<tenant>` host (see Gateway
annotations table). It sets `gentianos.io/gateway-escaped-slashes-action:
KeepUnchanged` so Envoy forwards `/cool/...` WOPI WebSocket paths without
`path_normalization_failed`.

```yaml
additionalIngresses:
  - subDomain: collabora
    serviceName: nextcloud-collabora
    servicePort: 9980
    annotations:
      gentianos.io/gateway-frame-ancestors: |
        {"mode":"replace","origins":["mainApp","portal"]}
      gentianos.io/gateway-escaped-slashes-action: KeepUnchanged
```

OIDC uses the tenant realm (`${TENANT_ID}`) with client ID `gentian-nextcloud` and
the `gentian-nextcloud-scope` pack from the OIDC catalog. Portal SSO follows the
same tenant-realm + kernel IdP broker path as Element and other installed apps.

Use the **replace** CSP pattern from §6b so `portal.<kernel_domain>` can embed the
Files tile (`linkTarget: embedded`).

The licensed OpenDesk Nextcloud stack is **not** part of gentian-os or gentian-apps;
customers who need it install it from the proprietary catalogue separately.

### 6h. App administrators (`app-admins` → in-app privileged role)

Cross-app **in-app administrators** (Nextcloud `admin` group, future Matrix
room admins, etc.) are **not** tenant IT admins (`gentian:tenant:<t>:admins`) and
are **not** the same as portal tile entitlements (`gentian:tenant:<t>:app:<profile>`).

| Group / field | Purpose |
|---|---|
| `gentian:tenant:<t>:app-admins` | Workspace members who should receive the **privileged in-app role** in every installed app that declares one |
| `gentian:tenant:<t>:app:<profile>` | Portal tile + OIDC entitlement only |
| `spec.provisioning.privilegedRole` on `AppProfile` | Maps `app-admins` members to the app's native admin construct |

**Operator flow** (`gentian-os` tenant reconciler):

1. Bootstrap `gentian:tenant:<t>:app-admins` in Keycloak with other Gentian groups.
2. After apps are ready, list `app-admins` members and reconcile into each
   installed profile that sets `spec.provisioning.privilegedRole`.
3. Requeue periodically (5m) and **immediately** when the Admin Console patches
   `gentianos.io/app-privilege-requested-at` on the `Tenant` CR (membership change).

**Admin Console:** tenant admins assign members to **App administrator** on the
Members tab (maps to `app-admins`). This does **not** grant portal tiles — assign
`app:<profile>` entitlements separately when needed.

**AppProfile example** (per-tenant Nextcloud catalogue entry):

```yaml
spec:
  provisioning:
    privilegedRole:
      kind: group          # only "group" is supported today
      name: admin          # Nextcloud group id
```

Supported provisioners today: **`nextcloud`** (OCS API against the tenant release
at `http://nextcloud.tenant-<t>.svc.cluster.local`). Other profiles may declare
the field; the operator reports `not implemented` until a provisioner is added.

**User id mapping:** reconcilers prefer Keycloak attribute `opendesk_username`,
then email local-part (same as the Nextcloud portal bridge).

**Checklist:**

- [ ] Declare `spec.provisioning.privilegedRole` when the app has a distinct admin group/role
- [ ] Do **not** conflate `app-admins` with `app:<profile>` unless product policy explicitly requires both
- [ ] Ensure OIDC users exist in the app (bridge or provisioner creates accounts before admin grant)

---

## 7. Global domain and hosts

Many Bitnami-family and opendesk charts read `global.domain` and `global.hosts`
to build their internal URLs. If these are missing, charts fall back to
`example.com` defaults, which breaks inter-service communication.

When the chart lists `keycloak` under `global.hosts`, **`global.domain` must be
`${KERNEL_DOMAIN}`** so Keycloak resolves to the central IdP (see §2). Prefix
tenant app labels with `${TENANT_ID}`; keep user-facing redirect URIs on
`${TENANT_DOMAIN}`:

```yaml
extraValues:
  global:
    domain: "${KERNEL_DOMAIN}"
    hosts:
      openproject: "projects.${TENANT_ID}"  # → projects.demo.desk.gentian.org
      keycloak: "id"                        # → id.desk.gentian.org
      nubus: "portal"                       # → portal.desk.gentian.org
```

### 7b. Jitsi + Element (video in Matrix rooms)

Jitsi is bundled as an **Element sidecar** (similar to how CryptPad is wired from
Nextcloud in openDesk — one install, not a separate tenant app). Installing
`element` on a tenant deploys Jitsi at `meet.<tenant>` for Element room widgets
and portal realtime links.

1. Install only `element` on the tenant (`spec.apps`). Do **not** add a separate
   `jitsi` profile — there is no standalone Jitsi AppProfile in the catalogue.
2. The `element` AppProfile declares `spec.sidecars` with the `opendesk-jitsi`
   chart, OIDC client `opendesk-jitsi`, and `additionalIngresses` for
   `meet.<tenant>` → `jitsi-web`.
3. The `app-element` composition deploys **Matrix User Verification Service**
   (UVS bootstrap Job + service) and the Jitsi sidecar release. Prosody uses
   `AUTH_TYPE=hybrid_matrix_token`, `JWT_APP_SECRET` (same value as
   `settings.jwtAppSecret` / keycloak adapter), and
   `MATRIX_UVS_URL=http://opendesk-matrix-user-verification-service.${TENANT_NAMESPACE}.svc.cluster.local`.
4. Set `global.hosts.jitsi: "meet.${TENANT_ID}"` in Element `extraValues` (with
   `global.domain: "${KERNEL_DOMAIN}"`) so Element's bundled `jitsi.html`
   widget targets `https://meet.${TENANT_DOMAIN}`.
5. Configure shared TURN in `gentian-deployments` → `kernelServices.turn*` on the
   gentian-os Helm chart; compositions substitute `${TURN_*}` into Element Synapse
   and Jitsi Prosody env vars.
6. **UVS bootstrap** uses `opendesk-synapse-create-account`, which logs in as `@uvs`
   with a local Matrix password after `register_new_matrix_user`. Do **not** set
   `password_config.enabled: false` on Synapse — that breaks the bootstrap Job
   (`Password login has been disabled`) and leaves the Element XApp Not Ready.
   Human users still use OIDC: `app-element` sets `sso_redirect_options.immediate`
   on the Element web `config.json` only.
7. **Retry after a bootstrap failure:** the chart hook runs at post-install only.
   After Synapse password auth is restored, delete the failed Job and let Crossplane
   retry the bootstrap `Release` (or delete `opendesk-matrix-user-verification-service-bootstrap`
   and re-sync the Element `App` claim):

   ```bash
   kubectl delete job -n tenant-demo opendesk-matrix-user-verification-service-bootstrap --ignore-not-found
   ```

   **Stale `@uvs` user (reinstall):** if bootstrap logs loop on
   `Invalid username or password`, the Matrix `@uvs` service account from a prior
   Element install still exists in Postgres with an old password while OpenBao holds
   the current derived secret. Remove the user, delete the bootstrap Job, then retry
   install (or re-sync the Element `App`):

   ```bash
   kubectl exec -n platform-kernel postgres-1 -c postgres -- \
     psql -U postgres -d demo_element \
     -c "DELETE FROM demo_element.users WHERE name = '@uvs:demo.desk.gentian.org';"
   kubectl delete job -n tenant-demo opendesk-matrix-user-verification-service-bootstrap --ignore-not-found
   ```

   Replace `demo_element` / `@uvs:demo.desk.gentian.org` with the tenant DB name and
   Synapse `server_name` for your tenant.

   If bootstrap logs show `profiles_user_id_key` duplicate but `users` has no `@uvs`
   row, also run `DELETE FROM demo_element.profiles WHERE user_id = 'uvs';` then
   delete the bootstrap Job and re-sync (or delete `element-*-uvs-bootstrap-release`).

Sidecar OIDC clients and internal secrets use the synthetic app key
`element-jitsi` in OpenBao and Keycloak jobs (`SidecarAppName` in the API).

---

## 8. OIDC client spec

Gentian supports two OIDC integration paths. Choose based on whether the app
needs only standard SSO or openDesk-style custom scopes and protocol mappers.

| Path | Use when | gentian-apps | gentian-os |
|---|---|---|---|
| **A — composition Client MR** | Standard SSO (client id, redirects, confidential secret) | `kernelRequirements.identity.oidc` only | `app-default` (or profile composition) emits Keycloak `Client` + default scopes |
| **B — OIDC pack** | Custom client scope, protocol mappers, LDAP group → Keycloak client role | `profiles/<app>/oidc-catalog.yaml` | Operator `ResolvePack` provisioning Jobs |

**Path A (most new apps, including Odoo):** declare `clientId`, `redirectUris`,
and `accessType` in the profile. Do **not** add the client to `OIDCPackCatalog`.

**Path B (openDesk supplier charts):** keep the historical `opendesk-*` `clientId`
and add or extend the matching pack in `OIDCPackCatalog`. Optional
`oidcPackRef` when the pack key differs from `clientId`. Pack scopes and
`fullScopeAllowed` are read from the cluster catalog by compositions — no
per-`clientId` dicts in composition YAML.

Use the full `OIDCClientSpec` struct. The old `oidc: true` shorthand is removed:

```yaml
kernelRequirements:
  identity:
    oidc:
      clientId: "opendesk-openproject"
      name: "OpenProject"
      accessType: CONFIDENTIAL   # or PUBLIC for browser-only apps (e.g. Jitsi)
      redirectUris:
        - "https://projects.${TENANT_DOMAIN}/auth/keycloak/callback"
      postLogoutRedirectUris:
        - "https://projects.${TENANT_DOMAIN}/"
      backchannelLogoutUrl: "https://projects.${TENANT_DOMAIN}/auth/keycloak/backchannel-logout"
```

**`PUBLIC` vs `CONFIDENTIAL`:**
- `CONFIDENTIAL` — server-side apps that can keep a client secret (OpenProject,
  OX App Suite, Element). Requires `valueMapping.oidc.clientSecretKey`.
- `PUBLIC` — browser-only or native apps where a secret cannot be protected
  (Jitsi). No `clientSecretKey` needed.

**Per-tenant realm:** All OIDC/LDAP URLs must use `${TENANT_ID}` as the Keycloak
realm name. Never hardcode `souvap`, `opendesk`, or any literal realm name.

**Central IdP host:** Issuer, authorization, token, JWKS, and logout endpoints
must use `https://id.${KERNEL_DOMAIN}/realms/${TENANT_ID}` (or path-only auth
URLs resolved against `openproject.oidc.host: "id.${KERNEL_DOMAIN}"`). See §2.

### 8a. openDesk supplier charts on Gentian — integration boundary

Many AppProfiles wrap **openDesk Helm charts** (XWiki, Element, OX, OpenProject, …).
Gentian still runs the **Nubus/UCS stack** for LDAP, UDM, portal tiles, and
openDesk directory attributes — but **authentication topology is not identical**
to upstream openDesk. Copy chart *data* (LDAP attribute names, OIDC client IDs,
flavors, themes, MBA groups); do **not** copy every auth-related value verbatim.

| Area | Upstream openDesk | Gentian AppProfile |
|---|---|---|
| Keycloak realm | Single `opendesk` realm | **Per-tenant** realm `${TENANT_ID}`; humans log in at **kernel** realm on the portal |
| IdP hostname | `id.<domain>` on app domain | Always `id.${KERNEL_DOMAIN}` (§2) |
| Portal → app SSO | Often `keycloak-bridge-auth` (Nubus session bridge) | **Direct OIDC** to tenant realm + kernel IdP broker (operator-managed) |
| Nextcloud Files | Same `opendesk` realm as portal | **Kernel realm only** — not tenant broker; claim `opendesk_useruuid` (`entryUUID`) — see §6g |
| LDAP bind DN | Global `uid=ldapsearch_<app>,cn=users,…` | Per-tenant `uid=app-<app>-${TENANT_ID},ou=${TENANT_ID},…` (operator-provisioned) |
| `global.domain` + `hosts.keycloak` | Same realm/host for portal and apps | `global.domain: "${KERNEL_DOMAIN}"`, tenant app hosts prefixed with `${TENANT_ID}` |

**Keep from openDesk profiles:** `kernelRequirements.identity.oidc.clientId` values
that match an entry in the cluster `OIDCPackCatalog` (`opendesk-xwiki`,
`opendesk-matrix-scope`, …), LDAP group mappings, UI themes, chart versions,
`workplaceServices.*` pointing at `portal.${KERNEL_DOMAIN}` where the chart
expects Nubus navigation.

**Do not copy into Gentian profiles:**

| Upstream setting | Why |
|---|---|
| `keycloak-bridge-auth` (`XWiki.AuthService.Configuration.authService`) | openDesk Nubus bridge assumes portal and app share one Keycloak realm/session. Gentian uses split realms; this property **overrides** `OIDCAuthServiceImpl` and users see the **native login form** instead of Keycloak redirect. |
| Hardcoded realm `opendesk` / `souvap` in `oidc.provider` or `OIDCIssuer` | Wrong realm; use `id.${KERNEL_DOMAIN}/realms/${TENANT_ID}`. |
| `portalTiles.linkTarget: newwindow` on OIDC apps that support iframes | Opens a new tab on normal click; use **`embedded`** so gentian-ui WinBox behaviour matches other portal apps (§6a). Reserve `newwindow` for iframe blockers (OX App Suite). |

**XWiki pattern (reference):** set `xwiki.authentication.authclass` to
`org.xwiki.contrib.oidc.auth.OIDCAuthServiceImpl` in `customConfigs`, configure
`oidc.provider` / `oidc.clientid` / LDAP import blocks with Gentian placeholders,
and **omit** `keycloak-bridge-auth`. See `profiles/xwiki.yaml`.

**OIDC token claims:** if the chart maps local users from an openDesk-specific
claim (e.g. XWiki `oidc.user.opendesk_username`), declare the matching
`clientId` in `kernelRequirements.identity.oidc` so the operator applies the
openDesk OIDC pack (protocol mappers, LDAP `uid` → claim). Profile authors
define the client; **mapper wiring is operator/IAM**, not `extraValues`.

**Operator-owned (do not hand-craft in AppProfiles):** tenant-realm browser flow
(auto-redirect to kernel IdP), first-broker-login auto-link by email, IdP HTTPRoute
`frame-ancestors` for installed OIDC apps, portal/app HTTPRoute CSP, staging CA /
JVM truststore for Java charts on ACME staging. See `gentian-os/docs/design/iam.md`.

**Custom (non-openDesk) apps:** use generic `kernelRequirements.identity.oidc` and
LDAP placeholders only — do not reuse openDesk-only mechanisms (`keycloak-bridge-auth`,
`opendesk-*` scope names, MBA attribute names) unless you intentionally integrate
with the openDesk directory model.

### 8b. SSO smoke-test after publishing a profile

1. Log in at **`https://portal.${KERNEL_DOMAIN}`** (kernel realm).
2. Click the app tile (normal click, not Ctrl) — should open in **WinBox** if
   `linkTarget: embedded`.
3. Expect redirect to **`https://id.${KERNEL_DOMAIN}/realms/${TENANT_ID}/…`**, not
   a native app login form.
4. After login, the app UI loads; OIDC callback URL must stay on
   **`https://<subDomain>.${TENANT_DOMAIN}/…`**.

**Install command readiness:** `gtnctl apps install <app> --tenant <tenant>` commits
to GitOps, applies the Tenant CR, then **blocks until the Crossplane App claim is
Ready** (default timeout 15 minutes). It exits non-zero if init Jobs fail (for
example `openproject-s3-init`, `openproject-oidc-seed`) or the Helm release does
not converge. Do not treat a successful Git push as “installed” — wait for the
CLI to report Ready or inspect `kubectl get app <app> -n tenant-<tenant>`.

| Symptom | Likely profile issue |
|---|---|
| Native username/password form (XWiki, etc.) | `keycloak-bridge-auth` or missing `OIDCAuthServiceImpl` / `oidc.skipped: false` |
| `redirect_uri` mismatch | `redirectUris` use wrong host (`chat.` vs `matrix.` for Element — §6d) or `${KERNEL_DOMAIN}` instead of `${TENANT_DOMAIN}` |
| Element **“Invalid username or password”** after matrix host works | Wrong OIDC redirect URI (§6d), missing `opendesk_username` / Livecollaboration role (IAM), or Synapse token exchange still hitting public `id.<kernel>` on staging — operator `KEYCLOAK_INTERNAL_URL` + `app-element` reconcile (§6d, `security.md` §9.1) |
| Blank iframe / Firefox framing error | Missing IdP `frame-ancestors` — ensure `ingress.subDomain` + OIDC client declared; operator reconciles (§6e). **First** verify edge headers with `curl -sI https://<subDomain>.<tenant-domain>/ | grep -i content-security-policy` — a single `frame-ancestors 'self' https://portal.<kernel>` line means CSP is fine and the failure is elsewhere (often OIDC — next row). |
| OpenProject login 404 on `/auth/keycloak` | OIDC auth provider not seeded — `openproject-oidc-seed` Job failed or ran before DB migrations. Not a CSP issue; fix the Job (see §6f). Portal iframe may look like a framing/CORS error when SSO never starts. |
| HTTP 500 on OIDC callback (empty username claim) | Chart expects `opendesk_username` (or similar) but `clientId` not in openDesk pack / wrong mapper — fix `clientId`, not chart templates |
| Element **“Account already exists”** (`john-doe@…` on OIDC login) | **Element / Synapse reinstall drift** — Postgres retains Matrix users across app uninstall (`databasePerTenant` + `deletionPolicy: Retain`). **Prevention:** default `gtnctl apps uninstall element --tenant <tenant>` scrubs Matrix identities; **`--purge` / `-f`** drops the Postgres database (full chat/room wipe). Example: `gtnctl apps uninstall element --tenant demo --purge`. See §7b for `@uvs` bootstrap edge cases. |
| Stale app data after uninstall/reinstall (any app) | Kernel resources (Postgres/MariaDB, S3, Redis ACL, OpenBao secrets) survive app uninstall by design. **`gtnctl apps uninstall <app> --tenant <tenant> --purge`** (or `-f`) removes all app-owned persistent state so the next install starts clean. Applies to all catalogue apps (OpenProject, OX, XWiki, etc.) per `AppProfile.spec.kernelRequirements`. |
| “Account already exists” / email already exists on OIDC login (**OpenProject**) | LDAP `SYNC__USERS` pre-created the user with `ldap_auth_source_id` set (OpenProject 16.x; older releases used `auth_source_id`) — OpenProject cannot remap LDAP users to OIDC (OP-7253). Keep `OPENPROJECT_SEED_LDAP_*_SYNC__USERS: "false"`; OIDC creates users on first login, LDAP group sync only links existing users. **Remediation** (one-off `rails runner` in `openproject-web`): `User.where.not(ldap_auth_source_id: nil).update_all(ldap_auth_source_id: nil)` to unlink LDAP; or `User.find_by(mail: "<email>")&.destroy` if the account has no data to keep; then OIDC login recreates the user. Do **not** use `auth_source_id` (removed in 16.x) or `LdapAuthSource.update_all(sync_users: …)` (column removed in 16.x) |
| 502 on `/realms/<tenant>/broker/kernel/endpoint` | Broker token/JWKS fetch or oversized headers — operator Keycloak HTTPRoute / internal `tokenUrl`; not AppProfile (§6d) |
| Element works; Nextcloud “Failed to provision the user” | **Different SSO path** — kernel OIDC + stale NC `entryUUID` after purge; see §6g (not tenant OIDC pack) |
| “Unexpected error” from identity provider | Usually stale broker links after IAM flow changes — operator purge/re-link; not an AppProfile field |

---

## 9. Secret rotation — Reloader annotation

Add the Stakater Reloader annotation so pods restart automatically when the
`ExternalSecret` refreshes (e.g. after credential rotation):

```yaml
extraValues:
  podAnnotations:
    reloader.stakater.com/auto: "true"
```

---

## 10. Catalogue bundles (GitOps)

Each app lives under `profiles/<name>/` with a `kustomization.yaml`. Argo CD
ApplicationSet **`gentian-catalogue`** syncs one Application per bundle
(`catalogue-<name>`): AppProfile, optional `composition.yaml`, optional cluster
assets. See [profiles/CATALOGUE.md](profiles/CATALOGUE.md).

Set `compositionRef` only when using a non-default composition:

| Composition | When to use |
|---|---|
| *(omit)* | Standard apps — `app-default` is used automatically |
| `app-od-element` | Element (OpenDesk) — bundle in **gentian-pro** (`app-od-element` composition) |
| `app-od-ox` | OX App Suite — bundle in **gentian-pro** |
| `app-od-openproject` | OpenProject — bundle in **gentian-pro** |

---

## 11. Image pull secrets

Charts pulling from private registries (e.g. `registry.opencode.de`) need:

```yaml
extraValues:
  global:
    imagePullSecrets:
      - name: registry-credentials
```

The `registry-credentials` secret is provisioned in every tenant namespace by
the namespace bootstrap step.

---

## 12. Checklist for a new AppProfile

Before opening a PR, verify:

- [ ] `deploymentMethod: crossplane`
- [ ] `subDomain` is camelCase
- [ ] No hardcoded cluster addresses — all use `${...}` placeholders
- [ ] All five database fields mapped in `valueMapping.database`
- [ ] Chart-managed ingress disabled (`ingress.enabled: false` in `extraValues`)
- [ ] `fullnameOverride` set to match `spec.ingress.serviceName`
- [ ] `global.domain` and `global.hosts` set in `extraValues`
- [ ] If `global.hosts.keycloak` is present: `global.domain` is `${KERNEL_DOMAIN}`, tenant app hosts use `${TENANT_ID}` prefix
- [ ] All IdP URLs use `id.${KERNEL_DOMAIN}/realms/${TENANT_ID}`; redirect URIs use `${TENANT_DOMAIN}`
- [ ] Element: OIDC redirect is `https://matrix.${TENANT_DOMAIN}/_synapse/client/oidc/callback` (not `chat.`)
- [ ] Element: `additionalIngresses` includes `matrix` → `synapse-web:8008` (required) — §6d
- [ ] Element: `matrixIdLocalpart: "opendesk_username"` (not `preferred_username`) — §6d
- [ ] After tenant purge/redeploy: if Files login fails, check NC `entryUUID` drift (§6g) — not an AppProfile fix
- [ ] App admins: `spec.provisioning.privilegedRole` when the app exposes a native admin group (§6h)
- [ ] App admins: assign humans via `gentian:tenant:<t>:app-admins`, not per-app manual grants
- [ ] OIDC uses full `OIDCClientSpec`, realm is `${TENANT_ID}`
- [ ] openDesk charts: no `keycloak-bridge-auth`; OIDC via tenant realm + `id.${KERNEL_DOMAIN}` (§8a)
- [ ] openDesk charts: per-tenant LDAP bind / realm placeholders, not upstream `opendesk` realm or global bind DN
- [ ] OIDC apps in portal: `portalTiles.linkTarget: embedded` unless the app blocks iframes (§6a, §8a)
- [ ] `clientId` matches an openDesk OIDC pack when the chart depends on openDesk-specific claims/scopes
- [ ] Secrets only in `valueMapping` / `appSecrets`, never in `extraValues`
- [ ] `reloader.stakater.com/auto: "true"` in `podAnnotations`
- [ ] (automatic) Operator injects portal `frame-ancestors` on app HTTPRoutes — no CSP annotations in profile
- [ ] `ingress.annotations` contains no `frame-ancestors`, `X-Frame-Options`, or `Content-Security-Policy`
- [ ] (CryptPad / multi-host) `additionalIngresses` use flat subdomains; no per-host CSP in annotations — operator sets `pad-sandbox` policy
- [ ] `spec.browserProxy` declared if the shell calls this app's REST API
- [ ] `compositionRef` omitted unless using a non-default composition
- [ ] YAML passes `python3 -c "import yaml; yaml.safe_load(open('<file>'))"` locally
