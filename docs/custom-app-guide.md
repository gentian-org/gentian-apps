# Custom App Guide — build a Gentian-native application

This guide walks through creating a **new first-party app** (FastAPI + React) and
publishing it to the Gentian App Store. To package an **existing application** with a
profile and, where needed, a thin chart, see [app-profile-guide.md](app-profile-guide.md);
its practices apply to the profile written here as well.

## Prerequisites

- A running Gentian OS cluster (see [gentian-os/GETTING-STARTED.md](https://github.com/gentian-org/gentian-os/blob/main/GETTING-STARTED.md))
- A clone of `gentian-org/gentian-apps` with push access — the scaffold is
  [`apps/_template`](../apps/_template)

## Repository layout

First-party app **source** lives in this monorepo:

```text
gentian-apps/
├── apps/<app-id>/                   # implementation (backend, frontend, chart)
└── profiles/<app-id>/<app-id>-ce/   # the ComponentProfile bundle: profile.yaml, kustomization.yaml, assets/
```

The cluster never mounts Git source. CI builds **pinned container images** and an
**OCI Helm chart**; the profile references the chart by `spec.package.chart.version`.

## Step 1 — Scaffold from template

```bash
cd gentian-apps
cp -a apps/_template apps/my-app
cd apps/my-app
```

Rename identifiers:

| File | Change |
|------|--------|
| `chart/Chart.yaml` | `name: my-app`, bump `version` |
| `chart/values.yaml` | image repositories `ghcr.io/gentian-org/my-app-api` etc. |
| `profile/componentprofile.yaml.tmpl` | replace `COMPONENT_ID` |

## Step 2 — Implement features

### Backend (`backend/app/`)

- Add routes under `api/routes/`
- Read secrets from environment (injected by ExternalSecret / ESO)
- Use `Depends(get_current_user)` for tenant-scoped endpoints
- Expose `/healthz` and `/readyz`

### Frontend (`frontend/src/`)

- Build UI with React + Vite + Tailwind
- Call `/api/v1/...` (ingress routes `/api` to the API service in cluster)

### Local development

```bash
docker compose -f docker-compose.dev.yaml up --build
```

`AUTH_DISABLED=true` skips OIDC for local testing.

See [AGENTS.md](../AGENTS.md) for agent-oriented conventions.

## Step 3 — Helm chart

Requirements for Gentian:

1. **Pattern A** — chart consumes `existingSecret` (see `chart/values.yaml`)
2. **Probes** on `/healthz` and `/readyz`
3. **ServiceAccount + RBAC** if the app talks to the Kubernetes API
4. Pin `image.tag` in `values.yaml` (semver for releases)

## Step 4 — The profile

Copy `profile/componentprofile.yaml.tmpl` to `profiles/my-app/my-app-ce/profile.yaml`,
add the sibling `kustomization.yaml` and `assets/tile.png`, and set what
[app-profile-guide.md](app-profile-guide.md) describes:

- the `SPDX-License-Identifier:` first line and the three `gentianos.io/profile-*` labels (§3)
- `requires.services` (typically `database` and, for an app that runs its own login, `identity.oidc`; this
  template runs behind the edge and needs no client of its own) (§3.2, §5)
- `package.valueMapping` keys aligned with the chart's values (§4.2)
- one `expose` entry with `subDomain`, the chart's Service as `backend`, and a `tile` (§7)
- `customization` (§12)

Validation is what CI runs; locally, `python3 scripts/build-catalogue-source.py --check`
and the `scripts/validate-*.py` the guide lists (§13).

## Step 5 — CI and publish

`.github/workflows/apps-ci.yaml` builds changed apps under `apps/`.

On merge to `main` (from `develop` the same artifacts go out under develop names —
[releasing.md](releasing.md)):

1. Docker images → `ghcr.io/gentian-org/<app>-api:<version>`
2. Helm chart → `oci://ghcr.io/gentian-org/charts/<app>:<version>`
3. Point the profile's `spec.package.chart.version` at the published chart and bump `spec.version`

## Step 6 — Install for a tenant

**CLI (fallback):**

```bash
kubectl gentian apps install my-app --tenant gtn-demo
```

**App Store:** the tile on an administrator's desktop. It opens the store, which runs outside the cluster.

## Who sees the tile

The tile's `relation` says who: `can_launch` on the app for its users, `can_administer`
with `object: tenant` for a tile only the tenant's administrators see. An app every
cluster installs on its own rather than from the store is annotated
`gentianos.io/store-listed: "false"`; one the platform places into tenants declares
`spec.placement` (app-profile-guide.md §7.2, gentian-os app-catalog.md §13.3).

## Related

- [app-profile-guide.md](app-profile-guide.md) — how a profile is written
- [gentian-os/docs/concepts/app-catalog.md](https://github.com/gentian-org/gentian-os/blob/main/docs/concepts/app-catalog.md)
