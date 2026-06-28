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
| `docs/SECURITY.md` | Security checklist |

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

Never commit secrets. The orchestrator injects via ExternalSecret:

- `DATABASE_URL`, `OIDC_ISSUER`, `OIDC_CLIENT_ID`, `OIDC_CLIENT_SECRET`

Map keys in `profile/appprofile.yaml.tmpl` `valueMapping` must match Helm `values.yaml`.

## Edge routing

Production uses **Gateway API** (`chart/templates/httproute.yaml`), not nginx Ingress.
Envoy Gateway routes `/api`, `/healthz`, `/readyz` to the API Service and `/` to the
static web Service. See [docs/SECURITY.md](./SECURITY.md).

## Publish a new app version

1. Bump `chart/Chart.yaml` version and image tags in `chart/values.yaml`.
2. CI builds and pushes images + OCI chart.
3. Update `gentian-apps/profiles/<app>.yaml` `spec.chart.version`.
4. AppProfile update reconciler rolls out to tenants.

## Local dev

```bash
docker compose -f docker-compose.dev.yaml up --build
```

- UI: http://localhost:5173 (Vite dev server proxies `/api` to FastAPI)
- API: http://localhost:8000/docs

`AUTH_DISABLED=true` skips OIDC locally.
