# Customization ladder — Gentian Subscriptions (family `gentian-subscriptions-me`)

**Grade: B** · rubric score **5/8** · characterised 2026-08-06
**First-party app** built from `gentian-app-template`.

Framework: [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md).

## Rubric

| Criterion | Score | Evidence |
|---|---|---|
| Documented config reference | 1 | `core/config.py` + chart values |
| Declared drop-in directories | 1 | `/etc/gentian/gentian-subscriptions-me/conf.d` |
| Documented plugin/addon API | 0 | template extension loader not yet adopted |
| Plugin API versioned + deprecation policy | 0 | — |
| Published HTTP API with a spec | 1 | FastAPI → OpenAPI |
| Upstream accepts patches | 1 | we are upstream |
| Plugin ABI survives minor releases | 0 | no plugin ABI yet |
| Test harness for plugin authors | 1 | the app's own pytest suite |

## Reachable rungs

| Rung | Available | How, here |
|---|---|---|
| **L0** Configure | yes | `spec.extraValues` |
| **L1** Drop-in | yes | `app-config` (`/etc/gentian/gentian-subscriptions-me/conf.d`, yaml) |
| **L2** Companion | always | the app's OpenAPI surface |
| **L3** Extension | **not yet** | adopt the template entry-point loader to unlock |
| **L4** Repackage | yes | Gentian-owned chart |
| **L5/L6** | n/a | we own the source |

## Commercial logic belongs in the ERP

Pricing, invoicing and customer records live in the CRM/ERP, not here — see
`business-logic-plan.md`. A customization request phrased as "change how we bill for X" is
usually a request against Odoo (grade A, L3 available), not against this app. Check the target
before walking the ladder.
