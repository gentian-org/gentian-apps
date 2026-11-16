# Customization ladder — Uno Calculator (family `uno-calculator`)

**Grade: unknown** · not characterized against the rubric.

Framework: [gentian-os/docs/guides/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/guides/app-customization.md).

A static WebAssembly app with no server side, no configuration surface and no plugin system.

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | barely | `spec.extraValues` → `charts/uno-calculator` (replicas, resources) |
| **L1** Drop-in | no | nothing is read at run time |
| **L2** Companion | always | — the app has no API to integrate with |
| **L3** Extension | no | no plugin system |
| **L4** Repackage | yes | first-party chart and image (`charts/uno-calculator`, `images/uno-calculator`), `chartOwnership: gentian-owned` |
| **L5** Patch | yes | `images/uno-calculator/patches/`, applied to the pinned upstream commit at build; record: [`customizations/no-analytics.yaml`](customizations/no-analytics.yaml) |
| **L6** Fork | no | not permitted |
