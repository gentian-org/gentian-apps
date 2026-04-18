# gentian-apps

App Store catalogue for Gentian OS — cluster-scoped `AppProfile` CRs synced to
the cluster by ArgoCD.

## Structure

```
profiles/
  collabora.yaml       # Collabora Online (WOPI document editor)
```

## Adding an app

Create a new `AppProfile` YAML in `profiles/`. ArgoCD syncs it automatically
via Source 3 in `gentian-deployments/dev/app-of-apps.yaml`. The Gentian OS
`AppStoreReconciler` picks it up and adds it to the `AppCatalogue`.

```bash
# Verify the catalogue after sync:
kubectl gentian apps list
```

## Related repos

| Repo | Purpose |
|---|---|
| `gentian-os` | Orchestrator, CRDs, Helm chart |
| `gentian-deployments` | Per-environment config, Tenant CRs, ArgoCD app-of-apps |
| `gentian-apps` | This repo — app store catalogue (AppProfile CRs) |
