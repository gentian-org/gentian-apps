# Frontend stack

**React + Vite + TypeScript + Tailwind** is the Gentian standard for all first-party
UI — catalogue apps and kernel shell.

## Libraries (canonical)

| Concern | Library |
|---------|---------|
| Routing | TanStack Router (`frontend/src/router.tsx`) |
| Server state | TanStack Query |
| Client state | Zustand (`frontend/src/stores/`) |
| Styling | Tailwind 4 + Gentian design tokens |
| API calls | `frontend/src/api/client.ts` |

## Primary rationale

Agent-assisted development: React/TSX has the largest training corpus; agents produce
correct pages, forms, and data flows more reliably than Vue SFCs.

## Production serving

The web container serves the Vite build with `serve` on port **8080**. **No nginx.**
Envoy Gateway (HTTPRoute) splits `/api` → API Service and `/` → web Service.

## Related

- [AGENTS.md](./AGENTS.md)
- [security.md](./security.md)
