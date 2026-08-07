# Gentian Nextcloud image

One image extending the official [`library/nextcloud`](https://hub.docker.com/_/nextcloud)
Apache variant. Published as `ghcr.io/gentian-org/nextcloud:<IMAGE_TAG>` (see
`versions.env`). No runtime downloads from the Nextcloud App Store or GitHub are
needed on tenant clusters.

## Why one image and not four

This used to build four cumulative targets — `base` → `office` → `officeplus` →
`suite` — each baking more apps into `/usr/src/nextcloud/apps/`, which *enables*
them. That allowed exactly four combinations, so a tenant wanting files and calendar
but not office editing could not have it.

Now every optional app is staged in `/usr/src/nextcloud/custom_apps/` instead.
Nextcloud does not run an app merely because it is present — it has to be enabled —
so one image serves any subset: the addon activation Job runs `occ app:enable <id>`
for exactly what the tenant selected.

The official entrypoint copies `/usr/src/nextcloud` into the tenant volume on first
start, and `custom_apps` is already a registered writable `apps_path` there, so this
needs no chart change.

## Always enabled

| Component | Why |
|-----------|-----|
| `user_oidc` | Platform SSO. Not optional, so it stays in `apps/`. |

## Staged, disabled — selected per tenant

Each maps to an addon profile under `profiles/nextcloud/addons/`, whose
`spec.customization.addon.id` is the id passed to `occ app:enable`.

| App | Addon profile |
|-----|---------------|
| `richdocuments` | `nextcloud-richdocuments-ce` |
| `forms` | `nextcloud-forms-ce` |
| `mail` | `nextcloud-mail-ce` |
| `calendar` | `nextcloud-calendar-ce` |
| `contacts` | `nextcloud-contacts-ce` |
| `tasks` | `nextcloud-tasks-ce` |
| `deck` | `nextcloud-deck-ce` |
| `collectives` | `nextcloud-collectives-ce` |
| `spreed` | `nextcloud-spreed-ce` |

The old `drive` / `office` / `suite` bundles survive as **AppPackage presets** in
`profiles/nextcloud/packages/` — they pre-tick a set of addons in the selection
window rather than freezing it into an image.

## Versions

All pinned in `versions.env` and passed as build args. Bump there, not in the
Dockerfile.

## Build

```bash
./build.sh          # honours REGISTRY, defaults to ghcr.io
```

See gentian-apps/docs/L3-cleanup.md §4.
