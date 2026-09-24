# Manual install into gentian-app-template

Copy everything in this folder (except this file) into your local clone root.

```bash
cd /path/to/gentian-app-template
tar xzf gentian-app-template.tar.gz --strip-components=1

git add -A
git commit -m "feat: add Gentian app template (FastAPI + React + Helm)"
git push origin main
```

## Layout

```
backend/          FastAPI API
frontend/         React SPA (Vite + TanStack Router/Query + Tailwind)
chart/            Helm chart (Gateway API HTTPRoute)
profile/          AppProfile YAML template (catalogue apps)
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
