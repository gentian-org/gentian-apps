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
  odoo/                #   family with addons (L3)
    base/
      base-ce/         #       dir is short; the AppProfile is odoo-base-ce
    addons/
      crm-ce/          #       -> odoo-crm-ce
      accounting-ce/   #       -> odoo-accounting-ce
    packages/          #       AppPackage presets (not deployable)
  nextcloud/           #   family with addons (L3)
    base/
      base-ce/         #       -> nextcloud-base-ce
      base-od/         #       -> nextcloud-base-od (openDesk, ee)
    addons/            #       9 addons, enabled per tenant
      calendar-ce/     #       -> nextcloud-calendar-ce
    packages/          #       AppPackage presets: office, suite
  xwiki/               #   true singleton: stays flat
apps/                  # first-party implementations (FastAPI + React + Helm)
  _template/           # copy of gentian-app-template
  app-store/           # tenant admin App Store UI
charts/                # Helm charts published to oci://ghcr.io/gentian-org/charts
  activepieces/        # pinned upstream (adnoctem/helm) + patch series — no copy
  odoo/                # Gentian-authored chart for OCB — backs all 10 odoo profiles
  gentian-sidecar-*/   # sidecar charts referenced by profiles
images/                # Dockerfiles published to ghcr.io
contracts/             # integration contract schemas
icons/                 # shared SVG assets
```

**Discovery:** catalogue = `profiles/` · implementation = `apps/<name>/` · chart = `charts/<name>/`

A profile bundle is identified by its **`profile.yaml`**, at any depth. The catalogue
ApplicationSet names each Application after the AppProfile's **`metadata.name`**, not after the
directory — so directories can be short (`addons/crm-ce` holds `odoo-crm-ce`) and CI enforces
that `metadata.name` is globally unique rather than that it matches the folder. Every bundle
also needs a `kustomization.yaml`, since it is rendered with kustomize.

`apps/` is only for first-party apps we build. A chart that wraps an upstream image — vendored
or Gentian-authored — belongs in `charts/<name>/`, and its profile references it by OCI
coordinates, not by path. Charts and images are **not** nested inside profiles: `charts/odoo`
backs 10 profiles, and 7 profiles wrap external charts this repo never contains. See
[docs/app-profile-guide.md](docs/app-profile-guide.md) §0 for why this repo is organised as a
distribution repo rather than an application monorepo.

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
