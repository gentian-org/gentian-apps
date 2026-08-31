# Activepieces Backlog

## Goal: Custom Pieces via Vendored Image Rebuild

Community Edition has no runtime way to install a custom piece: uploading a `.tgz` via Platform Admin is an Enterprise-only feature (`PRIVATE_PIECES_ENABLED: false` on our instance, and the official docs mark that upload flow with an enterprise-feature badge). The only CE-compatible path is building the piece into the image itself, the same way the 204 bundled official pieces ship.

## Implementation Plan (Custom Pieces)

### 1. Add the Piece Source to the Vendored Chart's Image Build

- Write the custom piece under `packages/pieces/community/<name>` in the activepieces-me source used to build our image (mirrors how other apps in this repo vendor/patch upstream sources, see [AGENTS.md](file:///home/christian/develop/gentian-apps/AGENTS.md)).
- Build with `npm run pieces -- build --name=<name>` and confirm it's picked up locally before touching CI.

### 2. Republish the Image and Chart

- Bump the activepieces-me image tag/chart version so the new piece is actually included in what's pulled (mirrors the versioning gotcha from the encryption-secret fix earlier — an unbumped version won't get republished).

### 3. Verify Against `AP_PIECES_SOURCE=FILE`

- Confirm the new piece shows up in the piece picker with `pieces.source: FILE` (already set in [profile.yaml](file:///home/christian/develop/gentian-apps/profiles/activepieces-me/profile.yaml)) without needing any cloud/DB sync.

---

## Future Backlog: An L3 Route for SSO Routing

`nginx-sso-routing` is the one L4 record this profile carries. L4 is the most
expensive rung it supports, and this entry exists so the question "could it be
lower?" has a written answer rather than being re-derived by whoever next reads
the patch series.

### L3 exists for this app — it just cannot carry this concern

The profile already declares a stable L3 surface:

```yaml
extension:
  mechanism: activepieces-piece
  delivery: [git-sidecar, image-layer]
  addonPath: /usr/src/app/modules
  apiStability: stable
```

Pieces are Activepieces' documented, versioned extension system, and
["Custom Pieces via Vendored Image Rebuild"](#goal-custom-pieces-via-vendored-image-rebuild)
above is the work to use it. But a piece extends **flows** — it contributes
actions and triggers a user assembles inside the builder. It cannot register an
HTTP route, intercept a request before the app's own router, or influence
process startup. The SSO work needs exactly those: `/api/v1/authn/saml/{login,acs}`
routed to the sso-saml sidecar, and an entrypoint that serves the config doing it.

So the rung is not L4 because the app lacks an extension system. It is L4
because this app's extension system extends the wrong layer, which is the
distinction `rungJustification.L3` on the record already makes.

### What would have to change upstream

Any one of these would open an L3 (or lower) route, in rough order of likelihood:

1. **A documented reverse-proxy drop-in.** If the image gained a
   `conf.d/*.conf`-style include that upstream promises to keep, the routing half
   becomes **L1**, not L3 — a drop-in against a documented path, which is cheaper
   than an extension. This is the outcome worth wanting.
2. **A pre-router authentication hook.** An upstream extension point invoked
   before request routing — an auth middleware registry, say — would let a piece
   or module claim the SAML paths, which is a genuine L3.
3. **First-class CE SAML.** If SAML stopped being an Enterprise gate, the sidecar
   and its routing both go and the record retires rather than descends. Watch
   `AP_EDITION` gating in release notes; note the licensing section on the record
   — the CE posture is deliberate and must not be circumvented.

### What is already reducible without any of that

The record's `exitCriteria` names two startup patches that are L5 residue inside
this L4 and can go independently of anything upstream does:

- `gentian.startup.injectSessionScript` → an nginx `sub_filter` injecting the
  same script, once `ngx_http_sub_module` is confirmed present in the image.
- `gentian.startup.disableUpgradeBanner` → denying egress to
  `raw.githubusercontent.com`, since the fetch is already wrapped in a
  try/catch returning `"0.0.0"`. This patch matches a literal string in a
  minified bundle and so fails silently on any upstream rebuild — it is the
  most fragile thing in the series and the best candidate to remove first.

Both are values, so each can be switched off and verified on its own.

### Why `delivery` is absent from the record

`Customization.spec.delivery` describes how an **L3 module** reaches a running
app, and its enum is the four L3 mechanisms. An L4 record delivers through its
repackaged chart by definition, so there is nothing for the field to say. It
previously read `delivery: chart`, which is not a member of that enum, and the
API server rejected the whole object — the customization was never created and
none of the debt signals the operator derives from it (review overdue, upstream
stale, version drift) existed for this app. If item 2 above ever lands, the
record descends to L3 and `delivery` becomes meaningful for the first time.
