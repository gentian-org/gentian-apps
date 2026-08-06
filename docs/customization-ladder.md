# Customization Ladder — catalogue operations

The framework, the rung definitions, and the decision procedure live in
**[gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md)**.
Read that first. This page is the `gentian-apps` operational half: where files go, what CI
checks, and how to characterise a new catalogue entry.

## The ladder in one table

| Rung | Name | You own | Where it lives in this repo |
|---|---|---|---|
| **L0** | Configure | nothing | `profiles/<n>/profile.yaml` → `spec.extraValues` |
| **L1** | Drop-in | one file | `profiles/<n>/dropins/` |
| **L2** | Companion | a separate deployable | `apps/<new>/` + `contracts/<c>.yaml` + `profiles/<new>/` |
| **L3** | Extension | a module the app loads | the app's module repo (`odoo-modules`, …) |
| **L4** | Repackage | chart / composition / entrypoint | `charts/<app>/`, `profiles/<n>/composition.yaml` |
| **L5** | Patch | a patch series + rebuilt image | the app's build repo (`ocb`, …) |
| **L6** | Fork | the source tree | a dedicated fork repo |
| **X** | Hotfix | — | **forbidden** — see [app-profile-guide.md](app-profile-guide.md) |

**Pick the lowest rung that can express the change, and the narrowest scope.** Scope is a
separate axis: tenant (`gentian-deployments`) → profile (here) → platform (`gentian-os`,
generic mechanisms only).

## Profile bundle layout

A bundle is any directory containing a `kustomization.yaml`. Singletons sit at
`profiles/<name>/`; members of a multi-profile family sit one level deeper at
`profiles/<family>/<name>/` (e.g. `profiles/odoo/odoo-cb-crm/`). Locate a bundle by its
leaf directory name — which must equal the AppProfile's `metadata.name` — never by
counting path segments.

```text
profiles/[<family>/]<name>/
├── kustomization.yaml      # the marker: this is what makes it a synced bundle
├── profile.yaml            # includes spec.customization — the machine-readable ladder
├── customization.md        # the app's ladder in prose, incl. the rubric score
├── dropins/                # L1 content shipped with the profile (50-89 prefixes)
└── customizations/         # Customization records (CRs) for deltas at L2+
```

Charts and images are deliberately **not** in here — `charts/<name>/` and
`images/<name>/` are separate flat trees, because a chart is referenced by OCI
coordinate rather than path and is frequently shared (`charts/odoo` backs 10 profiles).
See [app-profile-guide.md](app-profile-guide.md) §0.

## Characterising a new app

1. Score the §4.1 rubric by hand (8 criteria, +1 each) — grades are **manual** for v0.4;
   automation is gentian-os roadmap item 2.13.
2. Band it: **A** ≥ 7 · **B** 5–6 · **C** 3–4 · **D** ≤ 2.
3. Write `customization.md` recording the score, the evidence, and per-rung instructions.
4. Fill `spec.customization` in `profile.yaml`. `supportedRungs` must reflect what the app
   really offers — **never list L2**, it is always available and is a property of the
   customization, not of the target.
5. An app with no `spec.customization` is treated as `{grade: unknown, supportedRungs: [L0, L4]}`.
   That is a deliberate floor, not a default to leave in place.

## Customization records

Required from **L2 upward**, written **before** the code. `Customization` is a namespaced CRD
(`gentianos.io/v1alpha1`); records are authored here in git and synced to clusters like any
other catalogue object. The operator computes `status` — review overdue, upstream stale,
version drift, cheaper rung available — which is what the Admin Console debt report reads.

Validate locally:

```bash
python3 scripts/validate-customizations.py
python3 scripts/customization-debt-report.py --format markdown
```

## What CI enforces

| Check | Failure means |
|---|---|
| every `profiles/*/profile.yaml` has `spec.customization` | app not characterised |
| `grade` matches `rubricScore` banding | scoring and grade disagree |
| `supportedRungs` does not contain `L2` | L2 is not a property of the target |
| declared `dropIns[].path` is absolute; `tenantEditable` entries have a `format` | tenants could get an unvalidatable mount |
| every `customizations/*.yaml` parses and satisfies the ladder policy | invalid record |
| `reviewBy` is in the future | customization debt past review |
| rung ≥ L4 records `upstreamFirst.attempted: true` | upstream-first obligation unmet |
| rung ≥ L3 names at least one artifact | record describes nothing |
| justification present for every rung below the chosen one | the ladder was not actually walked |

## Related

- [gentian-os/docs/app-customization.md](https://github.com/gentian-org/gentian-os/blob/main/docs/app-customization.md) — the framework
- [app-profile-guide.md](app-profile-guide.md) — authoring profiles for upstream charts
- [custom-app-guide.md](custom-app-guide.md) — building a first-party app (the L2 path)
