# gentian-apps

App Store catalogue for Gentian OS — `AppProfile` CRs plus first-party app implementations.

**This is the single source of truth for AppProfile catalogue metadata — OSS *and* commercial.**
Commercial (OpenDesk-packaged) profiles live here too, marked `license: proprietary`; they
render with a **Buy** button pointing at the Gentian organization's checkout (gentian-corp),
and the operator gates install on entitlement, not on catalogue visibility. The private
chart/image artifacts those profiles reference come from
[gentian-pro](https://github.com/gentian-org/gentian-pro), which does **not** sync its own
catalogue — it's being migrated to hold only those artifacts.

## Structure

```text
profiles/              # App catalogue bundles (OSS + commercial) — synced by Argo CD gentian-catalogue
  nextcloud/
  app-store/
apps/                  # first-party implementations (FastAPI + React + Helm)
  _template/           # copy of gentian-app-template
  app-store/           # tenant admin App Store UI
charts/                # Helm charts published to oci://ghcr.io/gentian-org/charts
  activepieces/        # vendored upstream chart (adnoctem/helm), patched
  odoo/                # Gentian-authored chart for OCB
  gentian-sidecar-*/   # sidecar charts referenced by profiles
contracts/             # integration contract schemas
icons/                 # shared SVG assets
```

**Discovery:** catalogue = `profiles/` · implementation = `apps/<name>/` · chart = `charts/<name>/`

`apps/` is only for first-party apps we build. A chart that wraps an upstream image — vendored
or Gentian-authored — belongs in `charts/<name>/`, and its profile references it by OCI
coordinates, not by path.

## Guides

| Guide | Audience |
|-------|----------|
| [docs/app-profile-guide.md](docs/app-profile-guide.md) | Publish an **existing** Helm chart (profile YAML only) |
| [docs/custom-app-guide.md](docs/custom-app-guide.md) | Build a **new** Gentian-native app end-to-end |

## Adding an upstream app

Add `profiles/<app>/` (see [docs/app-profile-guide.md](docs/app-profile-guide.md)).

```bash
kubectl gentian apps list
```

## Adding a first-party app

1. Copy `apps/_template/` → `apps/<name>/`
2. Implement backend + frontend + chart
3. Add `profiles/<name>/profile.yaml` (+ `kustomization.yaml`)
4. CI (`.github/workflows/apps-ci.yaml`) publishes images + OCI chart

See [docs/custom-app-guide.md](docs/custom-app-guide.md).

## Related repos

| Repo | Purpose |
|------|---------|
| [gentian-os](https://github.com/gentian-org/gentian-os) | Orchestrator, CRDs, kernel |
| [gentian-deployments](https://github.com/gentian-org/gentian-deployments) | Per-environment tenant state |
| [gentian-pro](https://github.com/gentian-org/gentian-pro) | Private chart/image artifacts for commercial (OpenDesk) profiles |
| [gentian-app-template](https://github.com/gentian-org/gentian-app-template) | Scaffold for new apps |
| [gentian-ui](https://github.com/gentian-org/gentian-ui) | Portal shell |
