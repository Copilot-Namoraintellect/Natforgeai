# R10-G RECOVERY REHEARSAL PLAN (G12)

> **Stream:** R10-G (`feature/r10-g-backup-dr`)
> **Status:** plan + local-harness rehearsal executed without a database
> (see §6); production-like rehearsal is the **R10-X gate**.
> **Core principle:** backup success != recovery success. No rehearsal, no
> acceptance.

---

## 1. What this plan proves

The full chain, in order, every time:

```
production-like backup
  → isolated restore environment
  → restore
  → validate schema / migration identity
  → validate critical (Tier A) data
  → start platform
  → run R9 Mission Control connected acceptance subset
  → verify no duplicate side effects
```

A rehearsal that skips a link proves nothing about that link.

## 2. Environment rules

1. **Isolation:** the restore target is disposable and network-isolated from
   production users; it must not share the production DB, Redis, or secret
   store paths. Role marker: `RESTORE_TARGET_ROLE=recovery`.
2. **Guard:** `scripts/restore/run-restore.sh` refuses to apply a backup set
   to a target whose role is `production` unless the operator sets the
   explicit `DISASTER_RECOVERY=1` flag (declared event only — S1/S2/S8/S10).
3. **Freshness:** the recovery environment is rebuilt from scratch each
   rehearsal; nothing carries over (no stale state, no warmed caches
   pretending to be restored truth).
4. **Truth ordering:** the database is restored **before** any worker or
   scheduler starts. No stale worker resumes with old authority: workers
   start only after the integrity verifier passes (G7).

## 3. Rehearsal sequence (the R10-X drill)

| Step | Action | Pass criterion |
|---|---|---|
| 1 | Provision scratch target (VM/container) with MySQL 8 matching production minor | instance up, role=recovery |
| 2 | Select backup set: latest with `status=SUCCESS` **and** offsite ack | `backup-run.json` evidence attached to rehearsal log |
| 3 | `run-restore.sh`: decrypt set → create DB → apply dump → verify `MANIFEST.sha256` re-hash | zero hash mismatches; GCM tags valid |
| 4 | Schema / migration identity: applied journal vs `db/migrations/meta/_journal.json`; table count vs manifest `tableCount`; canonical `0037` state matches pre-backup record | exact match |
| 5 | Critical-data validation (Tier A): identity-pattern spot checks (`mis1:`, `exa1:`, `out1:`, `mgd1:`), approval ledger continuity, audit fingerprint uniqueness + monotonic `id`, execution-attempt per-action result uniqueness, no `SUCCEEDED` duplicate per idempotency anchor | verifier `INTEGRITY_PASS` |
| 6 | Config bind: secret-store values into scratch `.env`; no secret appears in any log | smoke config load OK |
| 7 | Build + start platform at the set's pinned SHA: `npm ci && npm run build`; start API; **re-derive R9-E mission state** (do not trust restored derived rows — compare re-derived vs restored and reconcile per R9-E rules) | service healthy; `/api/health` style checks green |
| 8 | Start workers; queues re-derive; in-flight window converges via exact-once anchors | zero duplicate side effects (step 9 proves it) |
| 9 | R9 Mission Control connected acceptance subset (from `api/r9-x-harness.test.ts`, scenario list in §4) against the restored DB | subset green |
| 10 | Measure: wall-clock per step, RPO gap (failure-sim timestamp − `sourceSnapshotAt`), RTO total | recorded against `production-recovery-objectives-contract.md` |
| 11 | Teardown scratch target; append `restore-run.json` + rehearsal log to R10-X records | audit trail complete |

## 4. Mission Control connected acceptance subset (minimum)

Re-run, against the **restored** database, the following connected checks from
the R9-X harness (frozen at base `799f6b4`):

- propose → plan → schedule → govern → execute → observe (one happy-path
  mission through R9-A→B→C→F→D→E) — proves restored authorities still chain;
- replay/idempotency: re-submit one pre-restore `execution` dispatch intent →
  converges (`idempotent_replay`), **no second attempt row with a new
  identity**;
- governance binding: a pre-restore `REVIEW_REQUIRED` decision still requires
  its exact approval binding (no authority weakening post-restore);
- recovery boundary: one advisory `rcn1:` candidate remains advisory (no
  execution authority emerges from restore);
- audit: exactly-one ledger still rejects a duplicate `eventFingerprint`.

The definitive scenario list is owned by R10-X; this is the R10-G minimum
that a restore must not break.

## 5. Duplicate-side-effect verification (G7 proof)

After step 9, assert on the restored DB:

1. `execution_attempts`: no new rows for pre-restore `executionActionId`s
   beyond the restored history (a resumed worker must converge, not re-run).
2. No pre-restore `SUCCEEDED` action flips state; uncertainty is preserved
   verbatim (`UNCERTAIN`/`PENDING_EXTERNAL` stay as recorded).
3. `audit_events.id` strictly monotonic across the restore boundary; count
   preserved = restored count + rehearsal-generated events only.
4. Workers were started **after** verifier pass (step order evidence in the
   rehearsal log).

## 6. What has been rehearsed now (R10-G, pre-infrastructure)

Executed locally on the dev workstation (Git Bash, Node 22), with **no MySQL
and no production access**, via the committed script
`scripts/restore/rehearsal-local.sh` (11 steps / 15 checks, all passing —
`ALL 11 STEPS PASSED`):

- backup-set assembly from synthetic fixtures (dump covering all Tier A +
  core tables, asset tar, env carrying real-looking secrets) → manifest →
  redaction → AES-256-GCM encryption → same-run verify with decrypt round-trip;
- secret isolation evidence: the set contains no plaintext dump, no env
  secret, no credential-bearing DSN;
- negative paths fail closed: wrong passphrase rejected, one-byte tamper
  rejected, a secret embedded in the dump aborts assembly;
- restore harness on the resulting set: manifest re-verify → decrypt →
  extract → sane-mysqldump check;
- production-target guard: `gather` refuses a DSN whose host equals
  `PRODUCTION_DB_HOST` (exit 3) without `DISASTER_RECOVERY=1`;
- G7 integrity assessment: rehearsal facts → `INTEGRITY_PASS`; a
  duplicate-dispatch fact variant → `INTEGRITY_FAIL`;
- orchestrator `run-restore.sh` (no-DB mode) completes and writes the
  append-only restore audit record.

Honest limits (environment dependencies, not pass marks): the dump file was
synthetic — **no real database was dumped or restored** (no MySQL exists on
this host and none may be touched in production), so `DB_RECOVERY` and the
`gather`-against-a-live-server path are unexercised. R10-X must repeat steps
1–11 with a real disposable MySQL before any disaster-recovery acceptance
claim.

## 7. Cadence

- **Local harness rehearsal:** every change to `scripts/backup` or
  `scripts/restore` (CI-runnable via vitest + the rehearsal script).
- **Production-like rehearsal (R10-X):** before DR acceptance; then at least
  quarterly, and after every significant schema migration (0038+) or backup
  design change.
- Every rehearsal emits `restore-run.json`; `restore_rehearsal_overdue`
  alerts at 90 days (`backup-monitoring-contract.md`).
