# R10-G Backup Harness — Operator Guide

Architecture and authority model: `docs/recovery/r10-g-backup-architecture.md`.
Monitoring contract: `docs/contracts/backup-monitoring-contract.md`.
OneGrid execution checklist: `docs/recovery/r10-g-onegrid-implementation-checklist.md`.

## Layout

| Path | Role |
|---|---|
| `run-backup.sh` | Nightly orchestrator (captures → assemble → offsite → prune) |
| `backup-database.sh` | `mysqldump` wrapper; credentials only from env/option-file; never embedded |
| `backup-config.sh` | Redacted env inventory + `web.config` + runtime notes |
| `backup-assets.sh` | `data/public` tar (generated media + uploads) |
| `capture-release-manifest.sh` | Standalone release identity capture (git SHA/branch/dirty/build id) |
| `verify-backup.sh` | Manifest re-hash (+ optional decrypt round-trip) for one set |
| `backup-cli.ts` | `create / verify / prune / decrypt` (used by the wrappers) |
| `lib/` | Pure, unit-tested modules (manifest, retention, encrypt, secret-scan, redact-env, naming, backup-set) |

## Nightly run (as `backup-op`, from cron/systemd)

```bash
BACKUP_OUT_ROOT=/var/backups/natforge \
BACKUP_STAGING_DIR=/var/backups/.staging \
BACKUP_PASSPHRASE=<from secret store> \
BACKUP_DB_NAME=natforge BACKUP_HOST_ROLE=production \
DATABASE_URL=<read from app env by the job, not stored here> \
APP_ENV_FILE=/var/www/app/.env \
BACKUP_OFFSITE_CMD=/usr/local/bin/offsite-push \
  scripts/backup/run-backup.sh
```

`backup-run.json` (see monitoring contract §2) lands inside every set and is
the monitoring ingest artefact. **A set without a SUCCESS run record and an
offsite ack does not exist for RPO purposes.**

## Verification

```bash
scripts/backup/verify-backup.sh /var/backups/natforge/set-…Z            # hashes
BACKUP_PASSPHRASE=… scripts/backup/verify-backup.sh /var/backups/natforge/set-…Z --decrypt
```

## Restore (disposable environment only)

```bash
BACKUP_PASSPHRASE=… npx tsx scripts/backup/backup-cli.ts decrypt \
  --set /var/backups/natforge/set-…Z --to /tmp/recovery/set
# then follow scripts/restore/run-restore.sh — which refuses production targets
```

## Rules that are never bent

1. No credential is ever embedded in any script in this directory.
2. No script in this directory is invoked by the application runtime.
3. Fail-closed: any stage failure ⇒ run FAILED ⇒ alert; partial sets are
   quarantined as `<setId>.partial/` and never pruned by retention (they do
   not match the set-id name pattern).
4. Payloads leave the host only as encrypted blobs via the offsite push.
