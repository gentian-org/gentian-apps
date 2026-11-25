# Customization ladder — Super Productivity (family `super-productivity`)

**Grade: unknown** · not characterized against the rubric.

Framework: [gentian-os/docs/guides/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/guides/app-customization.md).

A browser app with no server side of its own. The image adds the shared server (`images/app-host`) in relay mode: it serves the build and passes the app's WebDAV sync into one folder of the person's files at the tenant's home, and its CalDAV calls to the person's calendars at the tenant's calendar home. One change to upstream's files fills in the CalDAV form in advance. The app's settings are each person's own, kept in their browser;
the server has nothing to configure but its port and size.

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | barely | `spec.extraValues` → `charts/super-productivity` (replicas, resources) |
| **L1** Drop-in | no | nothing on the server is read per tenant |
| **L2** Companion | always | — the app has no server-side API to integrate with |
| **L3** Extension | no | the app's own plugins are installed by each person in their browser, not by the platform |
| **L4** Repackage | yes | first-party chart and image (`charts/super-productivity`, `images/super-productivity`), `chartOwnership: gentian-owned`; upstream's build is served unchanged |
| **L5** Patch | no | not permitted — no build pipeline for a patched image exists |
| **L6** Fork | no | not permitted |
