#!/usr/bin/env bash
# Standalone release-identity capture (used by ops when a set is assembled
# outside the CLI, e.g. provider-side snapshots). Prints JSON to stdout.
set -euo pipefail
GIT_SHA="$(git rev-parse HEAD 2>/dev/null || echo unknown)"
BRANCH="$(git rev-parse --abbrev-ref HEAD 2>/dev/null || echo unknown)"
DIRTY="false"
if [[ -n "$(git status --porcelain 2>/dev/null)" ]]; then DIRTY="true"; fi
BUILD_ID="${BUILD_ID:-}"
node -e "console.log(JSON.stringify({generatedBy:'r10-g-capture-release',schemaVersion:1,capturedAt:new Date().toISOString(),gitSha:'$GIT_SHA',branch:'$BRANCH',dirty:$DIRTY,buildId:'$BUILD_ID',nodeVersion:process.version},null,2))"
