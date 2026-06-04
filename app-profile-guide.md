# AppProfile Authoring Guide

This guide captures the accumulated learnings and best practices from the existing
AppProfile implementations. Read it before writing a new profile — every section
corresponds to a class of bug that was caught in git history.

---

## 1. Mandatory top-level fields

```yaml
apiVersion: gentianos.io/v1alpha1
kind: AppProfile
metadata:
  name: <app-id>                        # lowercase, kebab-case
  labels:
    gentianos.io/profile-name: <app-id> # must match metadata.name
spec:
  deploymentMethod: crossplane          # ALWAYS crossplane — never tofu-controller
```

---

## 2. Placeholders (operator-substituted at deploy time)

The operator substitutes these tokens before rendering the Helm release. Use them
everywhere — never hardcode cluster-specific addresses.

| Placeholder | Resolves to |
|---|---|
| `${TENANT_DOMAIN}` | The tenant's root domain (e.g. `desk.example.com`) |
| `${TENANT_ID}` | The tenant identifier / Keycloak realm name (e.g. `gtn-demo`) |
| `${TENANT_NAMESPACE}` | The Kubernetes namespace for the tenant |
| `${LDAP_HOST}` | UCS LDAP service hostname |
| `${LDAP_BASE_DN}` | LDAP base DN (e.g. `dc=example,dc=com`) |
| `${LDAP_BIND_DN}` | App-specific LDAP bind DN |
| `${SMTP_HOST}` | Postfix service address |
| `${S3_ENDPOINT}` | MinIO API endpoint URL |

**Common mistake:** Using a hardcoded cluster-internal address like
`nubus-dev-ldap-server.gentian-dev.svc.cluster.local` instead of `${LDAP_HOST}`.
That value only works in one cluster and breaks on every other environment.

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

## 5. Ingress, TLS and CORS

### 5a. How TLS is provisioned

Setting `spec.ingress` (with `tlsEnabled: true`, the default) tells the
gentian-os controller to create two resources per tenant deployment:

1. A Kubernetes `Ingress` at `{subDomain}.{tenantDomain}` → `Service:{servicePort}`.
2. A cert-manager `Certificate` CR targeting the `clusterIssuer` you specify.

cert-manager's **HTTP-01 solver** satisfies the ACME challenge through NGINX
and stores the issued cert in the tenant namespace. No manual certificate work
is needed. The default issuer `letsencrypt-http01` is correct for all
per-tenant vanity-domain apps.

```yaml
ingress:
  subDomain: "projects"        # → projects.{tenantDomain}
  serviceName: "openproject"   # must match the Kubernetes Service name
  servicePort: 8080
  ingressClassName: "nginx"
  tlsEnabled: true             # default — omit to accept the default
  clusterIssuer: "letsencrypt-http01"   # default — omit to accept the default
```

**`subDomain` capitalization matters.** The field is validated; `subdomain`
(lowercase) is silently ignored, leaving the app with no ingress.

### 5b. Always disable chart-managed ingress

Every chart that ships its own `Ingress` resource must have it disabled,
otherwise two `Ingress` objects collide on the same host:

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

- Apps are loaded in **iframes**, all under `*.{tenantDomain}`. Iframes do not
  trigger CORS preflight requests.
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

## 6. Portal iframe embedding (CSP header)

Without a `frame-ancestors` header the browser **refuses to render the app
inside the portal iframe** (Firefox shows “will not allow … if another site has
embedded it”).

**You do not add this in AppProfiles.** The gentian-os operator injects NGINX
`configuration-snippet` directives on every app `Ingress` it creates, allowing
embedding from the shared kernel portal (`https://portal.${KERNEL_DOMAIN}`).
Tenants sign in at the kernel portal, not `portal.<tenant-domain>`.

If your chart needs extra NGINX snippet lines (e.g. CryptPad `sub_filter`), put
only those under `ingress.annotations`; the operator prepends the
frame-ancestors block and strips any legacy per-profile CSP you may have copied
from older examples. The operator **appends** a second `Content-Security-Policy`
header (it does not replace the app's CSP). CryptPad's sandbox relies on the
upstream `script-src` without `'unsafe-eval'`; clearing the whole header causes
"eval should not be permitted" at load time.

**No other app-level CORS setup is required.** TLS, bearer-token forwarding,
and same-origin iframe loading are handled by the platform.

### 6b. Kernel diagram service (CryptPad)

Diagram editing from Nextcloud Files uses a **shared CryptPad kernel service**
(like Collabora in §9b of `gentian-os/docs/architecture.md`), not a per-tenant
AppProfile. One instance at `pad.<kernel_domain>` plus
`pad-sandbox.<kernel_domain>` for the crypto sandbox origin serves all tenants;
Nextcloud embeds it from `files.<kernel_domain>`.

There is **no portal tile** and **no tenant ingress** — manifests live under
`gentian-os/kernel/services/cryptpad/`. CSP `frame-ancestors` on the kernel
ingresses must allow Nextcloud and the portal; do not use `more_clear_headers`
(microk8s ingress-nginx lacks it) — append with `add_header … always` only.

---

## 7. Global domain and hosts

Many Bitnami-family and opendesk charts read `global.domain` and `global.hosts`
to build their internal URLs. If these are missing, charts fall back to
`example.com` defaults, which breaks inter-service communication:

```yaml
extraValues:
  global:
    domain: "${TENANT_DOMAIN}"
    hosts:
      openproject: "projects"  # subdomain for this app
      keycloak: "id"
      nubus: "portal"
```

### 7b. Jitsi + Element (video in Matrix rooms)

OpenDesk keeps Jitsi and Element as **separate AppProfiles** in the same tenant.
To enable conference widgets:

1. Install both `element` and `jitsi` on the tenant (`spec.apps`).
2. Element's `optionalIntegrations` declares `videoconference` from provider `jitsi`
   (creates an `IntegrationBinding`; no extra Helm wiring in the binding itself).
3. The `app-element` composition deploys **Matrix User Verification Service**
   (UVS bootstrap Job + service). Jitsi Prosody must use `AUTH_TYPE=hybrid_matrix_token`
   and `MATRIX_UVS_URL=http://opendesk-matrix-user-verification-service.${TENANT_NAMESPACE}.svc.cluster.local`.
4. Set `global.hosts.jitsi: meet` in **both** profiles so Element's bundled
   `jitsi.html` widget targets `https://meet.${TENANT_DOMAIN}`.
5. Configure shared TURN in `gentian-deployments` → `kernelServices.turn*` on the
   gentian-os Helm chart; compositions substitute `${TURN_*}` into Element Synapse
   and Jitsi Prosody env vars.

---

## 8. OIDC client spec

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

## 10. Composition reference

Only set `compositionRef` when using a non-default composition:

| Composition | When to use |
|---|---|
| *(omit)* | Standard apps — `app-default` is used automatically |
| `app-element` | Element (Matrix) — uses the element-specific composition |
| `app-ox` | OX App Suite — uses the ox-specific composition |

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
- [ ] OIDC uses full `OIDCClientSpec`, realm is `${TENANT_ID}`
- [ ] Secrets only in `valueMapping` / `appSecrets`, never in `extraValues`
- [ ] `reloader.stakater.com/auto: "true"` in `podAnnotations`
- [ ] (automatic) Operator injects portal `frame-ancestors` on app Ingress — no profile annotation needed
- [ ] (CryptPad / multi-host) `additionalIngresses` use flat subdomains; no per-host CSP in annotations — operator sets `pad-sandbox` policy
- [ ] `spec.browserProxy` declared if the shell calls this app's REST API
- [ ] `compositionRef` omitted unless using a non-default composition
- [ ] YAML passes `python3 -c "import yaml; yaml.safe_load(open('<file>'))"` locally
