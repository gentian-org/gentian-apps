# gentian-apps

App Store catalogue for Gentian OS — cluster-scoped `AppProfile` CRs synced to
the cluster by ArgoCD.

## Structure

```
profiles/
  element.yaml         # Element (Matrix chat) — deploy with jitsi for room widgets
  jitsi.yaml           # Jitsi (video conferencing)
  openproject.yaml     # OpenProject (project management)
  ox-appsuite.yaml     # OX App Suite (groupware)
  xwiki.yaml           # XWiki (wiki and knowledge management)
  ...
```

## Adding an app

See [app-profile-guide.md](app-profile-guide.md) for authoring guidelines,
best practices, and a pre-PR checklist. It documents every class of bug
that has appeared in the git history of this repo.

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
