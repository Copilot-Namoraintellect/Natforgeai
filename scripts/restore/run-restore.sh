#!/usr/bin/env bash
# R10-G restore harness — disposable recovery environment sequence (G6/G7).
#
#   run-restore.sh
#     Required env:
#       BACKUP_SET            path to a verified backup set (set-…Z)
#       RESTORE_WORKDIR       scratch restore area
#       BACKUP_PASSPHRASE     decryption passphrase (from secret store)
#     Optional env:
#       RESTORE_DATABASE_URL  recovery MySQL DSN — when set, the dump is applied
#       RESTORE_TARGET_ROLE   default "recovery"; "production" requires DISASTER_RECOVERY=1
#       DISASTER_RECOVERY     set to 1 only for a declared disaster recovery (S1/S2/S8/S10)
#       RESTORE_EXPECTED_COUNTS  JSON file of pre-restore Tier A counts
#       RESTORE_UNCERTAIN_EXPECTED  pre-restore UNCERTAIN/PENDING_EXTERNAL attempt count
#       RESTORE_LOG           append-only restore audit log (default ./restore-audit.log)
#
# The script NEVER starts application services. Verification gates come first;
# service start + Mission Control acceptance are separate, human-run steps.

set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
: "${BACKUP_SET:?set BACKUP_SET to a backup set directory}"
: "${RESTORE_WORKDIR:?set RESTORE_WORKDIR}"
: "${BACKUP_PASSPHRASE:?set BACKUP_PASSPHRASE (from secret store)}"
ROLE="${RESTORE_TARGET_ROLE:-recovery}"
LOG="${RESTORE_LOG:-./restore-audit.log}"
TS="$(date -u +%FT%TZ)"

if [[ "$ROLE" == "production" && "${DISASTER_RECOVERY:-0}" != "1" ]]; then
  echo "[run-restore] REFUSING: RESTORE_TARGET_ROLE=production without DISASTER_RECOVERY=1" >&2
  exit 3
fi

mkdir -p "$RESTORE_WORKDIR"
echo "[run-restore] $TS set=$(basename "$BACKUP_SET") role=$ROLE"

# 1. Verify + decrypt + extract (fails closed inside the CLI).
npx tsx "$SCRIPT_DIR/restore.ts" run --set "$BACKUP_SET" --to "$RESTORE_WORKDIR/set"

APPLY_DB="no"
if [[ -n "${RESTORE_DATABASE_URL:-}" ]]; then
  APPLY_DB="yes"
  # 2. Apply dump to the recovery database.
  DB_NAME="$(node -e "console.log(new URL(process.env.RESTORE_DATABASE_URL).pathname.slice(1))")"
  echo "[run-restore] applying dump to recovery database '$DB_NAME' …"
  mysql --binary-mode "$DB_NAME" < "$RESTORE_WORKDIR/set/db/dump.sql"

  # 3. Gather facts (read-only) and assess integrity (G7).
  npx tsx "$SCRIPT_DIR/restore.ts" gather --db-url "$RESTORE_DATABASE_URL" > "$RESTORE_WORKDIR/facts.json"
  VERIFY_ARGS=(--facts "$RESTORE_WORKDIR/facts.json")
  if [[ -n "${RESTORE_EXPECTED_COUNTS:-}" ]]; then
    VERIFY_ARGS+=(--expected "$RESTORE_EXPECTED_COUNTS")
  fi
  if [[ -n "${RESTORE_UNCERTAIN_EXPECTED:-}" ]]; then
    VERIFY_ARGS+=(--uncertain-expected "$RESTORE_UNCERTAIN_EXPECTED")
  fi
  if ! npx tsx "$SCRIPT_DIR/restore.ts" verify "${VERIFY_ARGS[@]}" > "$RESTORE_WORKDIR/integrity-report.json"; then
    cat "$RESTORE_WORKDIR/integrity-report.json" >&2
    echo "[run-restore] INTEGRITY_FAIL — do not start services; investigate" >&2
    exit 1
  fi
fi

VERDICT="NOT_RUN"
if [[ -f "$RESTORE_WORKDIR/integrity-report.json" ]]; then
  VERDICT="$(node -e "console.log(JSON.parse(require('fs').readFileSync(process.argv[1],'utf8')).verdict)" "$RESTORE_WORKDIR/integrity-report.json")"
fi

# 4. Restore-run record (append-only audit).
node -e '
  const fs = require("fs");
  const path = require("path");
  const [ts, role, applyDb, verdict, setId, log, workdir] = process.argv.slice(1);
  const rec = {
    schemaVersion: 1,
    at: ts,
    sourceSetId: setId,
    targetRole: role,
    dbApplied: applyDb === "yes",
    integrityVerdict: verdict,
  };
  fs.appendFileSync(log, JSON.stringify(rec) + "\n");
  fs.writeFileSync(path.join(workdir, "restore-run.json"), JSON.stringify(rec, null, 2));
' "$TS" "$ROLE" "$APPLY_DB" "$VERDICT" "$(basename "$BACKUP_SET")" "$LOG" "$RESTORE_WORKDIR"

cat <<'NEXT'

[run-restore] Restore files are in RESTORE_WORKDIR/set. REMAINING HUMAN-RUN STEPS:
  1. Re-bind configuration from the secret store (never from backup payloads).
  2. Build at the set's pinned SHA: npm ci && npm run build.
  3. Start the API; re-derive R9-E mission state; compare vs restored rows.
  4. Run the Mission Control connected acceptance subset (R10-X minimum).
  5. Only then start workers — no stale worker resumes with old authority.
NEXT
