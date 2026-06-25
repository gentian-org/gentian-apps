# App Store

Tenant-admin web UI to browse the Gentian app catalogue and install/uninstall apps.

## API

- `GET /api/v1/catalogue/` — available apps (`AppCatalogue` + `AppProfile` metadata)
- `GET /api/v1/tenant/apps/installed`
- `POST /api/v1/tenant/apps/{profile}/install`
- `DELETE /api/v1/tenant/apps/{profile}`
- `GET /api/v1/tenant/apps/{profile}/status`

## Install modes

Install/uninstall/purge are implemented once in **gentian-os** (`internal/applifecycle`)
and exposed via:

| Surface | Entry |
|---------|--------|
| CLI | `gtnctl apps install\|uninstall [--purge]` (also via `kubectl gentian apps …`) |
| HTTP | `GENTIAN_LIFECYCLE_URL` → operator `:8082/v1/tenants/{tenant}/apps/{profile}` |
| App Store API | Thin HTTP client to the operator lifecycle API |

`GENTIAN_LIFECYCLE_BACKEND` / `--backend` selects `kubernetes` (patch Tenant CR) or
`gitops` (edit gentian-deployments).

## Local dev

```bash
docker compose -f docker-compose.dev.yaml up --build
```

Set `AUTH_DISABLED=true` and mock K8s/Git env vars for UI development.
