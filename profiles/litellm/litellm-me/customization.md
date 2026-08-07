# Customization ladder — LiteLLM (family `litellm-me`)

**Grade: B** · rubric score **5/8** · characterised 2026-08-06

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `config.yaml` proxy reference |
| Declared drop-in directories | 1 | the proxy config directory |
| Documented plugin/module API | 1 | custom callbacks / custom auth handlers loaded from config |
| Plugin API versioned + deprecation policy | 0 | no published deprecation policy; the project moves fast |
| Published HTTP API with a spec | 1 | OpenAI-compatible API |
| Upstream accepts patches | 1 | active PR flow |
| Plugin ABI survives minor releases | 0 | callback signatures have changed across releases |
| Test harness for plugin authors | 0 | none packaged |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` — model lists, routing, budgets |
| **L1** Drop-in | yes | `litellm-config` (proxy config directory, yaml). **Not** tenant-editable: model routing and budgets are a platform cost control |
| **L2** Companion | always | the OpenAI-compatible API is the intended integration surface |
| **L3** Extension | yes, cautiously | a custom callback or auth handler, delivery `image-layer` |
| **L4** Repackage | yes | chart + composition; `spec.postInstallJob` seeds proxy config |
| **L5** Patch | **no** | not permitted |
| **L6** Fork | **no** | not permitted |

## Prefer L0/L1, then L2

Almost every LiteLLM request is a routing or budget change, which is L0. The callback API
exists but has an unstable signature (see the two zeroes above) — if you reach for L3, pin
`testMatrix` and treat each upstream bump as a re-verification.

`litellm-config` is deliberately **not** tenant-editable: model routing determines who can
spend platform money on which provider, and that is not a tenant self-service decision.
