# Gentian app catalogue layout

Each app is a **profile bundle** under `profiles/<name>/`, synced to the cluster by
ArgoCD ApplicationSet **`gentian-catalogue`** (one Application per bundle).

## Layout

```
profiles/<name>/
  kustomization.yaml    # required — ArgoCD entrypoint
  profile.yaml          # AppProfile CR (tenant-installable apps)
  catalog.yaml          # platform catalogue CR (e.g. OIDCPackCatalog) — no profile.yaml
  composition.yaml      # Crossplane Composition (optional — custom MR graph)
  assets/               # optional cluster-scoped manifests (ConfigMaps, …)
  jitsi-overlay/        # optional source files (built into assets via kustomize)
```

Tenant apps require `profile.yaml`. Platform catalogue bundles (e.g.
`opendesk-oidc-catalog`) ship a cluster-scoped CR via `catalog.yaml` instead.

| Profile | composition | cluster assets |
|---------|-------------|----------------|
| `app-store` | — (`app-default`) | — |
| `xwiki` | — | — |
| `openproject` | `app-openproject` | — |
| `ox-appsuite` | `app-ox` | — |
| `element` | `app-element` | Jitsi OIDC overlay ConfigMap |
| `opendesk-oidc-catalog` | — | OpenDesk OIDC pack catalogue CR |
| `odoo-free-base` | — (`app-default`) | — |
| `nextcloud` | — (`app-default`) | — |

## Adding a simple app

1. Create `profiles/<name>/profile.yaml` (AppProfile only).
2. Add `profiles/<name>/kustomization.yaml` listing `profile.yaml`.
3. Merge — ArgoCD creates `catalogue-<name>` and syncs.

## Adding a complex app (OpenDesk-style)

1. Same as above, plus `composition.yaml` referenced from `spec.compositionRef`.
2. Add any cluster prerequisites under `assets/` or `configMapGenerator` in kustomization.
3. No gentian-os install hooks — GitOps delivers the whole bundle.

## Installing for a tenant

Unchanged: append the profile name to `Tenant.spec.apps` in `gentian-deployments`.

Crossplane uses `app-default` or the profile's `compositionRef` when provisioning the tenant.
