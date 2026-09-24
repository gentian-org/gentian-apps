# Security conventions for Gentian apps

This template implements the **application-layer** slice of
[gentian-os/docs/design/new-security-architecture.md](https://github.com/gentian-org/gentian-os/blob/main/docs/design/new-security-architecture.md).
Platform MAC (namespaces, default-deny egress, mesh) is enforced by Gentian OS;
apps must not weaken it.

---

## Mandatory requirements (every app)

These are **non-negotiable** for any Gentian first-party app (catalogue or kernel).
CI and catalogue review should fail if any are missing.

### Authentication

| # | Requirement | How |
|---|-------------|-----|
| M1 | **Validate OIDC bearer tokens on every user-facing API route** | `Depends(get_current_user)` on all `/api/v1/*` handlers that return or mutate tenant/user data |
| M2 | **`AUTH_DISABLED` only in local dev** | Must be `false` in cluster; chart sets it from `auth.disabled: false` |
| M3 | **Validate JWT issuer, signature, and expiry** | Use `core/auth.py` JWKS path — do not roll custom token parsing |
| M4 | **Scope operations to the authenticated tenant** | Read `TENANT_ID` / claims; never trust client-supplied tenant IDs without matching the token |

Public unauthenticated endpoints are limited to **`/healthz`** and **`/readyz`** only.

### Secrets

| # | Requirement | How |
|---|-------------|-----|
| M5 | **Pattern A — no secrets in Git or Helm values** | Chart uses `existingSecret` + `envFrom`; credentials come from ESO/OpenBao |
| M6 | **No secrets in ConfigMaps, env literals, or AppProfile** | Only `valueMapping` key names in profile; values injected at deploy time |
| M7 | **No logging of tokens, passwords, or connection strings** | Redact `Authorization` headers in logs |

### API surface

| # | Requirement | How |
|---|-------------|-----|
| M8 | **Expose `/healthz` (liveness) and `/readyz` (readiness)** | Unauthenticated; wired to Deployment probes |
| M9 | **Explicit CORS in production** | `BACKEND_CORS_ORIGINS` set to the app’s HTTPS origin(s) — never `*` on tenant apps |
| M10 | **HTTPS only at the edge** | App listens on HTTP inside the cluster; TLS terminates at Envoy Gateway |

### Workload hardening (chart)

| # | Requirement | How |
|---|-------------|-----|
| M11 | **Run as non-root** | `podSecurity.runAsNonRoot: true`, `runAsUser: 65532` |
| M12 | **Drop all capabilities, no privilege escalation** | `containerSecurityContext` in chart templates |
| M13 | **Read-only root filesystem** | Writable paths only via `emptyDir` (e.g. `/tmp`) |
| M14 | **No privileged containers or hostPath** | Admission will reject; do not request exceptions in chart |
| M15 | **Pin container image tags** | Semver or digest in `chart/values.yaml` — no floating `latest` in production |

### Edge routing

| # | Requirement | How |
|---|-------------|-----|
| M16 | **Gateway API HTTPRoute only** | `chart/templates/httproute.yaml`; no nginx Ingress, no in-pod reverse proxy |
| M17 | **Split API and static web at the gateway** | `/api`, `/healthz`, `/readyz` → API Service; `/` → web Service |

### Catalogue declaration (catalogue apps only)

Integration **contracts** are how Gentian declares what an app offers and what it
can use from other apps. This is already in the `AppProfile` CRD — not a separate
`consumes` / `publishes` block.

| Security architecture term | AppProfile CRD field | Meaning |
|---|---|---|
| *publishes* (manifest) | `spec.provides` | Contract names this app **provides** (e.g. `project-management`) |
| *consumes* (manifest) | `spec.optionalIntegrations` | Contract names this app **may consume**, with optional `capabilities` |

Contract **schemas** live in `gentian-apps/contracts/` (when present). The profile
only references contract **names** that match those definitions.

**Three layers — do not confuse them:**

| Layer | What | Who authors | Today |
|---|---|---|---|
| **Declaration** | `provides` + `optionalIntegrations` on AppProfile | Catalogue / app developer | **Implemented** (CRD) |
| **Wiring** | `IntegrationBinding` — credentials + OIDC between installed apps | Platform operator (auto when peers match) | **Implemented** |
| **Grant (ReBAC)** | Future `AppGrant` — tenant-approved subset + OpenFGA tuples | Tenant admin at install | **Planned** (Stage 2 in security architecture) |

`kernelRequirements` (OIDC, Postgres, S3, …) is **separate** — it declares
**kernel services**, not cross-app integration contracts.

| # | Requirement | How |
|---|-------------|-----|
| M18 | **Declare kernel needs honestly** | `kernelRequirements` — only OIDC/DB/storage/mail the app actually uses |
| M19 | **Declare integration contracts honestly** | `provides` / `optionalIntegrations` — only contracts the app implements or consumes; see existing profiles under `gentian-apps/profiles/` |
| M20 | **Never implement tenant grants in app code** | Cross-app access is wired by `IntegrationBinding` (today) and `AppGrant` + OpenFGA (future) — apps declare, they do not grant |

Kernel-only repos (e.g. `gentian-ui`) skip M18–M20; they deploy via ApplicationSet, not AppProfile.

---

## Mandatory when applicable

Enable these when the condition is true — not optional laziness.

| Condition | Requirement |
|-----------|-------------|
| App calls **Kubernetes or Gentian APIs** | M21: Dedicated **ServiceAccount** + **Role/RoleBinding** (or ClusterRole if cross-namespace) with **minimum verbs/resources**; `rbac.create: true` |
| App exposes **admin or destructive operations** | M22: **OpenFGA / AuthZEN `Check`** before the handler runs (via `require_permission()` once PDP is wired) |
| App runs **AI agents or workflows** | M23: **Dedicated Keycloak client per agent instance** — never reuse human credentials or a shared service account |
| App agents act **on behalf of a user** | M24: **RFC 8693 token exchange** with `act` / `may_act`; rights derived through user ceiling (§2.3) |
| App calls **external URLs** | M25: Declare endpoints; rely on platform egress allowlist — do not disable NetworkPolicy |
| App stores **tenant/user data** | M26: **Row-level tenant isolation** in queries; no cross-tenant reads even if ReBAC is not wired yet |
| **Production** deploy | M27: **CPU/memory requests and limits** on api and web containers |

---

## Mandatory once platform Stage 2 is live

When OpenFGA is available in the cluster, these become mandatory for all apps
(not just admin apps):

| # | Requirement |
|---|-------------|
| S1 | Call OpenFGA **Check** (AuthZEN API) on every mutation and sensitive read |
| S2 | Effective access = `AppProfile contract declaration ∩ tenant grant (AppGrant, future) ∩ user ceiling ∩ ABAC` |
| S3 | Agent routes validate **delegation tuple + task TTL** before acting |

Until then, M1–M4 + M26 are the minimum authorization bar.

---

## Where this template implements each requirement

| Area | Path |
|------|------|
| JWT validation (M1–M4) | `backend/app/core/auth.py`, `backend/app/core/tenant.py` |
| Log redaction (M7) | `backend/app/core/logging_middleware.py` |
| Health probes (M8) | `backend/app/api/routes/health.py` |
| CORS (M9) | `backend/app/core/config.py`, `chart/values.yaml` |
| OpenFGA PEP stub (M22, S1) | `backend/app/core/authz.py`, `backend/app/core/openfga_client.py` |
| Tenant DB scoping (M26) | `backend/app/db/session.py` |
| Resource limits (M27) | `chart/values.yaml`, `chart/values-production.yaml.example` |
| Frontend OIDC + bearer (M1) | `frontend/src/auth/`, `frontend/src/api/client.ts` |
| Protected routes | `frontend/src/auth/RequireAuth.tsx`, `frontend/src/router.tsx` |

---

## Platform-provided — apps must NOT reimplement or weaken

These are **not** app author responsibilities. Do not duplicate or override them
in the chart unless platform docs explicitly require an app-specific supplement.

| Control | Owner |
|---------|--------|
| Per-tenant namespace isolation | Gentian OS / Crossplane |
| Default-deny egress NetworkPolicy (Cilium) | Gentian OS |
| Tenant Gateway + wildcard TLS (cert-manager) | Gentian OS operator |
| `frame-ancestors` / CSP for portal iframe embedding | Gentian OS gateway policy |
| Admission control (no privileged pods, image policy) | Kyverno / Gatekeeper |
| Keycloak realm, OIDC clients, token exchange infra | Kernel Keycloak config |
| OpenBao paths + ESO ExternalSecrets | Platform provisioning |
| HTTPRoute hostnames from AppProfile `ingress.subDomain` | Operator (tenant apps) |

---

## Checklist before merge / release

```text
[ ] M1–M4  OIDC on all data routes; tenant scoping
[ ] M5–M7  Pattern A secrets; no leakage in logs
[ ] M8–M10 Health probes; CORS; no in-app TLS termination
[ ] M11–M15 Pod hardening; pinned images
[ ] M16–M17 HTTPRoute; no nginx
[ ] M18–M20 AppProfile honest declaration (catalogue apps)
[ ] M21+    Conditional items reviewed
[ ] M27     Resource limits set for production
```

---

## Related

- [gentian-os/docs/design/app-catalogue.md](https://github.com/gentian-org/gentian-os/blob/main/docs/design/app-catalogue.md) — contracts, `provides`, `IntegrationBinding`
- [gentian-os/docs/design/new-security-architecture.md](https://github.com/gentian-org/gentian-os/blob/main/docs/design/new-security-architecture.md) §3.4 — same model as `provides`/`optionalIntegrations`, plus future AppGrant/ReBAC
- [gentian-os/docs/design/gateway.md](https://github.com/gentian-org/gentian-os/blob/main/docs/design/gateway.md)
- [gentian-os/docs/design/security.md](https://github.com/gentian-org/gentian-os/blob/main/docs/design/security.md)
- [gentian-os/docs/design/app-catalogue-security.md](https://github.com/gentian-org/gentian-os/blob/main/docs/design/app-catalogue-security.md)
