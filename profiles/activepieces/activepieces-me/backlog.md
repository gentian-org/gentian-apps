# Activepieces Backlog

## Goal: Custom Pieces via Vendored Image Rebuild

Community Edition has no runtime way to install a custom piece: uploading a `.tgz` via Platform Admin is an Enterprise-only feature (`PRIVATE_PIECES_ENABLED: false` on our instance, and the official docs mark that upload flow with an enterprise-feature badge). The only CE-compatible path is building the piece into the image itself, the same way the 204 bundled official pieces ship.

## Implementation Plan (Custom Pieces)

### 1. Add the Piece Source to the Vendored Chart's Image Build

- Write the custom piece under `packages/pieces/community/<name>` in the activepieces-me source used to build our image (mirrors how other apps in this repo vendor/patch upstream sources, see [AGENTS.md](file:///home/christian/develop/gentian-apps/AGENTS.md)).
- Build with `npm run pieces -- build --name=<name>` and confirm it's picked up locally before touching CI.

### 2. Republish the Image and Chart

- Bump the activepieces-me image tag/chart version so the new piece is actually included in what's pulled (mirrors the versioning gotcha from the encryption-secret fix earlier — an unbumped version won't get republished).

### 3. Verify Against `AP_PIECES_SOURCE=FILE`

- Confirm the new piece shows up in the piece picker with `pieces.source: FILE` (already set in [profile.yaml](file:///home/christian/develop/gentian-apps/profiles/activepieces-me/profile.yaml)) without needing any cloud/DB sync.
