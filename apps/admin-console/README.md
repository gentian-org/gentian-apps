# Gentian administration console

The console an MSP employee or an IT administrator uses to configure a tenant
and, for a platform administrator, the cluster underneath. It is a component
of the platform, built from
[gentian-app-template](https://github.com/gentian-org/gentian-app-template),
and a client of the gentian-os director: every screen reads through the
director and writes through it, and what a person may see or change is the
director's answer from the authorization graph. The console itself holds no
credential, keeps no state, and decides nothing.

## Layout

```
backend/    FastAPI. Verifies the token the platform's edge forwards, relays it to the
            director, hands the answer back unchanged. backend/app/api/routes/admin.py
            also lists every screen not yet re-pointed at the director.
frontend/   React. The screens under src/admin/, the design tokens they use under
            design-system/, and a root that mounts the console as the whole page.
chart/      Helm. Two Deployments and two Services, named from fullnameOverride so the
            profile can route to them.
```

## How it is deployed

By the gentian-os operator, from the `ComponentProfile` named `admin-console` that
the operator chart ships (`charts/gentian-os/templates/componentprofile-admin-console.yaml`).
The profile declares `defaultForTenants: true`, so every tenant gets one, at
`admin.<zone domain>`, behind the zone's session, and the desktop shows it as a
tile to whoever holds `can_administer` on the tenant. The profile maps the facts
of the cluster into this chart's values; nothing about the cluster is configured
here.

There is no profile in this repository on purpose. The profile is the
platform's statement about the component, and it lives with the platform.

## Where the screens stand

The console was carved out of the desktop, where its screens reached Keycloak
and Kubernetes through the desktop's backend with credentials this component
must not hold. Screens are re-pointed at the director one at a time. Until a
screen's director endpoints exist, its routes answer 501 naming the screen, and
the console shows that. `NOT_YET_MAPPED` in `backend/app/api/routes/admin.py` is
the list.

Working today: Tenants, Cluster settings, and People, which is a link into
Keycloak's own console. Everything else is on the list.

## Local development

```bash
docker compose -f docker-compose.dev.yaml up --build
```

Runs the API with authentication off and the frontend under Vite. Without a
director reachable, every screen that asks it reports that the director is not
configured, which is the truthful state.
