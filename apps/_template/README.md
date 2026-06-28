# Gentian app template

Canonical scaffold for **all Gentian-built UI**: catalogue apps (`gentian-apps/apps/*`)
and the kernel shell (`gentian-ui`). Same stack, same layout; only deployment differs
(AppProfile + tenant install vs kernel ApplicationSet).

**FastAPI** backend · **React** frontend · **Helm** chart · optional **AppProfile**

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
profile/          AppProfile skeleton (catalogue apps; omit for kernel-only repos)
docs/             AGENTS.md, SECURITY.md, FRONTEND-STACK.md
```

## Why React?

Greenfield platform decision: React for agent-assisted development and admin/console
ecosystem. See [docs/FRONTEND-STACK.md](docs/FRONTEND-STACK.md).

## Security

See [docs/SECURITY.md](docs/SECURITY.md) for OIDC, ReBAC hooks, pod hardening, and
what the platform enforces vs what app authors must implement.

## Create a catalogue app

1. Copy this repo to `gentian-apps/apps/<name>/`.
2. Rename chart, images, and `profile/appprofile.yaml.tmpl`.
3. Add `gentian-apps/profiles/<name>/profile.yaml`.
4. See [custom-app-guide.md](https://github.com/gentian-org/gentian-apps/blob/main/custom-app-guide.md).

## Kernel shell (gentian-ui)

Use the same `backend/` + `frontend/` + `chart/` layout. Skip `profile/`; deploy via
`gentian-os` ApplicationSet. Add domain folders under `frontend/src/` (`shell/`,
`windows/`, etc.) as needed.
