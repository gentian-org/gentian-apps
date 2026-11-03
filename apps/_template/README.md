# Gentian app template

Canonical scaffold for **all Gentian-built UI**: catalog apps (`gentian-apps/apps/*`)
and the kernel shell (`gentian-ui`). Same stack, same layout; only deployment differs
(a ComponentProfile in a catalog vs the kernel's own chart).

**FastAPI** backend · **React** frontend · **Helm** chart · a **ComponentProfile** skeleton

Derived from [full-stack-fastapi-template](https://github.com/tiangolo/full-stack-fastapi-template)
with Gentian packaging (OIDC, Gateway API, Pattern A secrets).

## Quick start

```bash
docker compose -f docker-compose.dev.yaml up --build
```

- UI: http://localhost:5173
- API: http://localhost:8000/docs

## Layout

```
backend/          FastAPI (Python 3.12+)
frontend/         React SPA — Vite, TanStack Router/Query, Zustand, Tailwind
chart/            Helm — HTTPRoute (Gateway API), api + web Deployments
profile/          ComponentProfile skeleton — see below
docs/             AGENTS.md, SECURITY.md, FRONTEND-STACK.md
```

## Why React?

Greenfield platform decision: React for agent-assisted development and admin/console
ecosystem. See [docs/FRONTEND-STACK.md](docs/FRONTEND-STACK.md).

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for OIDC, ReBAC hooks, pod hardening, and
what the platform enforces vs what app authors must implement.

## The profile

`profile/componentprofile.yaml.tmpl` is the skeleton of the `ComponentProfile`, the one
cluster-scoped catalog entry kind. A catalog app and a component the platform places into
tenants (`spec.placement`) are the same kind; the operator installs `spec.package.chart`
as a provider-helm Release in the tenant's namespace, writes the component's
NetworkPolicy from `spec.requires`, renders one HTTPRoute plus one Envoy SecurityPolicy
per gateway entry in `spec.expose`, and tells the chart the facts of the cluster it runs
in through `spec.package.valueMapping.platform`. The one piece of presentation it carries
is the `tile` on an exposure; display name, description and logo are the App Store's.

As shipped, this template runs **behind the platform's edge**: the Gateway holds the
session and the bundle holds nothing. See [docs/AGENTS.md](docs/AGENTS.md) for what the
platform tells the component and how, and
[docs/app-profile-guide.md](https://github.com/gentian-org/gentian-apps/blob/develop/docs/app-profile-guide.md)
for how a profile is written.

## Create a catalog app

1. Copy this repo to `gentian-apps/apps/<name>/`.
2. Rename chart, images, and `profile/componentprofile.yaml.tmpl`.
3. Add `gentian-apps/profiles/<name>/profile.yaml`.
4. See [custom-app-guide.md](https://github.com/gentian-org/gentian-apps/blob/main/custom-app-guide.md).

## Components the platform ships itself

The desktop and the administration console (both in `gentian-ui`, under
`apps/`) are components, not catalog apps: the platform installs one of each for every
tenant from a profile that declares `spec.placement`, rather than a tenant
administrator picking them out of a catalog.

Use the same `backend/` + `frontend/` + `chart/` layout, and **skip
`profile/`**. Their ComponentProfiles live in the gentian-os chart
(`charts/gentian-os/templates/componentprofile-*.yaml`), because the repository
that installs them is the one that should declare them — a second copy here
would be a second answer to the same question, and the one that drifted would
produce an install that reports `ProfileMissing` for a reason nothing explains.

Everything else is the same, so moving either of them into this repository, or
out into one of its own, is a move of files. Add domain folders under
`frontend/src/` (`shell/`, `windows/`, etc.) as needed.
