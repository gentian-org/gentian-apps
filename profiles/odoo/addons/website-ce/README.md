# odoo-website-ce — withdrawn from the catalogue

This addon is **not synced to any cluster**. Its profile is parked as
`profile.yaml.disabled`, and the ArgoCD ApplicationSet `gentian-catalogue` globs
`profiles/**/profile.yaml`, so nothing here is generated into an `AppProfile`. The
addon selection window lists an addon only when an `AppProfile` declares
`spec.customization.addon.of: odoo-base-ce`, so with no profile in the cluster the
addon does not appear. The repo validators under `scripts/` glob the same pattern
and skip this directory for the same reason.

The content is kept intact so re-enabling is a rename, not a rewrite.

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
