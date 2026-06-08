# AGENTS.md

Guidance for AI agents working in this repository.

## What this repo is

`gentian-apps` is a **configuration-only** App Store catalogue for [Gentian OS](https://github.com/). It contains cluster-scoped `AppProfile` Custom Resources (YAML in `profiles/`) that ArgoCD syncs into a Kubernetes cluster. There is **no application source code, package manager, or local dev server** in this repo.

Full end-to-end testing requires a bootstrapped Gentian OS cluster (`gentian-os` + `gentian-deployments`), not processes started from this workspace.

## Local development workflow

Authoring and review happen against the YAML profiles and [app-profile-guide.md](app-profile-guide.md).

### Validate profiles (primary dev task)

```bash
# Syntax check (per-file, from the pre-PR checklist)
python3 -c "import yaml; yaml.safe_load(open('profiles/<app>.yaml'))"

# Validate all profiles at once
for f in profiles/*.yaml; do
  python3 -c "import yaml; yaml.safe_load(open('$f'))" && echo "OK: $f"
done
```

### Query profile metadata with yq

The VM provides the Python `yq` (jq-for-YAML) wrapper:

```bash
yq '.metadata.name, .spec.displayName, .spec.ingress.subDomain' profiles/element.yaml
```

### Lint / test / build

| Task | Command | Notes |
|------|---------|-------|
| Lint | N/A | No linter configured in this repo |
| Test | YAML validation above | Structural checks follow `app-profile-guide.md` §12 |
| Build | N/A | No build step |
| Run | N/A | Profiles deploy via ArgoCD on a Gentian OS cluster |

### Pre-PR checklist

Before opening a PR, verify every item in **§12 of [app-profile-guide.md](app-profile-guide.md)** — especially `deploymentMethod: crossplane`, placeholder usage (`${TENANT_DOMAIN}`, `${KERNEL_DOMAIN}`, etc.), and no forbidden ingress CSP annotations.

## Catalogue apps

| Profile | App | subDomain |
|---------|-----|-----------|
| `element.yaml` | Element (Matrix) + Jitsi sidecar | `chat` |
| `openproject.yaml` | OpenProject | `projects` |
| `ox-appsuite.yaml` | OX App Suite | `webmail` |
| `xwiki.yaml` | XWiki | `wiki` |

## Related repos

| Repo | Purpose |
|------|---------|
| `gentian-os` | Orchestrator, CRDs, Helm chart, `install.sh` |
| `gentian-deployments` | Per-environment config, Tenant CRs, ArgoCD app-of-apps |
| `gentian-apps` | This repo — app store catalogue |

## Cursor Cloud specific instructions

- **Dependencies:** Python 3 with PyYAML only. No `npm`, `go`, or `pip install -r` in this repo.
- **No services to start locally.** Do not attempt `docker compose up`, `kubectl apply`, or cluster bootstrap from this workspace unless the user explicitly provides cluster access.
- **kubectl is not required** for profile authoring; it is only needed on a Gentian OS cluster to verify sync (`kubectl gentian apps list`).
- **Validation is the hello-world task** for this repo: parse all `profiles/*.yaml`, confirm `kind: AppProfile`, `deploymentMethod: crossplane`, and label/name consistency.
- **yq** on the VM is the Python jq-wrapper (`pip install yq`), not mikefarah/yq. Use it for ad-hoc YAML queries; PyYAML is preferred for validation scripts.
