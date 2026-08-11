# AppProfile Authoring Guide

This guide covers **catalogue entries for existing upstream Helm charts** (profile
YAML only). To **build a new Gentian-native app** (FastAPI + React + Helm), see
[custom-app-guide.md](custom-app-guide.md).

This guide captures the accumulated learnings and best practices from the existing
AppProfile implementations. Read it before writing a new profile — every section
corresponds to a class of bug that was caught in git history.

**Before extending an already-installed app**, use the
[customization ladder](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md)
and [docs/customization-ladder.md](customization-ladder.md) instead of this guide —
they give the decision procedure (which rung, which repo) and the per-app declaration
(`spec.customization`) that make `extraValues` vs `dropins/` vs `composition.yaml`
placement (§1 below) a lookup rather than a judgment call.

---

## 0. Why this repo is laid out the way it is

Read this before proposing to move things around. `gentian-apps` is a
**distribution repo**, not an application monorepo, and almost every layout
decision follows from that one fact.

### The two archetypes

| | **Application monorepo** | **Distribution / catalogue repo** |
|---|---|---|
| Examples | company service monorepos (Nx, Turborepo, Bazel) | Debian, nixpkgs, Homebrew, `bitnami/charts` |
| Contains | source code you own end-to-end | *packaging* for software mostly written elsewhere |
| Layout | **colocate** — `services/foo/{src,Dockerfile,chart}` | **name-addressed trees per artifact type** |
| Why | one team owns the whole vertical and ships it as a unit | many independent packages; tooling globs by type |

`gentian-apps` is overwhelmingly the second. Of 21 profiles, 7 wrap **external**
charts (Nextcloud, XWiki, OpenProject, Element) that this repo will never
contain, 2 declare no chart at all, and the remaining 13 share just **three**
in-repo charts — `charts/odoo` alone backs 10 profiles. The repo holds catalogue
metadata and a little packaging, with exactly one first-party application
(`apps/app-store/`). That is Debian's shape, not Google's.

### Consequence 1 — artifact types get their own flat, name-addressed trees

```
profiles/     catalogue metadata      → synced by ArgoCD
charts/       chart source            → built + pushed to OCI by CI
images/       Dockerfiles             → built + pushed to GHCR by CI
apps/         first-party source      → the one monorepo-shaped corner
contracts/    cross-app interfaces    → owned by no single app
```

Charts and images are **not** nested inside the profile that uses them, for three
concrete reasons:

1. **The link is by coordinate, not by path.** A profile references its chart as
   `oci://ghcr.io/gentian-org/charts` + `name` + `version`. Nothing ever reads a
   chart off disk relative to a profile. Filesystem adjacency would imply a
   coupling the pipeline does not have.
2. **The cardinality is wrong.** `charts/odoo` serves 10 profiles; `images/nextcloud`
   is one Dockerfile matrix-built into 4 editions. Nesting forces an arbitrary
   choice of which consumer "owns" it.
3. **Helm tooling assumes it.** `chart-testing` (`ct lint --all`) and
   `helm/chart-releaser-action` both default to `charts/` at the repo root.

### Consequence 2 — placement never encodes mutable facts

A tempting rule is "shared assets live at the nearest common ancestor, specific
ones live in the profile folder." **We deliberately rejected it.** It makes a
directory's location depend on how many things currently use it, so gaining a
second consumer forces a physical move — new path, new CI trigger, broken git
history — even though nothing about the artifact changed. You also lose the
ability to answer "show me every chart" with one glob.

This is the mistake nixpkgs spent years unwinding: `pkgs/applications/networking/
browsers/firefox/` encoded a classification, and classifications drift. Their 2023
migration to `pkgs/by-name/fi/firefox/` made location encode *nothing but the
name*. A sidecar chart used by two unrelated apps is therefore just
`charts/gentian-sidecar-git-modules/` — a chart like any other.

The same principle is why `spec.tier` is a **field**, not a directory level (see
`docs/backlog.md`), and why `contracts/` stays flat: a contract is cross-app by
definition, so nesting it under one family would misstate what it is.

### Consequence 3 — version packaging, never built artifacts

Distribution repos track the *recipe*; the registry stores the *output*. That is
why `charts/packages/*.tgz` was removed — CI publishes to
`oci://ghcr.io/gentian-org/charts`, and that registry is the artifact store.
Debian does not commit `.deb` files into its packaging tree, and nixpkgs does not
commit build outputs.

The same rule explains why a **vendored** chart is a smell rather than a pattern.
Carry the *delta*, not the copy — Debian's `debian/patches/`, Gentoo's `files/`.

`charts/activepieces/` is the worked example. It used to be a 151-file copy of
upstream including Bitnami's postgresql and redis subcharts; it is now
[`UPSTREAM`](../charts/activepieces/UPSTREAM) (pinned coordinates) plus
[`patches/`](../charts/activepieces/patches/) (a DEP-3 series), built by
`scripts/build-activepieces-chart.sh`. That removed ~22k lines — but the real
payoff was diagnostic: the actual delta was **240 lines across 4 files**, and
three of the five patches turned out to be plain upstream bugs (secrets
regenerated on every deploy, YAML indentation, a Redis username read from a
nonexistent secret key). A copy had been hiding them as "just how our chart
looks"; as patches they have `Forwarded:` headers and an owner.

Set `chartOwnership: patched` for this shape — `vendored` means a copy still
exists and should be reviewed.

**When you hit a chart that needs template changes, measure the delta before
assuming a copy is necessary.** `helm pull --untar` the pinned upstream version
and `diff -ruN` against what you have; a few hundred lines is a patch series, not
a fork.

### Consequence 4 — profiles group by family; discovery keys off a marker file

`profiles/` groups multi-profile families one level deeper
(`profiles/odoo/odoo-cb-crm/`) while true singletons stay flat
(`profiles/xwiki/`). Bundles are discovered by the presence of
`kustomization.yaml` at **any** depth, not by a fixed directory level, so mixed
depth needs no exclude-list of "known family folders".

Two invariants make that safe, and CI enforces both:

- **Leaf directory name == `metadata.name`.** The catalogue ApplicationSet names
  each Application after the leaf directory. `AppProfile` is cluster-scoped, so
  those names are globally unique — but only while this holds.
- **A `profile.yaml` must have a sibling `kustomization.yaml`**, or the bundle is
  invisible to the generator and would silently never sync.

Because leaf names are stable, regrouping a profile updates its Application's
source path *in place* — no rename, no delete/recreate, and no prune of a live
`AppProfile` (the ApplicationSet runs `prune: true`).

---

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

## ❌ Absolute prohibition — no cluster hotfixes, ever

> **Gentian OS must run identically on any cluster, at any time, from a clean
> install. Any change that lives only on a specific cluster violates this
> invariant and is strictly forbidden.**

### What is a cluster hotfix?

A cluster hotfix is any change applied directly to a live cluster that is **not
tracked in a git repository** and **not deployed by the normal CI/CD pipeline**.
Common forms include, but are not limited to:

| Forbidden action | Why it is harmful |
|---|---|
| `kubectl create configmap` / `kubectl apply` of a resource that overrides files mounted into a pod | Shadows the Docker image silently; invisible to git, CI, and code review; does not survive cluster reprovisioning |
| `kubectl patch deployment` to inject an env var, change an image tag, or add a volume | Bypasses the Helm release; ArgoCD will drift-detect or silently accept it |
| `kubectl exec` + writing files into a running container | Survives only until the pod restarts; leaves no trace |
| Editing a Secret or ConfigMap in the cluster to change application behaviour | Not reviewed, not auditable, not reproducible |
| Pinning a pod to a node, taint, or toleration outside of the chart | Breaks portability |

### The correct path — always

```
1. Reproduce the bug or missing behaviour in the local dev environment.
2. Fix it in the source code (gentian-ui, gentian-apps, gentian-os — whichever owns it).
3. Write or update a test.
4. Commit with a descriptive message, push, open a PR / push to develop.
5. CI builds the image and the CD pipeline deploys it.
6. Verify on the target cluster via the normal deployment.
```

If you cannot reproduce the issue locally and feel pressure to "just fix it in the
cluster", **stop**. Raise the issue in the team, extend the local dev environment
so the class of bug is reproducible, then fix it properly.

### If a cluster hotfix already exists

1. Identify the override (e.g. a ConfigMap volume-mounted into a pod).
2. Implement the real fix in source and push it.
3. Wait for CI to build and deploy the new image.
4. **Delete the hotfix resource** (`kubectl delete configmap …`) so the
   deployment reverts to the clean state.
5. Confirm via `kubectl get` that no trace of the override remains.
6. Document what happened in the commit message or a post-mortem.

Leaving a hotfix in place "until we have time" is not acceptable — it will
outlast the original incident and cause confusion for every engineer who works on
the system after you.

### ❌ Absolute prohibition — no licensing bypass or software cracking

> **Gentian OS must never bundle, configure, or apply any code modification, patch, or workaround designed to bypass software license key validation, crack enterprise capabilities, or circumvent terms of service for proprietary application features.**

#### Guidelines for Compliant Catalogue Integration:
1. **Edition Strictness:** If an application offers both a Community Edition (CE) and a proprietary Enterprise Edition (EE), the default profile in the catalogue repository MUST configure the Community Edition (e.g., standard free auth methods, omitting licensed Enterprise features like SAML SSO, git sync, or advanced RBAC unless a valid license key is provided).
2. **Proper License Key Activation:** If enterprise features are desired for testing or staging, configure them legally by passing a valid partner/customer license key via secure environment variables (`AP_LICENSE_KEY`, etc.), rather than patching compiled frontend or API server bundles (e.g. `main.js`) on startup.
3. **No Hacking Workarounds:** Never inject base64-encoded patches, runtime script overrides, or SQL trigger hacks to artificially toggle Boolean flag columns (such as `ssoEnabled: true` or `customAppearanceEnabled: true`) in database platform configurations.

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
  deploymentMethod: crossplane          # crossplane (default) or argocd
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
| **Catalogue** | `tile.icon: mail` | Pick from `gentian-ui/legacy/design-system/tiles/catalogue.json` |
| **Custom** | `tile.image: assets/tile.svg` → run `scripts/sync-profile-tile.py` | Inlines to `tile.logo` data URI |

Per sub-app overrides: `spec.portalTiles[].tile.icon` (e.g. OX mail vs calendar).

The gentian-os LDAP reconciler resolves `tile.icon` to a data URI when writing
`pathToLogo`. Legacy `spec.logo` still works but is deprecated.

CI: `scripts/validate-profile-tiles.py` (see `.github/workflows/apps-ci.yaml`).

### Base + addon profile bundles

For apps with a shared runtime and thin addon entries (Odoo, OX-style), use
**metadata annotations** — do not add per-app fields to `AppProfile` spec:

| Annotation | Values | Purpose |
|---|---|---|
| `gentianos.io/deployment-role` | `standalone` (default), `base`, `addon` | How the operator/composition deploys this entry |
| `gentianos.io/platform-app` | `"true"` | Hidden from App Store listing (required base runtimes) |

An addon names its base in **`spec.customization.addon`** (`id` + `of`), not in an
annotation. It is never installed on its own: the base is installed and the addon is
selected into it, arriving in `Tenant.spec.apps[].addons`. The retired
`gentianos.io/requires-profile` annotation, which auto-installed a base when an addon
was installed as if it were an app, no longer exists — see
[app-customization.md](../../gentian-os/docs/app-customization.md) §4.2.

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
| **`spec.extraValues`** | Helm chart needs non-secret structured config; composition passes it through | Odoo `addon: crm`, chart feature flags |
| **`spec.postInstallJob`** | Bootstrap must call the app's own runtime admin API (not Helm values, not `kernelRequirements`); small and self-contained | open-webui LiteLLM config seed (§13a) |
| **`composition.yaml`** | Custom Crossplane MR graph, multi-Job/RBAC sequencing, chart-specific workarounds | OX bootstrap Job, Element Jitsi overlay, addon install Jobs |
| **Upstream chart / vendor** | Fix belongs in the supplier chart long-term | OX `initconfigdb -i`, Keycloak client scopes in openDesk |

This table is the rung mapping in different words —
[customization-ladder.md](customization-ladder.md) names them: `extraValues` is
**L0**, a declared drop-in directory is **L1**, `composition.yaml` /
`postInstallJob` is **L4**, and vendoring the chart is an **L4** repackage too
(an actual source patch is **L5**). Use that doc's decision procedure to pick the
row; use this table to find the file.

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

### Browser-facing vs server-to-server URLs (public vs internal)

`${TENANT_DOMAIN}` and `${KERNEL_DOMAIN}` are **public** hostnames for the
**browser**. Any call made **server-side, from inside the cluster** — one
workload reaching another — should target **internal** Kubernetes service DNS
(`<service>.<namespace>.svc.cluster.local`), not the public hostname. This rule
applies to **every** profile, not any one app.

| Caller → callee | URL to use |
|---|---|
| Browser → app UI | Public `https://<sub>.${TENANT_DOMAIN}` |
| App backend → its kernel deps (DB, S3, LDAP, SMTP) | Internal — already service DNS via `${LDAP_HOST}`, `${S3_ENDPOINT}`, … |
| Companion/sidecar → main app (e.g. an editor's file callback) | Internal `http://<svc>.${TENANT_NAMESPACE}.svc.cluster.local:<port>` |
| Kernel component → tenant app (portal API, provisioners) | Internal `http://<svc>.tenant-<t>.svc.cluster.local:<port>` |
| App backend → central IdP token/userinfo exchange | Internal Keycloak (`KEYCLOAK_INTERNAL_URL`), not `https://id.${KERNEL_DOMAIN}` |

**Why not use the public hostname everywhere?** Inside the cluster, CoreDNS
**hairpins** `*.${KERNEL_DOMAIN}` and `*.${TENANT_DOMAIN}` to the edge gateway.
That path has two traps for server-side HTTP clients:

1. **Staging TLS certs.** On dev/staging the gateway serves a **Let's Encrypt
   staging** cert. Strict clients (Python `httpx`, Go, JVM, Node, Twisted) reject
   it with `CERTIFICATE_VERIFY_FAILED` / `unable to get local issuer certificate`.
   Symptom: HTTP 500 from the caller, "could not connect", or a hung TLS handshake.
2. **Extra latency and failure surface.** The request leaves the pod, traverses
   the gateway, and comes back — slower, and dependent on gateway/DNS health for a
   call that never needed to leave the cluster.

**Two ways to satisfy a server-side call:**

- **Preferred — internal service URL.** Point the callback/integration at
  `.svc.cluster.local`; plain HTTP is fine in-cluster. This is what the Nextcloud
  WOPI callback (§6g), the portal bridge (§6g), and Element's `KEYCLOAK_INTERNAL_URL`
  (§6d) all do.
- **When the public host is unavoidable** (the app hard-codes it, or browser and
  server must agree on one issuer string) — **trust the staging CA** in that
  runtime: mount `gentian-staging-ca-tls` and set the language's trust env
  (`NODE_EXTRA_CA_CERTS`, JVM truststore, `SSL_CERT_FILE`), or set the app's
  documented "insecure SSL for testing" flag. See the ACME staging note below and §8a.

**Cross-namespace reachability:** a kernel component calling a tenant app relies
on the tenant baseline `tenant-isolation` NetworkPolicy allowing ingress from
`platform-kernel` (operator default). A companion service that must reach the edge
gateway for a browser-side flow (e.g. an editor fetching `https://<sub>.${TENANT_DOMAIN}`)
declares `gentianos.io/kernel-egress-namespaces: envoy-gateway-system` on the profile.

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

**ACME staging (dev):** this is the "public host unavoidable" branch of the
server-to-server rule above — Synapse must present the same OIDC issuer string to
the browser and validate it server-side, so it cannot swap in an internal URL and
must instead trust the staging CA. When `tenantDNS01ClusterIssuer` contains `staging`,
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

**Narrow exception:** an older gentian-os CRD schema defaulted this field
server-side (removed; see gentian-os commit `5484346`), which permanently
baked `clusterIssuer: letsencrypt-http01` into any live `AppProfile` that hit
the code path (profiles declaring `sidecars`, e.g. `activepieces`,
`odoo-cb-base`). Since Server-Side Apply doesn't retroactively prune a value
it never itself declared, those two profiles set it explicitly in git to
match — not because the field does anything, but so ArgoCD stops reporting a
permanent diff against a value only the API server ever wrote. **Do not copy
this into a new profile** unless `kubectl get appprofile <name> -o
jsonpath='{.spec.ingress.clusterIssuer}'` shows it's already live and
undeclared.

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

### 5e. Shell proxy for app APIs (`spec.browserProxy`) — planned, not yet implemented

> **Status:** The `browserProxy` field exists on the AppProfile CRD but the
> gentian-ui frontend and backend do **not** implement it yet. Do not rely on
> it in profiles today — the shell will not proxy anything. This section
> documents the intended design for when implementation lands.

Declare a `browserProxy` route when the gentian shell (not the app's own UI)
needs to call the app's API from the browser. The shell will expose
`/api/apps/{appName}/{path}` and forward requests to the cluster-internal
service, injecting the user's bearer token.

```yaml
browserProxy:
  - path: api
    target: "http://openproject.{namespace}.svc/api/v3/"
    authMode: forward-bearer   # default — forwards the user's Bearer token
    stripPrefix: true          # default — strips /api/apps/{name}/api before forwarding
```

**When you'll need it:** the shell calls the app's REST API to show a widget,
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

Do not add per-app `Content-Security-Policy` or `X-Frame-Options` annotations — the
operator owns iframe policy for tenant app HTTPRoutes.

### 6c. AppProfile checklist (all profiles)

These profiles rely on the operator and need **no** CSP annotations:

- `app-store`, `nextcloud`, `openproject`, `xwiki`

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

### 6d. Element SSO — OIDC redirect URI host (gentian-pro)

> **Note:** The `element` profile lives in the proprietary **gentian-pro**
> catalogue. This section documents the pattern for reference; the profile is
> not in this repository.

Element Web is served at `chat.<tenant-domain>` but the Matrix homeserver (Synapse)
and OIDC callback live at **`matrix.<tenant-domain>`** (synapse-web Service). The
`element` AppProfile declares `additionalIngresses` for `matrix` → `synapse-web:8008`;
Keycloak `redirectUris` must target that homeserver host, not the chat host:

```yaml
kernelRequirements:
  identity:
    oidc:
      redirectUris:
        - "https://matrix.${TENANT_DOMAIN}/_synapse/client/oidc/callback"
```

Using `chat.${TENANT_DOMAIN}` here causes OIDC to fail after Keycloak login —
Element shows **"Invalid username or password"** even though credentials are
correct.

**Matrix localpart:** use `matrixIdLocalpart: "opendesk_username"` (LDAP `uid`) and
request scope `opendesk-matrix-scope`. Do not use `preferred_username` — kernel-broker
tokens may carry `mailPrimaryAddress` there, which is not a valid Matrix localpart.

**Kernel IdP broker (tenant realm):** after portal login, Element/XWiki hit
`/realms/${TENANT_ID}/broker/kernel/endpoint`. Broker token exchange must use the
**in-cluster** Keycloak URL (not `https://id.${KERNEL_DOMAIN}` from inside the
cluster), and tenant-realm IdP mappers must import `opendesk_username` from the
broker token. See `gentian-os/docs/design/iam.md`.

**Wrong user after switching portal accounts:** portal login uses the **kernel**
realm; Element/Synapse OIDC uses the **tenant** realm. A previous user's
tenant-realm SSO cookie or cached Matrix session in the browser can reopen Chat as
the wrong person. The Element AppProfile sets `logout_redirect_url`; gentian-ui app
tiles pass `login_hint` and `prompt=login` (and `#/logout` on `chat.*`) when opening
SSO apps from the portal.

**Known pitfalls** (operator/IAM territory, not AppProfile YAML — diagnose via
`gentian-os/docs/design/iam.md` and the kernel intercom service before touching a
profile):

| Symptom | Likely cause |
|---|---|
| Login succeeds but Synapse logs `invalid_scope` in a reload loop | Keycloak client scope reconciliation stripped `opendesk-matrix-scope` from the Synapse client |
| Nordeck banner flickers on silent login after Matrix login already works | Kernel intercom (ICS) session/config issue, not tenant Crossplane |
| `502` on `/realms/.../broker/kernel/endpoint` | Broker using the external instead of in-cluster Keycloak URL, or a missing IdP mapper |
| `invalid_client_credentials` from Keycloak | Synapse `client_secret` still holds the unsubstituted placeholder — check the composition's secret mapping |
| `invalid_claim: Invalid claim "iss"` | Configured OIDC issuer doesn't match the cluster's actual realm issuer URL byte-for-byte |

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

#### Collabora WOPI — critical configuration

Collabora is a **server-side companion** — the general case is any app that ships
a back-end helper (document editor, media transcoder, search indexer, thumbnailer)
that calls back into the main app or another cluster service. Per the public-vs-internal
rule (§2), those callbacks use **internal service DNS**; the browser-side editor URL
stays public. The `coolwsd`-specific settings below must align or document editing
silently fails — but the *shape* of the problem (internal callback URL + SSL scheme +
egress + host allowlist) recurs for any such companion:

| Setting | Value | Why |
|---|---|---|
| `storage.ssl.as_scheme=true` | `extra_params` | **Critical.** Without this, coolwsd always uses SSL for WOPI callbacks regardless of the URL scheme — it tries TLS to port 8080 and hangs with `Connection timed out`. |
| `storage.ssl.enable=false` | `extra_params` | Internal WOPI callback is plain HTTP (`http://nextcloud.<ns>.svc:8080`); no TLS needed. |
| `wopi_callback_url` | `http://nextcloud.${TENANT_NAMESPACE}.svc.cluster.local:8080` | Must be the **internal** service URL, not the public `https://cloud.<tenant>`. Collabora uses this to call back into Nextcloud for CheckFileInfo/GetFile. |
| `aliasgroups` | Internal + `http://cloud.<domain>:8080` + `https://cloud.<domain>` | coolwsd validates the WOPI source host against aliasgroups; all forms of the Nextcloud URL must be listed. |
| `net.post_allow` | `10\.\d+\.\d+\.\d+`, `.*\.svc\.cluster\.local` | Required for coolwsd to accept POST requests from cluster-internal addresses. |
| `securityContext.capabilities` | `CHOWN`, `FOWNER`, `SYS_CHROOT` | Collabora's `cool` user needs these to create jails and manage file permissions. |

**Egress for HTTPS hairpin:** Collabora pods fetch Nextcloud settings/files via
`https://cloud.<tenant_domain>` when opening documents in the browser. The
CoreDNS hairpin resolves this to the tenant gateway in `envoy-gateway-system`.
The profile sets `gentianos.io/kernel-egress-namespaces: envoy-gateway-system`
so the operator grants egress to the gateway namespace.

#### Portal bridge — a kernel → tenant server-side call

The portal API (in `platform-kernel`) provisions the app user via OCS before
opening the Files iframe. This is a textbook **kernel → tenant** call from §2, so
it uses the internal service URL (`http://nextcloud.tenant-<t>.svc.cluster.local:8080`),
never the public `https://cloud.<tenant>`. Using the public host here regressed
with `CERTIFICATE_VERIFY_FAILED` → HTTP 500 ("Could not open Files") the moment
CoreDNS hairpin + staging certs were in play. The baseline `tenant-isolation`
NetworkPolicy allows ingress from `platform-kernel` to make this reachable.

**Generalizes to any app with a portal session bridge:** OpenProject's bridge
(`openproject_session_bridge.py`) follows the identical pattern — internal service
URL for the admin/provisioning call, public host only for the browser redirect.
If you add a new bridged app, mint the session server-side against
`http://<svc>.tenant-<t>.svc.cluster.local`, not the public hostname.

#### Bridge provisioning — keep the hot path cheap

Opening an embedded tile runs the bridge on **every click**, so the
provisioning step must be fast. Two rules (learned from a ~5s Files stall):

1. **Do only what the login needs.** `gentian-portal-bridge.php` logs the user in
   with `setUser()` and never checks the account password, so the bridge only has
   to guarantee the user **exists** — it must **not** reset the password on every
   open. `_ensure_nextcloud_user` treats OCS `100` (created) and `102` (already
   exists) as success and skips the password `PUT`. Redundant writes in a
   per-click path are pure latency.
2. **Never let a blocked egress call sit in the hot path.** Nextcloud's
   `password_policy` app runs a **HaveIBeenPwned** breached-password check that
   calls `api.pwnedpasswords.com` on every password set. Cluster egress blocks it,
   so each call waited for the ~5s timeout. The profile disables it
   (`occ config:app:set password_policy enforceHaveIBeenPwned --value=false`). When
   wrapping any chart, audit for outbound calls to the public internet (breach
   checks, telemetry, avatar/gravatar fetches, license pings, update checks) and
   disable them — a blocked call becomes a multi-second stall, not a clean failure.

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

### 7b. Jitsi + Element (video in Matrix rooms) — gentian-pro

> **Note:** The `element` profile and `app-od-element` composition live in the
> proprietary **gentian-pro** catalogue. This section documents the design
> pattern for reference.

Jitsi is bundled as an **Element sidecar** (one install per tenant, not a separate
catalogue app). Installing `element` on a tenant deploys Jitsi at `meet.<tenant>` for
Element room widgets and portal realtime links.

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

The bootstrap Job runs at post-install only; a failed or stale `@uvs` account after
a reinstall needs the Job deleted and the Element `App` claim re-synced so
Crossplane retries it. This is an operational recovery step, not an AppProfile
concern — see the platform team's runbook rather than hand-editing the profile.

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

### 8a. Portal Integration: Direct OIDC vs Session-Bridge Flow

When integrating an application into the Gentian Portal, choose the correct authentication path based on how the application handles OIDC logins inside an iframe/embedded view (`linkTarget: embedded`):

| Integration Path | Description | Typical Apps |
|---|---|---|
| **Direct OIDC Flow** | The app's frontend initiates standard browser-side OIDC login. The portal warms up OIDC cookies in the background via hidden iframe. | XWiki, Odoo Community |
| **Session-Bridge Flow** | The portal API exchanges a single-use login ticket backend-to-backend, and passes this ticket to log the user in inside the iframe. | Nextcloud, Element, OpenProject |

#### 1. Direct OIDC Flow (with Silent SSO Warmup)
For standard web applications that support clean OIDC redirections and can run within an iframe:
- **How it works**: The app is launched directly at its public URL (e.g., `https://wiki.demo.desk.gentian.org/`). It redirects the browser inside the iframe to Keycloak. Keycloak detects existing session cookies and logs the user in silently.
- **Requirements**:
  - The Portal frontend must automatically bootstrap the OIDC session cookies (`KEYCLOAK_IDENTITY`/`KEYCLOAK_SESSION` on path `/auth`) upon desktop mount by calling `/auth/idp-session` and loading the impersonation URL in a hidden iframe.
  - The Keycloak browser flow (e.g. `browser-kernel-idp`) must set **both** the `Cookie` execution and the `Identity Provider Redirector` execution to **`ALTERNATIVE`**. Never set the redirector to `REQUIRED` as it forces redirecting to the parent realm and prompts for login.

#### 2. Session-Bridge Flow (with Backend Bridge Tickets)
For complex suite applications that block nested OIDC redirects inside cross-origin iframes or have custom API session handlers:
- **How it works**: When the user clicks the tile, the Portal frontend calls the Portal API to get a single-use bridge ticket (e.g. via Nextcloud OCS or OpenProject API). This ticket is passed in the launch URL parameters (e.g. `?ticket=<token>`). A custom bridge script/plugin on the app side consumes the ticket, calls the Portal API to verify it, sets the app session cookie, and redirects the user to the app page.
- **Requirements**:
  - The verification call from the app to the Portal API must run cluster-internally over service DNS (`http://gentian-portal-api.platform-kernel.svc.cluster.local:8000`), not the public portal URL, to avoid ingress hairpins and self-signed certificate issues.
  - The bridge login path must be highly optimized and not execute blocking egress calls (e.g., checking password breach databases) during ticket verification.

### 8b. openDesk supplier charts on Gentian — integration boundary

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

### 8c. OIDC Silent Single Sign-On (SSO) & Multi-Tenant Custom Attributes

When integrating OIDC applications in a multi-tenant environment (where users log in to a main portal on the `${KERNEL_DOMAIN}` but run app instances in sub-domains on the `${TENANT_DOMAIN}`), the following requirements are critical for smooth SSO:

1. **Silent SSO Session Bootstrapping**:
   * **The Problem**: Portal authentication uses a BFF (backend-for-frontend) pattern without redirecting the top-level browser window. Consequently, logging in to the portal does *not* automatically write Keycloak OIDC session cookies (`KEYCLOAK_IDENTITY`/`KEYCLOAK_SESSION`) in the browser. If a user subsequently navigates directly to an OIDC application (like XWiki), they will be redirected to Keycloak, which will fail to find a session and show the login page.
   * **The Solution**: The portal UI must warm up the OIDC browser session silently on initial desktop mount by making a request to `/auth/idp-session` and loading the resulting impersonation redirect URL in a hidden iframe (or popup). This ensures Keycloak cookies are written to the browser domain (`desk.gentian.org`) under the path `/auth` immediately on login.
   * **Keycloak Browser Flow Configuration**:
     * In a multi-tenant Keycloak setup brokered to a parent `kernel` Identity Provider (IdP), the tenant's browser flow (e.g. `browser-kernel-idp`) must configure **both** the `Cookie` execution and the `Identity Provider Redirector` execution as **`ALTERNATIVE`** (instead of setting the redirector to `REQUIRED`).
     * Setting the redirector to `REQUIRED` will bypass the `Cookie` check entirely, forcing Keycloak to always redirect the browser to the parent `kernel` realm login page even when valid local session cookies are present.

2. **Keycloak User Profile Schema & Custom Claims**:
   * **The Problem**: Keycloak 24+ enforces a strict schema for user profile attributes. If a custom user attribute (such as `uid` for mapped username claims like `gentian_username`) is set on a user record but is *not* explicitly declared in the realm's User Profile schema configuration, Keycloak will **silently discard** the attribute during user creation/updates via the Admin REST API. As a result, the claim in the OIDC ID Token will remain empty, causing OIDC callback handlers (e.g., XWiki's OIDC authenticator) to fail with internal server errors (like `The user document name resulting from the format is empty`).
   * **The Solution**:
     * Any custom attributes that need to be synchronized from LDAP, mapped from a broker, or set via the Admin API (e.g., `uid`, `gentian.inviteEmail`) **must be registered** in the Keycloak User Profile schema configuration for the realm (via the `ShellEnsureInviteEmailUserProfile` helper or Admin REST API `/users/profile`).
     * Ensure that the OIDC protocol mapper matches the case and name of the registered attribute precisely.

### 8d. SSO smoke-test after publishing a profile

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
| HTTP 500 on OIDC callback (empty username claim) | Chart expects `opendesk_username` / `gentian_username` (or similar) but `clientId` not in OIDC pack / wrong mapper, or Keycloak User Profile schema configuration is missing the mapped attribute (e.g. `uid`), causing Keycloak to silently drop it during admin user updates/sync. Register custom attributes in the User Profile schema. |
| Keycloak **“Sign in to your account”** (or redirect to `kernel` login) on direct navigation or tile launch despite active portal session | (1) Portal OIDC session warmup not executed on desktop mount (no cookies set). (2) Keycloak `browser-kernel-idp` browser flow has the redirector execution set to `REQUIRED` instead of `ALTERNATIVE`, causing Keycloak to bypass cookie validation and auto-redirect to the parent realm. |
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
assets.

Set `compositionRef` only when using a non-default composition:

| Composition | When to use |
|---|---|
| *(omit)* | Standard apps — `app-default` is used automatically |
| `app-openproject` | OpenProject — custom composition in `profiles/openproject/composition.yaml` |
| `app-od-element` | Element (OpenDesk) — bundle in **gentian-pro** (proprietary catalogue) |
| `app-od-ox` | OX App Suite — bundle in **gentian-pro** (proprietary catalogue) |

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
- [ ] Server-side/in-cluster calls (companion callbacks, provisioning, token exchange) use internal `.svc.cluster.local` URLs, not public hostnames — §2. If a public host is unavoidable, staging CA is trusted.
- [ ] Companion service that must reach the edge gateway sets `gentianos.io/kernel-egress-namespaces` — §2, §6g
- [ ] Element *(gentian-pro)*: OIDC redirect is `https://matrix.${TENANT_DOMAIN}/_synapse/client/oidc/callback` (not `chat.`)
- [ ] Element *(gentian-pro)*: `additionalIngresses` includes `matrix` → `synapse-web:8008` (required) — §6d
- [ ] Element *(gentian-pro)*: `matrixIdLocalpart: "opendesk_username"` (not `preferred_username`) — §6d
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
- [ ] `additionalIngresses` use flat subdomains; rely on operator gateway CSP for embed hosts
- [ ] `spec.browserProxy` declared if the shell will call this app's REST API *(not yet implemented — §5e)*
- [ ] `compositionRef` omitted unless using a non-default composition
- [ ] YAML passes `python3 -c "import yaml; yaml.safe_load(open('<file>'))"` locally
- [ ] Bootstrap/init jobs in `composition.yaml` targeting OpenBao/Vault use `https://...` and `curl -k` (or mount CA cert) to prevent infinite hangs due to TLS requirement (§13)

---

## 13. OpenBao (Vault) Integration in Compositions (Bootstrap Jobs)

When defining bootstrap or initialization Jobs in a composition (`composition.yaml`) that need to communicate directly with the OpenBao/Vault API:

1. **Use HTTPS**: The OpenBao endpoint is TLS-secured. Always set `BAO_ADDR` to `https://openbao.openbao.svc.cluster.local:8200` (not `http://...`).
2. **Handle TLS/Self-Signed Certificate**: Since OpenBao uses a self-signed or internal CA certificate, `curl` commands in your bootstrap scripts must bypass validation using `-k` or `--insecure` (e.g., `curl -k -sf`), or explicitly mount the CA certificate.
3. **Avoid Infinite Hangs**: Always ensure curl or other HTTP client calls fail fast by implementing appropriate timeouts (e.g., `--max-time 10` or `--connect-timeout 5`) so that failure modes are readable in pod logs rather than hanging indefinitely.

Example ConfigMap script pattern:
```bash
BAO_TOKEN=$(curl -k -sf --max-time 10 "${BAO_ADDR}/v1/auth/kubernetes/login" \
  -H 'Content-Type: application/json' \
  -d "{\"role\":\"app-init\",\"jwt\":\"${JWT}\"}" \
  | jq -r '.auth.client_token')
```

### 13a. Post-install bootstrap jobs (`spec.postInstallJob`)

Some apps need bootstrap that can only happen through their own admin API (or
a one-time data read) after the Helm release is up — not something Helm
values alone can express. `AppProfile.spec.postInstallJob` is a **generic**
mechanism in gentian-os for exactly this: declare an image + shell script in
the profile, and the `app-default` composition renders it as a retried Job —
no custom `composition.yaml` required.

**Before reaching for this, check whether gentian-os already does the thing
generically.** gentian-os already provisions per-tenant PostgreSQL/MariaDB
databases, MinIO S3 buckets, and Redis/Memcached caches generically, driven
purely by `AppProfile.spec.kernelRequirements` (see
`internal/controller/{database,storage,cache}_reconciler.go` in gentian-os).
OpenProject's profile once shipped bespoke `s3-init`/`db-init` Jobs in
`composition.yaml` that quietly duplicated exactly this — added months after
the generic mechanism existed, writing to the same OpenBao paths with a
different credential-derivation scheme, running in parallel with the generic
path on every tenant reconcile. They were removed once confirmed redundant.
`spec.postInstallJob` is for what genuinely *isn't* covered generically:
talking to an app's own runtime admin API, not provisioning platform
infrastructure.

**When to use it:**

- The app persists config to its own database on first boot and ignores env
  vars on later restarts, so a wrong first-boot value can only be corrected
  by calling the app's own admin API (open-webui's LiteLLM connection
  settings, for example).
- The fix is small and self-contained enough not to justify a full custom
  `composition.yaml` — if the bootstrap logic needs multiple resources or
  inter-Job ordering, write a real composition instead (as in §13 above).

Fields:

```yaml
spec:
  postInstallJob:
    image: alpine:3.20        # required
    script: |                 # required — run via /bin/sh -c, mounted from a ConfigMap
      #!/bin/sh
      set -eu
      ...
    envFrom:                  # optional — Secret names already present in the tenant namespace
      - llm-credentials-open-webui
    serviceAccountName: app-init   # optional — reuse an existing ServiceAccount + RBAC
    readOnlyPVC:               # optional, rare — mount an existing PVC read-only
      claimName: open-webui
      mountPath: /data
```

`envFrom` only accepts **Secret** names — there is no generic ConfigMap or
literal `env:` passthrough, deliberately: if a script needs cluster-config-
derived values (a MinIO endpoint, a CNPG host), that's a sign it belongs in
`kernelRequirements`/a real composition, not a static per-app script. A
script that needs its own namespace/tenant name can read them at runtime via
the Kubernetes downward file
(`/var/run/secrets/kubernetes.io/serviceaccount/namespace`) or by calling its
own app's Service unqualified (`http://open-webui`, resolved by the
in-namespace DNS search domain) instead of needing them injected.

**Retry / idempotency contract:** the rendered Job uses
`ttlSecondsAfterFinished` + `backoffLimit`, the same pattern as every other
bootstrap Job in this codebase (§13) — once the Job finishes (success or
failure) it's deleted after the TTL, and the next tenant reconcile recreates
it. There is no `dependsOn`/readiness gate between the Job and the rest of
the app's resources, so **the script itself** must:

- Exit non-zero if a dependency isn't ready yet (e.g. no admin user exists in
  the app's DB yet) — the Job simply retries on the next reconcile.
- Be a no-op once the desired state is already correct — check current state
  (e.g. `GET` the app's own config endpoint) before writing, rather than
  blindly re-applying every run.

**Worked example — open-webui:** `profiles/open-webui/profile.yaml`'s
`postInstallJob` mints a short-lived admin JWT itself (HS256, signed with the
same `WEBUI_SECRET_KEY` Open WebUI verifies incoming tokens with, sourced via
`envFrom: [llm-credentials-open-webui]`), reads the admin user id from Open
WebUI's own SQLite DB (`readOnlyPVC`, since no HTTP API can supply it before
authentication exists), and POSTs the correct LiteLLM connection config
through Open WebUI's own admin API. See that profile for the full script.

---

## 14. SaaS Integrations (ApiProfile)

For applications and services that are hosted externally (such as centralized billing, CRM, or external vendor SaaS), Gentian OS supports **ApiProfiles** (`deploymentMethod: api`).

An ApiProfile deploys NO workload pods or Helm releases inside the tenant namespace, but contributes portal shell tiles and ingress routing configurations.

### 14a. Structuring the Profile

Below is a complete template for an ApiProfile:

```yaml
apiVersion: gentianos.io/v1alpha1
kind: AppProfile
metadata:
  name: external-service
spec:
  displayName: "External Service"
  description: "External SaaS integration sample."
  license: proprietary
  
  deploymentMethod: api

  apiIntegration:
    runtime: portal-proxy                # redirect | portal-proxy
    baseUrl: "https://saas.example.com"  # external target URL
    tenantBinding: tenant-domain         # tenant-domain | none

  portalTiles:
    - name: dashboard
      displayName:
        en_US: "Dashboard"
      linkTarget: embedded               # embedded | newwindow
      allowedGroup: "Tenant Admins"
```

### 14b. Runtime Modes

1. **Redirect Mode (`runtime: redirect`):**
   * The portal shell tile directs the user's browser to the external `baseUrl` via a top-level redirect or opens a new tab.
   * If `tenantBinding` is `tenant-domain`, the operator appends `?tenantDomain=<tenant>.<kernel_domain>` to the redirect URL to identify the client workspace.

2. **Portal Proxy Mode (`runtime: portal-proxy`):**
   * The operator configures Gateway API HTTPRoutes for the app's subdomain to forward all incoming traffic to the central **portal BFF API** (`gentian-portal-gentian-portal-api` Service in the tenant namespace on port `8000`).
   * The portal BFF acts as a reverse proxy, receiving requests same-origin from the browser and forwarding them server-side to the external `baseUrl` (injecting `tenantDomain` query arguments if requested).
   * This allows the external SaaS UI to be embedded inside the portal UI in an iframe (`linkTarget: embedded`) safely, avoiding CORS headers and keeping credentials server-side.

