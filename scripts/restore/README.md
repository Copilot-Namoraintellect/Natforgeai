# R10-G Restore Harness — Operator Guide

Sequence and gates: `docs/recovery/r10-g-recovery-rehearsal-plan.md`.
Disaster playbooks: `docs/recovery/r10-g-disaster-scenarios.md`.

## Commands

| Command | What it does |
|---|---|
| `restore.ts run --set <set> --to <dir>` | Manifest re-verify → decrypt → extract dump/config/assets/release manifest into the restore area. No database is touched. |
| `restore.ts gather --db-url <recovery DSN>` | Read-only fact gathering from a restored database (table presence, Tier A counts, audit uniqueness/monotonicity, identity sampling, execution duplicate-dispatch and uncertainty counts, stale claims). |
| `restore.ts verify --facts <json> [--expected <json>] [--uncertain-expected N]` | Pure G7 assessment → `INTEGRITY_PASS`/`INTEGRITY_FAIL`, exit code 0/1. |
| `run-restore.sh` | Orchestrates the three steps against a disposable environment and writes the append-only restore audit record (`restore-run.json` + `$RESTORE_LOG`). Never starts services. |

## Guards

- `gather`/`run-restore.sh` refuse a `--db-url` host equal to
  `PRODUCTION_DB_HOST` unless `DISASTER_RECOVERY=1` is set (declared S1/S2/S8/S10).
- Every step is fail-closed: manifest mismatch, decrypt failure, or any
  `INTEGRITY_FAIL` stops the sequence before services could start.
- Restore events are append-only facts; nothing in the app may edit them.

## What the integrity verifier proves (G7)

Mission/planning/schedule identities unchanged · approval history preserved ·
execution history preserved · uncertainty preserved verbatim · audit timeline
preserved (unique fingerprints, no new id gaps) · no duplicate dispatch
(≤ 1 SUCCEEDED attempt per action) · no stale worker claims · migration
identity matches the pinned release.
