#!/bin/sh

# Environment variables:
# GIT_REPO_URL - The URL of the git repository to clone
# GIT_BRANCH - The branch to clone (default: main)
# SYNC_DIR - The target directory for the cloned repo (default: /usr/src/app/modules)
# SYNC_INTERVAL - Seconds between pulls (default: 60)

GIT_REPO_URL=${GIT_REPO_URL:-""}
GIT_BRANCH=${GIT_BRANCH:-"main"}
SYNC_DIR=${SYNC_DIR:-"/usr/src/app/modules"}
SYNC_INTERVAL=${SYNC_INTERVAL:-60}

if [ -z "$GIT_REPO_URL" ]; then
  echo "[ERROR] GIT_REPO_URL is not set. Exiting."
  exit 1
fi

echo "[INFO] Starting git-modules sync sidecar..."
echo "       Repo: $GIT_REPO_URL"
echo "       Branch: $GIT_BRANCH"
echo "       Target Dir: $SYNC_DIR"
echo "       Interval: $SYNC_INTERVAL seconds"

# Ensure target directory exists
mkdir -p "$SYNC_DIR"

# Initial Clone or Fetch
if [ ! -d "$SYNC_DIR/.git" ]; then
  echo "[INFO] Performing initial clone..."
  # Clean directory if not empty but missing .git
  rm -rf "${SYNC_DIR:?}"/*
  git clone --branch "$GIT_BRANCH" "$GIT_REPO_URL" "$SYNC_DIR"
  if [ $? -ne 0 ]; then
    echo "[ERROR] Initial clone failed. Exiting."
    exit 1
  fi
else
  echo "[INFO] Existing repository found. Updating..."
  cd "$SYNC_DIR" || exit 1
  git fetch origin "$GIT_BRANCH"
  git reset --hard "origin/$GIT_BRANCH"
  git clean -fd
fi

# Infinite sync loop
while true; do
  sleep "$SYNC_INTERVAL"
  echo "[INFO] Pulling updates..."
  cd "$SYNC_DIR" || continue
  git fetch origin "$GIT_BRANCH"
  git reset --hard "origin/$GIT_BRANCH"
  git clean -fd
  
  # Check if a post-sync script is provided
  if [ -f "/scripts/post-sync.sh" ]; then
    echo "[INFO] Running post-sync.sh..."
    sh /scripts/post-sync.sh
  fi
done
