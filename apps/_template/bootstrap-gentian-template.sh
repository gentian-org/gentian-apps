#!/usr/bin/env bash
# Creates the empty directory skeleton of a new app laid out like apps/_template.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="${1:-my-app}"

mkdir -p "$ROOT"/{backend/app/{api/routes,core},frontend/src/{pages,api,stores},chart/templates,profile,docs}

# README pointer — full content lives in git; bootstrap only creates dirs for empty repos.
echo "Bootstrap complete for $APP_NAME at $ROOT"
echo "Copy the tracked files from gentian-apps/apps/_template into it."
