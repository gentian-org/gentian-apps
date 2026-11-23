# Customization ladder — Element Web (`element-ce`)

**Grade: C** · rubric score **3/8**

Framework: [gentian-os/docs/guides/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/guides/app-customization.md).

This profile is the chat client in the browser and nothing else. The homeserver it talks to is
Synapse, a profile of its own that comes with it: [synapse-ce](../../synapse/synapse-ce/customization.md).
A request about accounts, rooms, sign-in, mail or server behavior belongs there.

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `config.json` |
| Declared drop-in directories | 1 | `config.json` keys through the `element-config` drop-in |
| Documented plugin/addon API | 0 | Element Web has no plugin API |
| Plugin API versioned + deprecation policy | 0 | none |
| Published HTTP API with a spec | 0 | none of its own; the API is the homeserver's |
| Upstream accepts patches | 1 | active PR flow |
| Plugin ABI survives minor releases | 0 | no plugin ABI |
| Test harness for plugin authors | 0 | none |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` → `ananace/element-web` chart values, `config` becomes `config.json` |
| **L1** Drop-in | yes | `element-config` (`config.json`, tenant-editable for branding keys only) |
| **L2** Companion | always | a widget or an app speaking the homeserver's Matrix Client-Server API |
| **L3** Extension | **no** | there is no plugin system for the Element web client |
| **L4** Repackage | yes | upstream chart, values only |
| **L5** Patch | **no** | not permitted |
| **L6** Fork | **no** | not permitted |

## The asymmetry that matters

Anything the request phrases as "change how the chat *client* behaves" is **not** L3 — Element
Web has no plugin API. The options are L1 (`config.json` knobs, including branding and feature
flags) or L2 (a companion widget/app). Rebuilding the Element bundle to inject behavior is L5
and is not permitted here; treat a request that seems to need it as a signal to redesign toward
a widget.

## Gotchas

- The homeserver address in `config.json` is `https://matrix.<tenant domain>`, written from
  `defaultServer`; changing it is L0, not L1.
- The image sends its own `X-Frame-Options` and `frame-ancestors`; the operator owns the frame
  policy of every route and replaces them (`app-profile-guide.md` §7.1).
