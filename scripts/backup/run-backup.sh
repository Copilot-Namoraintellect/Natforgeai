#!/usr/bin/env bash
# R10-G nightly backup orchestrator (run as the backup operator, never as the
# app user). Sequence: stage captures -> assemble verified encrypted set ->
# optional offsite push -> prune per retention policy -> emit run record.
#
# Required env:
#   BACKUP_OUT_ROOT       backup set destination (mode 0700, backup-op owned)
#   BACKUP_STAGING_DIR    scratch dir for captures
#   BACKUP_PASSPHRASE     encryption passphrase (inject from secret store)
# Optional env:
#   BACKUP_OFFSITE_CMD    command receiving the set path as $1; its exit = ack
#   BACKUP_DB_NAME / BACKUP_HOST_ROLE / MYSQL_* or DATABASE_URL
#   APP_ENV_FILE / APP_DATA_DIR
#   RETENTION_DAILY / RETENTION_WEEKLY / RETENTION_MONTHLY

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${BACKUP_OUT_ROOT:?set BACKUP_OUT_ROOT}"
: "${BACKUP_STAGING_DIR:?set BACKUP_STAGING_DIR}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE (from secret store)}"

umask 077
mkdir -p "$BACKUP_OUT_ROOT" "$BACKUP_STAGING_DIR"

echo "[run-backup] $(date -u +%FT%TZ) starting"

# 1. Captures
BACKUP_STAGING_DIR="$BACKUP_STAGING_DIR" \
  "$SCRIPT_DIR/backup-database.sh"

BACKUP_STAGING_DIR="$BACKUP_STAGING_DIR" \
  "$SCRIPT_DIR/backup-config.sh"

BACKUP_STAGING_DIR="$BACKUP_STAGING_DIR" \
  "$SCRIPT_DIR/backup-assets.sh"

TABLE_COUNT="$(cat "$BACKUP_STAGING_DIR/table-count.txt" 2>/dev/null || echo "")"

# 2. Assemble verified encrypted set (fails closed; exits non-zero on any stage failure)
npx tsx "$SCRIPT_DIR/backup-cli.ts" create \
  --dump "$BACKUP_STAGING_DIR/dump.sql" \
  --assets "$BACKUP_STAGING_DIR/assets.tar" \
  ${APP_ENV_FILE:+--env-file "$APP_ENV_FILE"} \
  --out "$BACKUP_OUT_ROOT" \
  --db-name "${BACKUP_DB_NAME:-unknown}" \
  --host-role "${BACKUP_HOST_ROLE:-production}" \
  ${TABLE_COUNT:+--table-count "$TABLE_COUNT"}

SET_ID="$(ls -1d "$BACKUP_OUT_ROOT"/set-*Z 2>/dev/null | sort | tail -n 1 | xargs -r basename)"
if [[ -z "$SET_ID" ]]; then
  echo "[run-backup] ERROR: no completed set found after create" >&2
  exit 1
fi
echo "[run-backup] set $SET_ID assembled and self-verified"

# 3. Offsite replication (optional but expected in production)
if [[ -n "${BACKUP_OFFSITE_CMD:-}" ]]; then
  if "$BACKUP_OFFSITE_CMD" "$BACKUP_OUT_ROOT/$SET_ID"; then
    echo "[run-backup] offsite ack received for $SET_ID"
  else
    echo "[run-backup] ERROR: offsite push failed for $SET_ID (set stays local; alert emitted)" >&2
    exit 1
  fi
else
  echo "[run-backup] WARNING: BACKUP_OFFSITE_CMD not set — set $SET_ID has NO offsite copy" >&2
fi

# 4. Retention prune (local; offsite lifecycle mirrors this server-side)
npx tsx "$SCRIPT_DIR/backup-cli.ts" prune \
  --root "$BACKUP_OUT_ROOT" \
  ${RETENTION_DAILY:+--daily "$RETENTION_DAILY"} \
  ${RETENTION_WEEKLY:+--weekly "$RETENTION_WEEKLY"} \
  ${RETENTION_MONTHLY:+--monthly "$RETENTION_MONTHLY"} \
  --apply

# 5. Staging hygiene: dump.sql held secrets-adjacent only transiently — remove.
rm -f "$BACKUP_STAGING_DIR/dump.sql" "$BACKUP_STAGING_DIR/assets.tar" "$BACKUP_STAGING_DIR/table-count.txt"

echo "[run-backup] $(date -u +%FT%TZ) SUCCESS set=$SET_ID"
