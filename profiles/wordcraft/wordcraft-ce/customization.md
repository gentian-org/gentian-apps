# Customization ladder — WordCraft (family `wordcraft`)

**Grade: unknown** · not characterized against the rubric.

Framework: [gentian-os/docs/guides/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/guides/app-customization.md).

A static WebAssembly app with no server side and no server-side configuration.

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | barely | `spec.extraValues` → `charts/wordcraft` (replicas, resources) |
| **L1** Drop-in | no | nothing is read at run time |
| **L2** Companion | yes | a page of the same origin can frame the app and hand it files (upstream's host messages, `HOSTING.md` in the web build) |
| **L3** Extension | no | none used here |
| **L4** Repackage | yes | first-party chart and image (`charts/wordcraft`, `images/wordcraft`), `chartOwnership: gentian-owned` |
| **L5** Patch | no | the release's web build is served unchanged |
| **L6** Fork | no | not permitted |
