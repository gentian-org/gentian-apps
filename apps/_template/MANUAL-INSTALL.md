# Start a new app from apps/_template

`apps/_template` in gentian-apps is the scaffold for every first-party app. Copy it to a
new directory next to it:

```bash
cd /path/to/gentian-apps
cp -a apps/_template apps/my-app
```

Then rename the identifiers as described in
[docs/custom-app-guide.md](../../docs/custom-app-guide.md).

## Layout

```
backend/          FastAPI API
frontend/         React SPA (Vite + TanStack Router/Query + Tailwind)
chart/            Helm chart (Gateway API HTTPRoute)
profile/          AppProfile YAML template (catalog apps)
docs/             AGENTS.md, SECURITY.md, FRONTEND-STACK.md
docker-compose.dev.yaml
README.md
```

## Local dev

```bash
docker compose -f docker-compose.dev.yaml up --build
```

UI: http://localhost:5173  
API: http://localhost:8000/docs
