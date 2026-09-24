# AGENTS.md — gentian-admin-console

## What this is

The administration console of Gentian OS, a component of the platform and a
client of the gentian-os director. Read the top-level README first.

## Rules that bind work here

* **The console holds nothing.** No Keycloak credential, no Kubernetes access,
  no database, no OpenFGA client. If a screen needs an answer, the director
  answers it; if the director has no endpoint for it yet, the screen says so
  (see `NOT_YET_MAPPED` in `backend/app/api/routes/admin.py`). Adding a
  credential or a cluster read to this backend is the wrong fix every time.
* **Relay verbatim.** `backend/app/core/director.py` forwards the caller's own
  token and hands back the director's status and body unchanged, including a
  refusal. A 403 means the caller does not hold the relation; softening it here
  would be the console inventing an authorisation answer it may not give.
* **Screens follow relations, never a role string.** `/api/v1/admin/context`
  is built from the director's `tenants/{t}/me` and `clusters/{c}/me`. A screen
  appears because of what those answers say and for no other reason. Hiding a
  screen is never what stops someone reaching what is behind it.
* **The design is the desktop's.** Screens keep the shape they had in the
  desktop; the flat tab strip in `frontend/src/admin/AdminConsole.tsx` is the
  console's structure. Change what a screen reads and writes, not how the
  console is organised, unless asked.
* **The profile lives with the platform.** This repository ships no
  ComponentProfile. The platform's statement about this component is in
  gentian-os, and the facts of the cluster arrive through its value mapping.

## Re-pointing a screen at the director

1. Add the director endpoint(s) in gentian-os, under a relation, reading git
   and committing to it; the operator acts on what is committed.
2. Add the relay route(s) in `backend/app/api/routes/`, using
   `director.forward`, and remove the screen's entries from `NOT_YET_MAPPED`.
3. Point the screen's API functions in `frontend/src/api/` at the relay, keeping
   the response shapes the screen already renders.
4. Test the relay the way `backend/tests/test_cluster_settings.py` does: the
   caller's token reaches the director, and the director's answer comes back
   unchanged.

## Build and publish

By this repository's `.github/workflows/apps-ci.yaml`, job `build-admin-console`,
the same way the app-store is built: images to `ghcr.io/gentian-org/admin-console-{api,web}`
tagged with the version in `chart/values.yaml`, and the chart to
`oci://ghcr.io/gentian-org/charts` at the version in `chart/Chart.yaml`, published from
main and develop only. Bump both together; the profile in gentian-os pins that version.
