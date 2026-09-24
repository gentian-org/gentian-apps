# Customizing this app

This app is built from `gentian-app-template` and ships a customization surface so
you can change its behaviour **without patching or forking it**.

The rungs below come from the Gentian customization ladder — the full framework, the
decision procedure, and the record format live in
[gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

> **Pick the lowest rung that can express your change.** The cost of a customization is
> not writing it — it is writing it again at every release.

## What this app supports

| Rung | Available | How |
|---|---|---|
| **L0** Configure | yes | Helm values, validated against `chart/values.schema.json` |
| **L1** Drop-in | yes | YAML fragments in `/etc/gentian/<app-id>/conf.d/` — see [dropins/](dropins/) |
| **L2** Companion | always | build against the OpenAPI schema at `/api/v1/openapi.json` |
| **L3** Extension | yes | a Python plugin and/or UI slot contributions — see [extensions/](extensions/) |
| **L4** Repackage | yes | the chart is ours; prefer values and drop-ins first |
| **L5/L6** Patch / Fork | n/a | we own the source — send a PR instead |

Paste [`profile-block.yaml`](profile-block.yaml) into the app's `AppProfile` so this is
machine-readable for the App Store and for agents.

## L0 — Configure

Set values. `chart/values.schema.json` documents every knob and is enforced at install
time, so a typo fails immediately rather than at pod start.

## L1 — Drop in configuration

Fragments are merged in lexicographic order, systemd-style. The numeric prefix decides
who wins:

| Prefix | Owner |
|---|---|
| `00-`–`49-` | platform |
| `50-`–`89-` | profile / catalogue maintainer |
| `90-`–`99-` | tenant (self-service, via the Admin Console) |

Full precedence chain: image defaults → chart values → profile `extraValues` → profile
drop-ins → tenant `extraValues` → tenant drop-ins.

Security-relevant settings (`auth_disabled`, `cors_origins`, credentials) are **not**
readable from drop-ins by design — they come from `Settings` only. A drop-in must never
be able to turn authentication off.

Inspect what is actually applied: `GET /api/v1/extensions`.

## L2 — Build a companion

If your feature can stand alone, build a separate app against this one's API and wire
it with an `IntegrationBinding`. This is the rung that survives major upgrades untouched.

## L3 — Write a plugin

Use this when the feature must live *inside* the app — its routes, its UI, its data.
See [extensions/README.md](extensions/README.md) and the working example in
[extensions/example_plugin/](extensions/example_plugin/).

The extension API is a **versioned contract**: semver, N-2 major support, deprecations
announced one minor ahead, unstable surface confined to `proposed/`.

## Recording what you did

Every customization at **L2 or above** needs a `Customization` record, written *before*
the code — it is the design review. Put records for deltas this app itself carries in
[customizations/](customizations/), and records for deltas against *other* apps in that
app's profile bundle.

## Patches

[patches/](patches/) exists so that if this app ever does carry a patch against a
dependency, it is carried with discipline (DEP-3 headers, an ordered series, an owner and
a review date). `patches/series` is empty by default — **a non-empty series is a debt
signal**, not a normal state.
