# Patches (rung L5)

**`series` is empty, and should stay that way.** This app's source is ours — a change
that would be a patch elsewhere is simply a commit here. This directory exists for the
case where the app must carry a delta against a *dependency* it does not own.

A non-empty `series` is a debt signal that belongs in the customization debt report.

## Rules

1. Pristine upstream is pinned in `UPSTREAM`; patches apply on top, in `series` order.
2. Every patch carries DEP-3 headers. `Forwarded:` is **not** optional.
3. CI fails the dependency version bump if `series` no longer applies cleanly — that
   failure is the point: it forces a decision instead of silent drift.
4. Each patch needs a `Customization` record with an owner, exit criteria, and a
   review date.
5. Never patch to bypass licence validation or unlock paid features.

## DEP-3 header template

```
Description: <what this changes and why>
Author: <team@gentian.org>
Origin: other, <url>
Bug-Upstream: <upstream issue url>
Forwarded: <url | no | not-needed>
Applied-Upstream: no
Last-Update: <YYYY-MM-DD>
```

`Forwarded: no` requires a written reason in the record. `not-needed` is only valid for
Gentian-specific integration glue upstream would rightly decline.
