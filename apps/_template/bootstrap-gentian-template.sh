#!/usr/bin/env bash
# Populates gentian-app-template from a streamlined FastAPI + React layout.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")" && pwd)"
APP_NAME="${1:-my-app}"

mkdir -p "$ROOT"/{backend/app/{api/routes,core},frontend/src/{pages,api,stores},chart/templates,profile,docs}

# README pointer — full content lives in git; bootstrap only creates dirs for empty repos.
echo "Bootstrap complete for $APP_NAME at $ROOT"
echo "Copy tracked files from gentian-app-template or run from the git clone."
