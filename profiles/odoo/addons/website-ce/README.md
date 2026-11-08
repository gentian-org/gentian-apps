# odoo-website-ce — withdrawn from the catalog

This addon is **not synced to any cluster**. Its profile is parked as
`profile.yaml.disabled`, and the catalog build (`scripts/build-catalogue-source.py`)
and the ArgoCD ApplicationSet `gentian-catalogue` only pick up `profiles/**/profile.yaml`,
so no `ComponentProfile` is generated from this directory. The addon selection
window lists an addon only when a `ComponentProfile` declares
`spec.package.addon.of: odoo-base-ce`, so with no profile in the cluster the addon
does not appear. The repo validators under `scripts/` glob the same pattern and
skip this directory for the same reason.

The parked file is in the retired `AppProfile` format. Re-enabling means rewriting
it as a `ComponentProfile` ([app-profile-guide.md](../../../../docs/app-profile-guide.md)),
not renaming it; the group mapping and the assets are what is worth keeping.

## Why it is parked

Odoo's `website` module serves the public site from the same Odoo instance, on the
same host, as the ERP backend. Installing it takes over the app's own URLs:

| path         | with `website` | without |
| ------------ | -------------- | ------- |
| `/`          | the CMS homepage | `303` → `/odoo` |
| `/web/login` | `500`            | `200` |
| `/odoo`      | `303` → `/web/login` → `500` | `303` → `/web/login` |

The `500` is the website layout rendering for an anonymous request:
`_auth_method_public` resolves no user, and `website._compute_menu` then calls
`ensure_one()` on an empty `res.users()`. The effect is that a tenant that selects
this addon loses its ERP: the portal tile opens a blank frame and the login page
cannot render.

A public website belongs on a host that is not also the ERP backend. That
separation is what the DMZ architecture provides, and this addon stays parked
until it lands.

## Re-enabling

```bash
git mv profile.yaml.disabled profile.yaml
git mv kustomization.yaml.disabled kustomization.yaml
```

Before doing so, the profile needs the serving split from the ERP host — otherwise
the table above is what every tenant that selects it gets.
