# AGENTS.md — Gentian app development conventions

Conventions for AI coding agents and humans extending Gentian first-party UI
(catalogue apps **and** kernel shell in `gentian-ui` — same stack).

## Directory map

| Path | Purpose |
|------|---------|
| `backend/app/main.py` | FastAPI entrypoint |
| `backend/app/core/config.py` | Settings from environment (ESO-injected in cluster) |
| `backend/app/core/auth.py` | OIDC JWT validation |
| `backend/app/core/authz.py` | ReBAC PEP hook (OpenFGA / AuthZEN) |
| `backend/app/api/routes/` | HTTP routers |
| `frontend/src/pages/` | Route-level screens |
| `frontend/src/router.tsx` | TanStack Router route tree |
| `frontend/src/api/client.ts` | Typed fetch helpers |
| `frontend/src/stores/` | Zustand client state (when needed) |
| `chart/` | Helm chart (Gateway API HTTPRoute, Pattern A secrets) |
| `profile/appprofile.yaml.tmpl` | AppProfile skeleton (catalogue apps only) |
| `profile/componentprofile.yaml.tmpl` | ComponentProfile skeleton (platform components only) |
| `.github/workflows/build.yaml` | CI — multi-arch images to GHCR, OCI chart publish |
| `docs/SECURITY.md` | Security checklist |

## Customization — build apps others can extend without forking

This template ships a customization surface so apps built from it reach **grade A** on the
Gentian customization ladder: consumers can configure (L0), drop in config (L1), build
companions against the OpenAPI surface (L2), and load plugins (L3) — without ever needing to
patch or fork. See [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md)
and [`customization/README.md`](../customization/README.md).

| Path | Rung | Purpose |
|------|------|---------|
| `chart/values.schema.json` | L0 | makes configuration machine-checkable and discoverable |
| `backend/app/core/dropins.py` | L1 | reads `/etc/gentian/<app>/conf.d/*.yaml` with documented precedence |
| `backend/app/extensions/` | L3 | entry-point plugin loader + the versioned public contract |
| `frontend/src/extensions/` | L3 | named UI slots plugins can contribute to |
| `customization/` | all | the app's own ladder, drop-in docs, example plugin, patch discipline |

**When extending an app** (rather than building one), run the ladder decision procedure first —
do not start by editing source. **When building one**, keep the extension API a real contract:
`EXTENSION_API_VERSION` is semver, supported N-2, deprecations announced one minor ahead, and
unstable surface lives under `proposed/`.

## Which profile this app needs

`AppProfile` and `ComponentProfile` are both cluster-scoped catalogue entries, and the
choice is not cosmetic — it decides which reconciler owns the install.

An **AppProfile** is a catalogue app: a tenant admin installs it by way of
`Tenant.spec.apps`, the app reconciler drives it through a Crossplane App claim, and the
profile carries the portal's presentation (`displayName`, `description`, `tile`) and the
catalogue identity.

A **ComponentProfile** is a component of the platform: the platform installs it for
itself by creating a `Component` that names the profile, and `component_reconciler.go`
turns that into a provider-helm Release, a NetworkPolicy derived from `spec.requires`,
and one HTTPRoute plus one Envoy SecurityPolicy per gateway entry in `spec.expose`. It
carries tenancy (`system`, `shared`, `tenant`), a trust tier, privilege requests a named
person grants on the `Component`, and one piece of presentation: the `tile` on an
exposure, which is how the component appears on the portal and which relation decides
who sees it. A profile that says `defaultForTenants: true` is created in every tenant
without anyone declaring it, which is how the desktop and the administration console
reach everyone.

Only one of the two files belongs in a finished app. Delete the other rather than leaving
a skeleton nobody maintains.

## What the platform tells a component, and how

A component behind the platform's edge cannot discover the facts of the cluster it runs
in, so the platform tells it. The profile's `spec.package.valueMapping.platform` names,
per fact, the Helm value key that receives it, and the operator fills every key a profile
names, for any profile, knowing nothing about who is asking:

| Fact | Key this chart uses | Reaches the API as |
| --- | --- | --- |
| the zone's issuer | `auth.issuer` | `OIDC_ISSUER` |
| the zone's client id | `auth.clientId` | `OIDC_CLIENT_ID` |
| the audience the forwarded token carries | `auth.audience` | `OIDC_AUDIENCE` |
| the tenant | `platform.tenant` | `TENANT_ID` |
| the kernel domain, the realm, the zone kind | `platform.*` | `KERNEL_DOMAIN`, `KERNEL_REALM`, `ZONE_KIND` |
| the director, platform trust only | `director.url`, `director.cluster` | `DIRECTOR_URL`, `GENTIAN_CLUSTER_ID` |

The database requirement is mapped the same way: `valueMapping.database.secretNameKey`
receives the name of the Secret the platform wrote the credentials into, which this chart
consumes whole with `envFrom` (`existingSecret.name`). A key that matches nothing is not
an error anywhere; the value lands where nothing reads it. Rename a key in
`chart/values.yaml` and in the profile together, or in neither.

## Auth mode: edge

As shipped, the profile's `extraValues` set `auth.mode: edge`. The platform's Gateway
holds the session with the zone's confidential client and, on an exposure that says
`forwardToken`, puts the zone's token on the request. The bundle runs no code flow, holds
no token and no client secret; `getAccessToken()` returns null and `apiFetch` sends no
bearer. The API verifies the forwarded token against the zone's issuer and requires the
director's audience, and relays it to the director (`backend/app/core/director.py`) when
it needs an answer about the caller. What the caller may do is the director's answer,
never this component's. `forwardToken` requires `trustTier: platform`; an ordinary app
leaves it off and gets identity headers instead.

`pkce` remains for a component deployed outside the platform: the bundle runs the code
flow itself (a stub in this template; a real app exchanges the code through its backend
with PKCE, never with a client secret in the browser).

Runtime configuration reaches the bundle through `/config.js`, rendered by
`frontend/docker-entrypoint.sh` from the environment at container start. Never bake an
issuer into the image with `VITE_*`: Vite freezes those into the bundle and one image
serves every cluster.

## Add an API endpoint

1. Create `backend/app/api/routes/<feature>.py` with an `APIRouter`.
2. Register it in `backend/app/main.py`.
3. Protect routes with `Depends(get_current_user)` when tenant-scoped.
4. Use `Depends(require_permission(...))` for sensitive ops once OpenFGA is wired.

## Add a React page

1. Add component under `frontend/src/pages/`.
2. Register route in `frontend/src/router.tsx`.
3. Load server data with TanStack Query; call `/api/v1/...` via `api/client.ts`.
4. Use Zustand in `frontend/src/stores/` for local UI state (windows, selection, etc.).

## Kernel secrets (cluster)

Never commit secrets. Credentials arrive in a Secret the platform writes (Pattern A) and the
chart consumes it with `envFrom` under `existingSecret.name`: `DATABASE_URL`, and for a
component that runs its own login, `OIDC_CLIENT_SECRET`. Nothing else in the environment
is a secret; the issuer, client id and audience are facts, mapped as described above.

Map keys in `profile/appprofile.yaml.tmpl` `valueMapping` — or `spec.package.valueMapping`
in `profile/componentprofile.yaml.tmpl` — must match Helm `values.yaml`. A key that matches
nothing is not an error anywhere: the value lands where nothing reads it.

## Edge routing

Under a ComponentProfile the operator writes the routes: one HTTPRoute and one Envoy
SecurityPolicy per gateway entry in `spec.expose`, on the zone's Gateway, behind the
zone's session. The chart's own `httproute.yaml` is off (`gateway.enabled: false`) because
a route written beside the operator's would be a second, unguarded way in. The Services the
profile routes to are the ones this chart creates, `<release>-<chart>-api` and
`<release>-<chart>-web`, where the release is the Component's name. Turn the chart's route
on only for a deployment nothing reconciles. See [docs/SECURITY.md](./SECURITY.md).

## Publish a new app version

1. Bump `chart/Chart.yaml` version.
2. Merge to the publish branch. `.github/workflows/build.yaml` builds the api and web
   images for amd64 and arm64, rewrites the image tags in `chart/values.yaml` to this
   build's immutable tag, and pushes the chart to the OCI registry. Branches build but
   never publish, because publishing is what rolls a cluster over.
3. Update the profile's chart version — `spec.chart.version` for an AppProfile,
   `spec.package.chart.version` and `spec.version` for a ComponentProfile.
4. The AppProfile update reconciler rolls tenants over; a component rolls over when its
   `Component`'s profile names the new chart version.

## Local dev

```bash
docker compose -f docker-compose.dev.yaml up --build
```

- UI: http://localhost:5173 (Vite dev server proxies `/api` to FastAPI)
- API: http://localhost:8000/docs

`AUTH_DISABLED=true` skips OIDC locally.
