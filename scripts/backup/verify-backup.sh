#!/usr/bin/env bash
# R10-G backup verification wrapper.
#   verify-backup.sh <set-dir> [--decrypt]
# Without --decrypt: manifest re-hash only. With --decrypt: also proves every
# encrypted payload decrypts under the current passphrase (supplied via
# BACKUP_PASSPHRASE env from the secret store). Exits non-zero on any failure.
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SET_DIR="${1:?usage: verify-backup.sh <set-dir> [--decrypt]}"
shift || true

ARGS=(--set "$SET_DIR")
if [[ "${1:-}" == "--decrypt" ]]; then
  ARGS+=(--decrypt)
fi

npx tsx "$SCRIPT_DIR/backup-cli.ts" verify "${ARGS[@]}"
