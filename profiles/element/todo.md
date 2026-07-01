# Element — OS / platform follow-ups

## Jitsi sidecar (Kyverno)

openDesk Jitsi images require root for s6 init (`runAsUser: 0` on web/prosody/jicofo/jvb in `profile.yaml`). `gentian-require-non-root` blocks the sidecar Helm release until a **profile-driven** exception exists in gentian-os (not app-name hardcoding). Upstream non-root images (UID 1993) crash with `s6-mkdir: Permission denied`.

## Uninstall identity cleanup

On uninstall (non-purge), Matrix/Synapse identity rows for the tenant were previously removed by hardcoded `element` logic in gentian-os applifecycle. That was removed.

**Needed in gentian-os:** `AppProfile` lifecycle hook (e.g. postgres identity cleanup) invoked from applifecycle uninstall, keyed off profile metadata—not `req.Profile == "element"`.

## Already in gentian-apps

UVS bootstrap hook timeout: `composition.yaml` sets `deletePodsOnSuccess: false` on the bootstrap release.
