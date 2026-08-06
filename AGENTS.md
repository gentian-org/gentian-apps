# AGENTS.md — gentian-apps

## Project overview

`gentian-apps` is **the single source of truth for AppProfile catalogue metadata** for Gentian
OS — profile bundles (`profiles/<name>/`, synced to clusters by the ArgoCD ApplicationSet
`gentian-catalogue`) plus first-party app implementations (`apps/<name>/`, FastAPI + React +
Helm — same stack as [gentian-app-template](https://github.com/gentian-org/gentian-app-template) /
[gentian-ui](https://github.com/gentian-org/gentian-ui)). This includes commercial
(`license: proprietary`) profiles, not just OSS ones — [gentian-pro](https://github.com/gentian-org/gentian-pro)
holds only the private chart/image artifacts those profiles reference, it does not sync its own
catalogue. See [README.md](README.md) for full scope and
[docs/app-profile-guide.md](docs/app-profile-guide.md) /
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
* **Respect third-party license terms** for vendored charts (`charts/activepieces/`) and upstream app
  images (Nextcloud, XWiki, Odoo, OpenProject, ...) — check upstream licensing before modifying
  or repackaging.

## Customizing an installed app — walk the ladder first

**Before adding a feature to an app that already exists, run this procedure.** Do not start
from "which file do I edit" — start from "what is the cheapest rung that can express this".
Full framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md);
local operations: [docs/customization-ladder.md](docs/customization-ladder.md).

1. **Restate** the request as a capability ("users must approve invoices > 10k"), not an
   implementation ("patch `account_move.py`"). Split multi-part requests and run this per part.
2. **Read the app's ladder**: `AppProfile.spec.customization` in `profiles/<n>/profile.yaml`,
   and `profiles/<n>/customization.md`. If absent, assume `{grade: unknown, supportedRungs:
   [L0, L4]}` and raise a task to characterise the app — infer nothing more.
3. **Walk L0 → L6 in order.** Stop at the first rung that (a) can express the change,
   (b) is in `supportedRungs` (L2 is always available), and (c) is permitted at the requested
   scope. Record a one-line reason for every rung skipped.
4. **Tie-break L2 vs L3**: if the function must appear inside the app's own UI or extend its
   data model, L3; otherwise L2. Default to L2 when `extension.apiStability` is not `stable`.
5. **Gate**: at **L4 or above**, search upstream first, record what you found, and **stop for
   human approval** — do not proceed autonomously. At L5+ platform trust tier and a named
   owner are also required. A cluster hotfix is never a valid outcome.
6. **Minimise scope** independently of rung: tenant → profile → platform.
7. **Write the `Customization` record before the code** (`profiles/<n>/customizations/<name>.yaml`),
   required from L2 up. It is the design review.
8. **Emit into the repo that owns that rung** (table in `docs/customization-ladder.md`), never
   into a live cluster.
9. **Test** per the rung's CI obligation, then `python3 scripts/validate-customizations.py`.
10. **Report**: chosen rung, scope, rungs skipped and why, upgrade risk, review date, and what
    breaks this at the next upstream release.

Rung → where it lives here: L0 `spec.extraValues` · L1 `profiles/<n>/dropins/` ·
L2 `apps/<new>/` plus a contract · L3 the module repo (`odoo-modules`, …) ·
L4 `charts/` or `composition.yaml` · L5 the build repo (`ocb`) · L6 a fork repo.

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

## Adding/editing profiles (`profiles/<name>/`, OSS or commercial)

Each profile bundle holds `kustomization.yaml` (required), `profile.yaml` (the AppProfile CR —
describe the app there, not in a separate catalogue doc), and optionally `oidc-catalog.yaml`,
`composition.yaml`, `assets/`. Commercial profiles set `spec.license: proprietary`; the App
Store surfaces those with a Buy button and the operator gates install on entitlement. See
[docs/app-profile-guide.md](docs/app-profile-guide.md) for the full workflow.
