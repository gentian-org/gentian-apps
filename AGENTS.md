# AGENTS.md — gentian-apps

## Project overview

`gentian-apps` is the OSS AppProfile catalogue for Gentian OS: profile bundles
(`profiles/<name>/`, synced to clusters by the ArgoCD ApplicationSet `gentian-catalogue`) plus
first-party app implementations (`apps/<name>/`, FastAPI + React + Helm — same stack as
[gentian-app-template](https://github.com/gentian-org/gentian-app-template) /
[gentian-ui](https://github.com/gentian-org/gentian-ui)). See [README.md](README.md) for full
scope and [docs/app-profile-guide.md](docs/app-profile-guide.md) /
[docs/custom-app-guide.md](docs/custom-app-guide.md) for the two main workflows.

## Build & deployment — CI/GitOps only

* CI (`.github/workflows/apps-ci.yaml`) builds and pushes images + OCI charts for `apps/*`.
  `profiles/*` sync to clusters via the ArgoCD ApplicationSet `gentian-catalogue`.
* **Don't build/push images or apply profile changes to a live cluster yourself.** Bump the
  chart version and the profile's `spec.chart.version`, then let CI and ArgoCD do the rest.
  Deleting a stuck Application/resource to speed up reconciliation is fine; hand-patching
  config in the cluster is not.

## Security & licensing

* **Never commit secrets.** Kernel-injected values (`DATABASE_URL`, `OIDC_ISSUER`,
  `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`, etc.) arrive via ExternalSecret at runtime — never
  hardcode or commit them.
* **Respect third-party license terms** for vendored charts (`activepieces/`) and upstream app
  images (Nextcloud, XWiki, Odoo, OpenProject, ...) — check upstream licensing before modifying
  or repackaging.

## First-party app development (`apps/app-store`, `apps/_template`)

Both first-party apps share the FastAPI + React + Helm stack from gentian-app-template.

### Directory map

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
| `profile/appprofile.yaml.tmpl` | AppProfile skeleton |
| `docs/security.md` | Security checklist |
| `docs/frontend-stack.md` | Frontend stack rationale |

### Add an API endpoint

1. Create `backend/app/api/routes/<feature>.py` with an `APIRouter`.
2. Register it in `backend/app/main.py`.
3. Protect routes with `Depends(get_current_user)` when tenant-scoped.
4. Use `require_permission()` (or `Depends(require_permission(...))`) for sensitive tenant-admin
   actions.

### Add a React page

1. Add component under `frontend/src/pages/`.
2. Register route in `frontend/src/router.tsx`.
3. Load server data with TanStack Query via `frontend/src/api/client.ts`.
4. Use Zustand in `frontend/src/stores/` for local UI state.

### Edge routing

Production uses **Gateway API** (`chart/templates/httproute.yaml`), not nginx Ingress. Envoy
Gateway routes `/api`, `/healthz`, `/readyz` to the API Service and `/` to the static web
Service.

### Auth model (app-store)

- **Embedded in portal:** `auth.disabled: true` — shell gates tenant-admin access; API uses a
  synthetic admin user.
- **Direct URL access:** backend `/oauth/*` BFF stores tokens in `localStorage`; iframe uses
  popup sign-in.

### Publish a new app version

1. Bump `chart/Chart.yaml` version and image tags in `chart/values.yaml`.
2. CI builds and pushes images + OCI chart.
3. Update the matching `profiles/<app>/profile.yaml` `spec.chart.version`.
4. AppProfile update reconciler rolls out to tenants.

### Local dev

```bash
docker compose -f docker-compose.dev.yaml up --build
```

`AUTH_DISABLED=true` / `VITE_AUTH_DISABLED=true` skip OIDC locally.

## Adding/editing OSS profiles (`profiles/<name>/`)

Each profile bundle holds `kustomization.yaml` (required), `profile.yaml` (the AppProfile CR —
describe the app there, not in a separate catalogue doc), and optionally `oidc-catalog.yaml`,
`composition.yaml`, `assets/`. See [docs/app-profile-guide.md](docs/app-profile-guide.md) for
the full workflow.
