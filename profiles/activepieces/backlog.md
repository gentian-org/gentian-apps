# Activepieces Backlog

## Goal: Direct GitHub Sync for Private Repositories with NetworkPolicy Exceptions

Currently, the `git-sync` sidecar clones from a local git daemon mirror (`git://192.168.0.100:9418/gentian-pieces`) to bypass namespace egress block and private repository authentication. We want to transition this to sync directly from the remote GitHub repository (`https://github.com/gentian-org/gentian-pieces.git`).

## Implementation Plan

### 1. Add NetworkPolicy Egress Rules
- Scoped egress rules should be added to the `AppProfile`'s `security.egress` configuration to allow HTTPS (port 443) traffic to GitHub.

### 2. Implement Private Git Authentication in `git-modules` Sidecar
- Extend the `gentian-sidecar-git-modules` Helm chart to support mounting a Git credentials Secret (SSH private key or GitHub Personal Access Token).
- The secret should be provisioned securely in the tenant namespace and bound to the sidecar pod environment/volumes.

### 3. Update the AppProfile Reference
- Update [profile.yaml](file:///home/christian/develop/gentian-apps/profiles/activepieces/profile.yaml) to point `git.repoUrl` directly to the GitHub repository and supply the credentials reference.
