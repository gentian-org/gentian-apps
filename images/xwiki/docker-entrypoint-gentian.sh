#!/bin/bash
# Gentian XWiki wrapper entrypoint.
#
# The stock xwiki image ships NO wiki flavor: on a fresh (empty) database the
# Distribution Wizard would ask an admin to download+install one, which is
# impossible in a locked-down tenant with no internet egress. This wrapper
# stages the baked Standard Flavor offline repository (XIP) into the persistent
# extension repository on first boot, so the headless Distribution Job
# (distribution.job.interactive=false + distribution.defaultUI) installs the
# flavor entirely offline.
#
# The flavor bits live in the tenant Postgres DB + the xwiki-data PVC once
# installed; Kubernetes does NOT copy image content into an (empty) PVC, so the
# staging has to happen at runtime. It re-runs automatically on any fresh
# cluster/tenant (empty PVC) and is a no-op once staged (marker file), which is
# what makes the flavor install reproducible across a full teardown.
#
# The xwiki-helm chart both *sources* this script (to import the stock
# entrypoint's shell functions) and later *execs* it with "xwiki" (to start
# Tomcat). Both happen with the PVC mounted, so we stage first and then delegate
# to the renamed stock entrypoint in either case.

GENTIAN_XIP="/opt/gentian/xwiki-flavor.xip"
GENTIAN_REPO="/usr/local/xwiki/data/extension/repository"
GENTIAN_MARKER="${GENTIAN_REPO}/.gentian-flavor-staged"

if [ -f "${GENTIAN_XIP}" ] && [ ! -e "${GENTIAN_MARKER}" ]; then
  echo "[gentian] Staging baked XWiki Standard Flavor into ${GENTIAN_REPO} ..."
  mkdir -p "${GENTIAN_REPO}"
  # -n: never overwrite existing extensions already present on the PVC.
  if unzip -n -q "${GENTIAN_XIP}" -d "${GENTIAN_REPO}"; then
    touch "${GENTIAN_MARKER}"
    echo "[gentian] Flavor staged; headless Distribution Job will install it offline."
  else
    echo "[gentian] WARNING: flavor staging failed — the Distribution Wizard may appear." >&2
  fi
fi

# Hand off to the stock XWiki entrypoint (defines functions when sourced with no
# args; starts Tomcat when invoked as 'xwiki').
source /usr/local/bin/docker-entrypoint-xwiki.sh "$@"
