#!/bin/sh

# Environment variables:
# GIT_REPO_URL - The URL of the git repository to clone
# GIT_BRANCH - The branch to clone (default: main)
# SYNC_DIR - The target directory for the cloned repo (default: /usr/src/app/modules)
# SYNC_INTERVAL - Seconds between pulls (default: 60)
#
# Optional, for private repositories:
# GIT_TOKEN_FILE   - file holding a PAT; used with GIT_USERNAME over HTTPS
# GIT_USERNAME     - HTTPS username (default: x-access-token, which GitHub accepts
#                    for both classic and fine-grained tokens)
# GIT_SSH_KEY_FILE - file holding an SSH private key; used for ssh:// or scp-style
#                    remotes instead of a token

GIT_REPO_URL=${GIT_REPO_URL:-""}
GIT_BRANCH=${GIT_BRANCH:-"main"}
SYNC_DIR=${SYNC_DIR:-"/usr/src/app/modules"}
SYNC_INTERVAL=${SYNC_INTERVAL:-60}
GIT_USERNAME=${GIT_USERNAME:-"x-access-token"}

if [ -z "$GIT_REPO_URL" ]; then
  echo "[ERROR] GIT_REPO_URL is not set. Exiting."
  exit 1
fi

# Configure writable HOME directory for git config commands
export HOME=/tmp

# Never block on a credential prompt. Without this a private repo makes git wait
# on a terminal that does not exist, and the container hangs instead of failing.
export GIT_TERMINAL_PROMPT=0

# --- Authentication ----------------------------------------------------------
# Credentials arrive as mounted files, never as environment values, so they do not
# show up in `kubectl describe pod` or in this process's environment.

if [ -n "${GIT_TOKEN_FILE:-}" ] && [ -f "$GIT_TOKEN_FILE" ]; then
  # An askpass helper keeps the token out of the remote URL (which git writes into
  # .git/config and prints in errors) and off disk in a credentials file.
  cat > /tmp/git-askpass.sh <<'ASKPASS'
#!/bin/sh
case "$1" in
  Username*) printf '%s\n' "${GIT_USERNAME}" ;;
  Password*) cat "${GIT_TOKEN_FILE}" ;;
esac
ASKPASS
  chmod 700 /tmp/git-askpass.sh
  export GIT_ASKPASS=/tmp/git-askpass.sh
  echo "[INFO] HTTPS token auth enabled (user: $GIT_USERNAME)"
fi

if [ -n "${GIT_SSH_KEY_FILE:-}" ] && [ -f "$GIT_SSH_KEY_FILE" ]; then
  # ssh refuses a key that is group/world readable, and a projected Secret is 0444,
  # so copy it somewhere we can tighten.
  cp "$GIT_SSH_KEY_FILE" /tmp/git-ssh-key
  chmod 600 /tmp/git-ssh-key
  export GIT_SSH_COMMAND="ssh -i /tmp/git-ssh-key -o IdentitiesOnly=yes -o StrictHostKeyChecking=accept-new -o UserKnownHostsFile=/tmp/known_hosts"
  echo "[INFO] SSH key auth enabled"
fi

# Configure git to ignore ownership checks for all directories in container
git config --global --add safe.directory '*'

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
  cd "$SYNC_DIR" || exit 1
  git submodule update --init --recursive
else
  echo "[INFO] Existing repository found. Updating..."
  cd "$SYNC_DIR" || exit 1
  git fetch origin "$GIT_BRANCH"
  git reset --hard "origin/$GIT_BRANCH"
  git clean -fd
  git submodule update --init --recursive
fi

# Infinite sync loop
while true; do
  sleep "$SYNC_INTERVAL"
  echo "[INFO] Pulling updates..."
  cd "$SYNC_DIR" || continue
  git fetch origin "$GIT_BRANCH"
  git reset --hard "origin/$GIT_BRANCH"
  git clean -fd
  git submodule update --init --recursive
  
  # Check if a post-sync script is provided
  if [ -f "/scripts/post-sync.sh" ]; then
    echo "[INFO] Running post-sync.sh..."
    sh /scripts/post-sync.sh
  fi
done
