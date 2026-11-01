#!/usr/bin/env bash
# R10-G database backup (mysqldump wrapper).
#
# Credentials come ONLY from the environment (DATABASE_URL parsed locally or
# MYSQL_* variables) or a root-only option file (~/.my.cnf.backup). Nothing
# is embedded in this script. The dump is written to a staging area; the
# backup set assembly (encryption/manifest) happens in run-backup.sh.
#
# Required env:
#   BACKUP_STAGING_DIR   writable staging directory (dump lands here)
# Optional env:
#   DATABASE_URL         mysql://user:pass@host:port/db (parsed; password never printed)
#   MYSQL_HOST / MYSQL_PORT / MYSQL_DATABASE / MYSQL_USER / MYSQL_PASSWORD
#   MYSQL_DEFAULTS_FILE  path to a root-only option file (preferred on the server)

set -euo pipefail

STAGING="${BACKUP_STAGING_DIR:?set BACKUP_STAGING_DIR}"
DUMP_FILE="$STAGING/dump.sql"

if [[ -n "${MYSQL_DEFAULTS_FILE:-}" ]]; then
  MYSQL_ARGS=(--defaults-extra-file="$MYSQL_DEFAULTS_FILE")
  MYSQL_DATABASE="${MYSQL_DATABASE:?MYSQL_DATABASE required with MYSQL_DEFAULTS_FILE}"
else
  # Parse DATABASE_URL if present, else use discrete vars.
  if [[ -n "${DATABASE_URL:-}" && "${DATABASE_URL}" == mysql://* ]]; then
    rest="${DATABASE_URL#mysql://}"
    AUTH="${rest%%@*}"
    HOSTPORT_DB="${rest#*@}"
    MYSQL_USER="${AUTH%%:*}"
    MYSQL_PASSWORD="${AUTH#*:}"
    HPE="${HOSTPORT_DB%%/*}"
    MYSQL_DATABASE="${HOSTPORT_DB#*/}"
    MYSQL_HOST="${HPE%%:*}"
    MYSQL_PORT="${HPE##*:}"
    if [[ "$MYSQL_PORT" == "$HPE" ]]; then MYSQL_PORT="3306"; fi
  fi
  : "${MYSQL_HOST:?MYSQL_HOST or DATABASE_URL required}"
  : "${MYSQL_DATABASE:?MYSQL_DATABASE or DATABASE_URL required}"
  MYSQL_ARGS=(-h "$MYSQL_HOST" -P "${MYSQL_PORT:-3306}" -u "$MYSQL_USER")
  if [[ -n "${MYSQL_PASSWORD:-}" ]]; then
    # Supply the password via a throwaway option file (mode 600), never via -p on argv.
    TMP_CNF="$(mktemp)"
    chmod 600 "$TMP_CNF"
    printf '[client]\npassword=%s\n' "$MYSQL_PASSWORD" > "$TMP_CNF"
    MYSQL_ARGS+=(--defaults-extra-file="$TMP_CNF")
  fi
fi

mkdir -p "$STAGING"
echo "[backup-database] dumping ${MYSQL_DATABASE} from host role '${BACKUP_HOST_ROLE:-unknown}' ..."

mysqldump "${MYSQL_ARGS[@]}" \
  --single-transaction \
  --routines \
  --triggers \
  --hex-blob \
  --set-gtid-purged=OFF \
  --databases "$MYSQL_DATABASE" > "$DUMP_FILE"

if [[ -n "${TMP_CNF:-}" ]]; then rm -f "$TMP_CNF"; fi

TABLE_COUNT=$(grep -c '^DROP TABLE IF EXISTS `' "$DUMP_FILE" || true)
if ! tail -n 40 "$DUMP_FILE" | grep -q 'Dump completed'; then
  echo "[backup-database] ERROR: dump footer missing — dump did not complete" >&2
  exit 1
fi

echo "[backup-database] OK: $(wc -c < "$DUMP_FILE") bytes, ${TABLE_COUNT} tables -> $DUMP_FILE"
echo "$TABLE_COUNT" > "$STAGING/table-count.txt"
