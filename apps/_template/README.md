# Gentian app template

Canonical scaffold for **all Gentian-built UI**: catalogue apps (`gentian-apps/apps/*`)
and the kernel shell (`gentian-ui`). Same stack, same layout; only deployment differs
(AppProfile + tenant install vs kernel ApplicationSet).

**FastAPI** backend · **React** frontend · **Helm** chart · optional **AppProfile** or **ComponentProfile**

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
profile/          AppProfile and ComponentProfile skeletons — see below for which
docs/             AGENTS.md, SECURITY.md, FRONTEND-STACK.md
```

## Why React?

Greenfield platform decision: React for agent-assisted development and admin/console
ecosystem. See [docs/FRONTEND-STACK.md](docs/FRONTEND-STACK.md).

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for OIDC, ReBAC hooks, pod hardening, and
what the platform enforces vs what app authors must implement.

## AppProfile or ComponentProfile?

Both are cluster-scoped catalogue entries in `gentian-os`, and this repo ships a skeleton
for each. What separates them is who installs the thing and what the operator then does.

Use **`profile/appprofile.yaml.tmpl`** for a **catalogue app** — something a tenant admin
picks and installs into their own tenant. It is installed by listing it in
`Tenant.spec.apps`, the app reconciler takes it through a Crossplane App claim, and the
profile carries what the portal has to show: `displayName`, `description`, `tile`, portal
tiles, and the catalogue identity (family, catalogue version, edition, licence).

Use **`profile/componentprofile.yaml.tmpl`** for a **component of the platform itself** —
a system service, app or agent that the platform installs for itself by creating a
`Component` that names the profile. The component reconciler installs
`spec.package.chart` as a provider-helm Release in the component's namespace, writes the
component's NetworkPolicy from `spec.requires`, renders one HTTPRoute plus one Envoy
SecurityPolicy per gateway entry in `spec.expose`, and tells the chart the facts of the
cluster it runs in through `spec.package.valueMapping.platform`. The one piece of
presentation it carries is the `tile` on an exposure, which is how the component appears
on the portal and which relation decides who sees it. What it has besides is a tenancy
model (`system`, `shared`, `tenant`), a trust tier that gates shared tenancy and
edge-token forwarding, privilege requests that a named person answers on the `Component`
before the install proceeds, and `defaultForTenants`, for a component every tenant gets.

As shipped, this template runs **behind the platform's edge**: the Gateway holds the
session and the bundle holds nothing. See [docs/AGENTS.md](docs/AGENTS.md) for what the
platform tells the component and how.

If this repo builds a tenant-installable app, you want the first. If it builds something
the platform runs as part of itself — the desktop is the worked example, in
`gentian-os/charts/gentian-os/templates/componentprofile-desktop.yaml` — you want the
second.

## Create a catalogue app

1. Copy this repo to `gentian-apps/apps/<name>/`.
2. Rename chart, images, and `profile/appprofile.yaml.tmpl`.
3. Add `gentian-apps/profiles/<name>/profile.yaml`.
4. See [custom-app-guide.md](https://github.com/gentian-org/gentian-apps/blob/main/custom-app-guide.md).

## Components the platform ships itself

The desktop (`gentian-ui`) and the administration console (`apps/admin-console`)
are components, not catalogue apps: the platform installs one of each for every
tenant from a profile that declares `defaultForTenants`, rather than a tenant
administrator picking them out of a catalogue.

Use the same `backend/` + `frontend/` + `chart/` layout, and **skip
`profile/`**. Their ComponentProfiles live in the gentian-os chart
(`charts/gentian-os/templates/componentprofile-*.yaml`), because the repository
that installs them is the one that should declare them — a second copy here
would be a second answer to the same question, and the one that drifted would
produce an install that reports `ProfileMissing` for a reason nothing explains.

Everything else is the same, so moving either of them into this repository, or
out into one of its own, is a move of files. Add domain folders under
`frontend/src/` (`shell/`, `windows/`, etc.) as needed.
