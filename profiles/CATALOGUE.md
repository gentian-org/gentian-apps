# Gentian app catalogue layout

Each OSS app is a **profile bundle** under `profiles/<name>/`, synced to the cluster by
ArgoCD ApplicationSet **`gentian-catalogue`**.

OpenDesk profiles (`od-*`) live in **[gentian-pro](https://github.com/gentian-org/gentian-pro)**
and sync via **`gentian-catalogue-pro`**.

## Layout

```
profiles/<name>/
  kustomization.yaml    # required — ArgoCD entrypoint
  profile.yaml          # AppProfile CR (tenant-installable apps)
  oidc-catalog.yaml     # OIDCPackCatalog CR (optional — apps with Path B OIDC packs)
  composition.yaml      # Crossplane Composition (optional — custom MR graph)
  assets/               # optional cluster-scoped manifests (ConfigMaps, …)
  jitsi-overlay/        # optional source files (built into assets via kustomize)
```

Tenant apps require `profile.yaml`. Apps that need custom Keycloak scopes and
protocol mappers (Path B OIDC) also ship `oidc-catalog.yaml` in the same bundle.

| Profile | composition | cluster assets |
|---------|-------------|----------------|
| `app-store` | — (`app-default`) | — |
| `nextcloud-base` | — (`app-default`) | portal bridge SSO assets |
| `nextcloud-office` | — (`app-default`) | portal bridge SSO assets |
| `nextcloud-office-plus` | — (`app-default`) | portal bridge SSO assets |
| `nextcloud-suite` | — (`app-default`) | portal bridge SSO assets |
| `openproject` | `app-openproject` | portal bridge assets |
| `odoo-cb-base` | — (`app-default`) | — |
| `xwiki` | — (`app-default`) | — |

OpenDesk-flavoured profiles (`od-*`) are in **gentian-pro** — see
[gentian-pro/profiles/CATALOGUE.md](https://github.com/gentian-org/gentian-pro/blob/main/profiles/CATALOGUE.md).

Public/community charts keep short names (`nextcloud`, `openproject`, `odoo-cb-base`, …).

## Adding a simple app

1. Create `profiles/<name>/profile.yaml` (AppProfile only).
2. Add `profiles/<name>/kustomization.yaml` listing `profile.yaml`.
3. Merge — ArgoCD creates `catalogue-<name>` and syncs.

## Adding a complex app (OpenDesk-style)

1. Same as above, plus `composition.yaml` referenced from `spec.compositionRef`.
2. Optional `oidc-catalog.yaml` when the app needs Path B OIDC packs.
3. Optional `assets/` or `configMapGenerator` entries for cluster prerequisites.
