#!/usr/bin/env bash
# Cluster-scoped assets for the element profile composition.
# Invoked by gentian-os install/update when AppProfile.spec.assetsScript is set.
set -euo pipefail

overlay_dir="${PROFILE_DIR}/jitsi-overlay"
if [[ ! -d "${overlay_dir}" ]]; then
    echo "element apply-assets: jitsi-overlay directory missing (${overlay_dir})" >&2
    exit 1
fi

kubectl create configmap gentian-jitsi-oidc-overlays \
    -n crossplane-system \
    --from-file="${overlay_dir}" \
    --dry-run=client -o yaml \
    | kubectl label --local -f - \
        gentianos.io/config-type=jitsi-oidc-overlays \
        app.kubernetes.io/managed-by=gentian-os-install \
        --dry-run=client -o yaml \
    | kubectl apply -f - >/dev/null

echo "element apply-assets: gentian-jitsi-oidc-overlays ConfigMap applied"
