# AGENTS.md — App Store development conventions

Aligned with [gentian-app-template](https://github.com/gentian-org/gentian-app-template).
See also `docs/SECURITY.md` and `docs/FRONTEND-STACK.md`.

## Directory map

| Path | Purpose |
|------|---------|
| `backend/app/main.py` | FastAPI entrypoint |
| `backend/app/core/` | Config, auth, tenant, authz, logging, OpenFGA client |
| `backend/app/api/routes/catalogue.py` | App catalogue from K8s CRs |
| `backend/app/api/routes/tenant_apps.py` | Install/uninstall via lifecycle API |
| `backend/app/api/routes/oauth.py` | Backend BFF OIDC (iframe-safe sign-in) |
| `backend/app/services/` | GitOps, lifecycle, K8s client, tile resolver |
| `frontend/src/pages/StorePage.tsx` | Main App Store UI |
| `frontend/src/auth/` | AuthProvider + BFF OAuth helpers |
| `chart/` | Helm chart (HTTPRoute, Pattern A `existingSecret`) |
| `profile/appprofile.yaml.tmpl` | AppProfile skeleton |

## Add an API endpoint

1. Create `backend/app/api/routes/<feature>.py` with an `APIRouter`.
2. Register it in `backend/app/main.py`.
3. Protect routes with `Depends(get_current_user)` when tenant-scoped.
4. Use `require_permission()` from `core/authz.py` for sensitive tenant-admin actions.

## Add a React page

1. Add component under `frontend/src/pages/`.
2. Register route in `frontend/src/router.tsx`.
3. Call backend via `apiFetch()` from `frontend/src/api/client.ts`.
4. Gateway API routes `/api` and `/oauth` to the API service; static UI to the web service.

## Auth model

- **Embedded in portal:** `auth.disabled: true` — shell gates tenant-admin access; API uses synthetic admin user.
- **Direct URL access:** backend `/oauth/*` BFF stores tokens in `localStorage`; iframe uses popup sign-in.

## Publish a new app version

1. Bump `chart/Chart.yaml` version and image tags in `chart/values.yaml`.
2. CI builds and pushes images + OCI chart.
3. Update `gentian-apps/profiles/app-store/profile.yaml` `spec.chart.version`.

## Local dev

```bash
docker compose -f docker-compose.dev.yaml up --build
```

Set `AUTH_DISABLED=true` and `VITE_AUTH_DISABLED=true` for UI development without OIDC.
