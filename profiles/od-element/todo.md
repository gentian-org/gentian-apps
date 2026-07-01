# Element — OS / platform follow-ups

## Jitsi sidecar (Kyverno)

openDesk Jitsi images require root for s6 init (`runAsUser: 0` on web/prosody/jicofo/jvb in `profile.yaml`).

**Implemented (Stage 2):**

1. `spec.security.macWaivers` on this profile requests `gentian-require-non-root` for `sidecar-jitsi`.
2. Cluster admin approves via **Admin Console → Platform** (`PlatformSecurityPolicy.spec.allowedMacWaivers`).
3. Operator intersects request ∩ allowlist and publishes `gentian-platform-security` ConfigMap.
4. `app-od-element` composition stamps `gentianos.io/mac-waiver/gentian-require-non-root: approved` on Jitsi `podLabels` when approved.
5. Kyverno `gentian-require-non-root` excludes pods with that label (no PolicyException subsystem).

## Uninstall identity cleanup

On uninstall (non-purge), Matrix/Synapse identity rows for the tenant were previously removed by hardcoded `element` logic in gentian-os applifecycle. That was removed.

**Needed in gentian-os:** `AppProfile` lifecycle hook (e.g. postgres identity cleanup) invoked from applifecycle uninstall, keyed off profile metadata—not `req.Profile == "element"`.

## Already in gentian-apps

UVS bootstrap hook timeout: `composition.yaml` sets `deletePodsOnSuccess: false` on the bootstrap release.
