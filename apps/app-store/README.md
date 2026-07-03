# App Store

Tenant-admin web UI to browse the Gentian app catalogue and install/uninstall apps.

Scaffold follows [gentian-app-template](https://github.com/gentian-org/gentian-app-template):
Gateway API HTTPRoute (no in-pod nginx), security modules (`tenant`, `authz`, logging), TanStack Router frontend.

## API

- `GET /api/v1/catalogue/` — available apps (`AppCatalogue` + `AppProfile` metadata; `tier`, `catalogueAction`, `checkoutUrl` for Pro apps)

## Commercial (Pro) apps

Apps with `AppProfile.spec.license: proprietary` (typically from **gentian-pro**) appear in the
same catalogue grid as community apps. Pro cards use warmer styling and a **Buy** button;
community cards are visually subdued with **Free** and **Install**.

| Env | Purpose |
|-----|---------|
| `GENTIAN_COMMERCE_ENABLED` | Enable checkout URLs and gentian-corp catalogue merge |
| `GENTIAN_CORP_API_URL` | Entitlement lookup (`action: install` vs `buy`) |
| `GENTIAN_CORP_CHECKOUT_URL` | Buy button redirect base |
| `TENANT_DOMAIN` | Tenant effective domain for checkout query params |

Set these on the app-store API deployment (Helm `gentian.commerceEnabled`, `gentian.corpApiUrl`,
`gentian.corpCheckoutUrl`, and chart `tenantDomain`). Pro install via API returns `402` until
gentian-corp reports entitlement.

- `GET /api/v1/tenant/apps/installed`
- `POST /api/v1/tenant/apps/{profile}/install`
- `DELETE /api/v1/tenant/apps/{profile}`
- `GET /api/v1/tenant/apps/{profile}/status`

## App lifecycle

Install/uninstall/purge are implemented once in **gentian-os** (`internal/applifecycle`)
via **GitOps** (edit `gentian-deployments`, commit, push, Argo CD sync, wait).

| Surface | Entry |
|---------|--------|
| CLI | `gtnctl apps install\|uninstall [--purge]` (also via `kubectl gentian apps …`) |
| HTTP | `GENTIAN_LIFECYCLE_URL` → operator `:8082/v1/tenants/{tenant}/apps/{profile}` |
| App Store API | Thin HTTP client to the operator lifecycle API |

The App Store Install button and `kubectl gentian apps install` run the same flow.

## Local dev

```bash
docker compose -f docker-compose.dev.yaml up --build
```

Set `AUTH_DISABLED=true` and mock K8s/Git env vars for UI development.
