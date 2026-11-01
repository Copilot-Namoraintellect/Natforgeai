#!/usr/bin/env bash
# R10-G configuration capture — references only, never secrets.
#
# Captures into $BACKUP_STAGING_DIR/config/:
#   env-inventory.redacted.json  (via the redact-env library)
#   web.config                   (from the repo — committed, non-secret)
#   runtime notes                (supervisor/IIS site names supplied via env)
#
# Required env:
#   BACKUP_STAGING_DIR   staging directory
# Optional env:
#   APP_ENV_FILE         path to the live .env (read once, redacted; original never copied)
#   RUNTIME_NOTES_FILE   small operator-maintained file of runtime/IIS/PM2 facts

set -euo pipefail

STAGING="${BACKUP_STAGING_DIR:?set BACKUP_STAGING_DIR}"
OUT="$STAGING/config"
mkdir -p "$OUT"

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO_ROOT="$(cd "$SCRIPT_DIR/../.." && pwd)"

if [[ -n "${APP_ENV_FILE:-}" ]]; then
  if [[ ! -r "$APP_ENV_FILE" ]]; then
    echo "[backup-config] ERROR: APP_ENV_FILE not readable: $APP_ENV_FILE" >&2
    exit 1
  fi
  npx tsx -e "
    import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
    import { redactEnv } from '${SCRIPT_DIR//\'/}/lib/redact-env';
    const inv = redactEnv(readFileSync(process.env.APP_ENV_FILE, 'utf8'));
    mkdirSync('$OUT', { recursive: true });
    writeFileSync('$OUT/env-inventory.redacted.json', JSON.stringify(inv, null, 2));
    console.log('[backup-config] env inventory: ' + inv.entryCount + ' keys, redacted=' + inv.entries.filter(e => e.redacted).length);
  "
else
  echo "[backup-config] NOTE: APP_ENV_FILE not set — skipping env inventory" >&2
fi

if [[ -f "$REPO_ROOT/public/web.config" ]]; then
  cp "$REPO_ROOT/public/web.config" "$OUT/web.config"
fi

if [[ -n "${RUNTIME_NOTES_FILE:-}" && -f "$RUNTIME_NOTES_FILE" ]]; then
  cp "$RUNTIME_NOTES_FILE" "$OUT/runtime-notes.txt"
fi

echo "[backup-config] OK -> $OUT"
