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
Terraform (`set_sensitive`) → Helm values.

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
`gentian-os/tenants/{tenant}/apps/{app}/appSecrets/{name}` and injects them via
`set_sensitive` at deploy time.

---

## 5. Ingress

### 5a. Operator ingress spec

```yaml
ingress:
  subDomain: "projects"        # camelCase — NOT "subdomain" (lowercase is wrong)
  serviceName: "openproject"   # Kubernetes Service name — see fullnameOverride note
  servicePort: 8080
  ingressClassName: "nginx"
  tlsEnabled: true
  clusterIssuer: "letsencrypt-http01"
```

**`subDomain` capitalization matters.** The field is validated; `subdomain` is
silently ignored, leaving the app with no ingress.

### 5b. Always disable chart-managed ingress

Every chart that ships its own `Ingress` resource must have it disabled, otherwise
two `Ingress` objects collide on the same host:

```yaml
extraValues:
  ingress:
    enabled: false
```

### 5c. Predictable Service name

The Crossplane composition generates a random Helm release name. If the chart
uses the release name in its Service name, the operator cannot predict it.
Set `fullnameOverride` to lock the Service name:

```yaml
extraValues:
  fullnameOverride: "openproject"   # matches spec.ingress.serviceName above
```

---

## 6. Portal iframe embedding (CSP header)

Apps that should be embeddable inside the gentian portal tile need the
`frame-ancestors` Content Security Policy header. Add it as an ingress annotation:

```yaml
ingress:
  annotations:
    nginx.ingress.kubernetes.io/configuration-snippet: |
      more_clear_headers "X-Frame-Options";
      more_clear_headers "Content-Security-Policy";
      more_set_headers "Content-Security-Policy: frame-ancestors 'self' https://portal.desk.gentian.org";
```

Without this the browser refuses to render the app inside the portal iframe.

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
- [ ] CSP `frame-ancestors` annotation if portal embedding is required
- [ ] `compositionRef` omitted unless using a non-default composition
- [ ] YAML passes `python3 -c "import yaml; yaml.safe_load(open('<file>'))"` locally
