#!/usr/bin/env bash
# R10-G asset capture: data/public (generated media + uploads) and any
# static preview directories into a single tar in the staging area.
#
# Required env:
#   BACKUP_STAGING_DIR   staging directory
# Optional env:
#   APP_DATA_DIR         path to data/public (default: <repo>/data/public)
#   APP_STATIC_DIRS      extra space-separated dirs to include

set -euo pipefail

STAGING="${BACKUP_STAGING_DIR:?set BACKUP_STAGING_DIR}"
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"
DATA_DIR="${APP_DATA_DIR:-$REPO_ROOT/data/public}"
TAR_FILE="$STAGING/assets.tar"

mkdir -p "$STAGING"
INCLUDE=()
if [[ -d "$DATA_DIR" ]]; then INCLUDE+=("$(basename "$DATA_DIR")"); SRC_DIR="$(dirname "$DATA_DIR")"; else SRC_DIR="$REPO_ROOT"; fi
for d in ${APP_STATIC_DIRS:-}; do
  [[ -d "$d" ]] && INCLUDE+=("$d")
done

if [[ ${#INCLUDE[@]} -eq 0 ]]; then
  echo "[backup-assets] NOTE: no asset directories found — creating empty tar marker" >&2
  tar -C "$REPO_ROOT" -cf "$TAR_FILE" --files-from /dev/null
else
  tar -C "$SRC_DIR" -cf "$TAR_FILE" "${INCLUDE[@]}"
fi
echo "[backup-assets] OK: $(wc -c < "$TAR_FILE") bytes -> $TAR_FILE"
