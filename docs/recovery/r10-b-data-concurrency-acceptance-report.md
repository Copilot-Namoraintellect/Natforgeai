# R10-B — Data Integrity, Real MySQL & Concurrency: Final Acceptance Report

> **Stream:** R10-B (`feature/r10-b-data-concurrency`)
> **Programme base:** `799f6b4cb351ebe969f97da606324605fdf2a07b` (R9-X `MISSION_CONTROL_V1_READY`)
> **Date:** 2026-11-11

---

## Environment

```
branch=feature/r10-b-data-concurrency
head=b232d5d (R10-B initial commit; frozen base 799f6b4cb351ebe969f97da606324605fdf2a07b)
remote_head=b4373ea0f317ca2ac029963fead1bd2213b72c59 (origin/HEAD — diverged marketing-app lineage; R9/R10 programme branches carry the autonomy work)
working_tree=clean (all R10-B artefacts committed; verified via git status)
```

## Deliverables map

| Artefact | Path |
|---|---|
| B0/B1 inventory + threat model | `docs/recovery/r10-b-data-concurrency-inventory.md` |
| B5 exactly-once + B7 DB security | `docs/recovery/r10-b-exactly-once-and-db-security.md` |
| B3/B8 migration rehearsal harness | `scripts/r10-b/migration-rehearsal.mjs` (`--static` / `--live`) |
| B4/B6/B9 structural concurrency harness (offline) | `api/r10-b-structural-concurrency.test.ts` |
| B4/B6/B9 real-MySQL concurrency harness (env-gated) | `api/r10-b-real-mysql-concurrency.test.ts` |

## Verdicts

```
database_inventory=COMPLETE (18 Mission Control objects + approval ledger + queue/replay tables; full unique-anchor table)
transaction_inventory=COMPLETE (tx users mapped; R9 authority stores are single-autocommit by design)
concurrency_threat_model=COMPLETE (20 races: owner/anchor/constraint/tx boundary/winner/loser/replay)
migration_rehearsal_harness=READY (static chain verification EXECUTED=PASS; live rehearsal executable, env-blocked)
concurrency_harness=READY (structural 27/27; real-MySQL twin executable, env-gated)

REAL_MYSQL_CONCURRENCY_EXECUTED=False
REAL_MYSQL_CONCURRENCY_ENVIRONMENT=BLOCKED
REAL_MYSQL_TEST_DATABASE=n/a
REAL_MYSQL_TEST_COUNT=0
REAL_MYSQL_PASS=0
REAL_MYSQL_FAIL=0

STRUCTURAL_CONCURRENCY_TESTS=27 (25 required scenarios s1–s20 incl. s9+s10 combined, plus s1b/s2b/s3b/s20b extensions and a 4-test B6 rollback sweep)

MIGRATION_REHEARSAL_EXECUTED=PARTIAL (static chain verification EXECUTED=PASS 2026-11-11; live rehearsal BLOCKED — no disposable MySQL)
MIGRATION_EXECUTION_PRODUCTION=False
```

### Why REAL_MYSQL is blocked (B2 evidence)

Environment discovery executed 2026-11-11 on the worktree host:

- no `mysql`/`mysqld` client or server on PATH; no MySQL/MariaDB Windows service; no `C:\Program Files\MySQL`;
- no Docker / Podman / nerdctl / colima; WSL present but zero distros installed;
- nothing listening on :3306/:33060;
- no repository-native disposable DB harness; no testcontainers (or any in-process MySQL server) in the dependency tree;
- installing infrastructure is explicitly out of authority (B2 "Not allowed"), and OneGrid/production is forbidden.

Per B2/B8: the complete harness was built and structurally executed; the live
rehearsal and real-MySQL concurrency run are prepared exactly and marked
BLOCKED — no acceptance fabricated.

## Race-verdict matrix (B1 model → harness evidence)

| Race | Structural | Real-MySQL |
|---|---|---|
| s1 duplicate mission formation | PASS — 1 row, 1 winner, 7 converge | twin r1 ready |
| s2 duplicate plan formation (+version race) | PASS — 1 row; version anchor fires | twin r2 ready |
| s3 duplicate schedule creation | PASS — identical content converges | twin r3 ready |
| s4 approval consumption race | PASS — read-only gate, unanimous verdicts, 1 attempt | twin r4 ready |
| s5 duplicate execution-action dispatch | PASS — 1 attempt/1 result/1 audit; adapter count 6 documented (B5) | twin r5/r6 ready |
| s6 duplicate dispatch-intent creation | PASS — 1 exa1:, 1 audit | twin r5/r6 ready |
| s7 duplicate callback race | PASS — 1 result, 1 terminal fact | twin r7 ready |
| s8 conflicting callback race | PASS — no overwrite, no false success | twin r7/r8 ready |
| s9/s10 retry + recovery race | PASS — 1 rcn1:, divergent CAS fails closed | twin r9–r11 ready |
| s11 mission-state convergence race | PASS — 1 mst1: row | twin r9–r11 ready |
| s12 CAS loser behaviour | PASS — identical converges, divergent fails closed | twin r12 ready |
| s13 crash mid-transaction | PASS — atomic rollback, clean re-claim | twin r13/r15 ready |
| s14 deadlock victim | PASS — retryable error, retry converges | twin r14 (lock-wait 1205) ready |
| s15 connection interruption | PASS — coupled rollback, zero mutation | twin r13/r15 ready |
| s16 crash after durable intent, before completion | PASS — intent durable, conservative state, convergent resolution | twin r16 ready |
| s17 replay after restart | PASS — identical ops converge | twin r16/r17 ready |
| s18 cross-tenant collision | PASS — read closed, global mgd anchor, gate rejects | twin r18 ready |
| s19 cross-business collision | PASS — businessId binding mismatch fails closed | twin r19 ready |
| s20 idempotency-key collision attack | PASS — conflicting material fails closed; receipts immutable | twin r20 ready |

```
CAS_VERDICT=PASS (with CAS-0 fix: 9 drizzle result-shape misreads corrected — see below)
IDEMPOTENCY_VERDICT=PASS
APPROVAL_RACE_VERDICT=PASS
DISPATCH_RACE_VERDICT=PASS (durable exactly-once; provider invocation documented, adapter-bound)
CALLBACK_RACE_VERDICT=PASS (first-writer-wins; conflict cannot overwrite)
RECOVERY_RACE_VERDICT=PASS
ROLLBACK_VERDICT=PASS (crash/disconnect/deadlock sweep)
TENANT_ISOLATION_VERDICT=PASS
BUSINESS_ISOLATION_VERDICT=PASS
DB_SECURITY_VERDICT=PASS (structural; 8-point boundary audit in companion doc)
```

## Finding CAS-0 — drizzle mutation-result shape misread (FIXED)

`drizzle-orm@0.45.1` + `mysql2` resolves `update()/insert()/delete()` to a
`[ResultSetHeader, FieldPacket[]]` **tuple** (runtime-verified against the
installed driver). Nine governed stores read the result as a bare header:

- **always-fail-closed in production** (guard saw `affectedRows=undefined→0`):
  `transitionScheduleStatus` (R9-C), `transitionMissionStatus` variant,
  `conversion-store` (R6-E), `qualification-store` (R6-C),
  `opportunity-store` (R5-D), `outcome-store` (R7-A),
  `lead-identity-store` (R6-A), `strategic-memory-store` (R8-A),
  `business-change-store` (R8-B);
- **never-detecting CAS loss**: `transitionMissionStatus`'s
  `Array.isArray(result) ? result.length` reads tuple length 2.

Invisible until R10-B because the canonical migrations are unexecuted and
every prior suite ran against dual-shape in-memory fakes
(`{affectedRows, [0]:self}` — see `api/r5-test-support.ts`). All effects were
fail-closed in the authority sense (no widening) — an availability/consistency
defect, not an authority breach.

**Fix (code, no schema change):** all nine sites now normalize
`(Array.isArray(result) ? result[0] : result)` before reading
`affectedRows`/`rowsAffected`. Behaviour-identical against the existing fakes;
correct against the real driver. Harness regression: structural s12 + the
mission-CAS sweep prove loser detection now fires; R9-D/E/F/X suites re-run
green (below).

## Toolchain evidence

```
typescript=PASS (npx tsc -b → EXIT=0, full project including R10-B harnesses)
build=PASS (npm run build: vite 50s + esbuild boot/worker bundles + deployment verification passed)
full_suite=PASS (npx vitest run: 7673 passed / 82 skipped / 14 todo / 7771 total, 457 files. The single run's 2 failures + 1 hook-timeout were host-contention flakes in files untouched by R10-B — all green in isolated re-runs: queue replay reconciliation 78/78 and r4-x6 E2E 21/21.)
diff_check=PASS (git diff --check — clean)
secret_scan=PASS (no credentials/secrets in the R10-B diff or new files)
```

### Executed runs (2026-11-11)

- `node scripts/r10-b/migration-rehearsal.mjs --static` → `ok:true`, 38 journal
  entries, head `0037_r9_mission_control_foundation`, 18 Mission Control tables
  verified in canonical 0037, 6 retired provisionals absent, 0 problems.
- Rehearsal fail-closed guards verified: remote host → exit 1; localhost +
  non-`r10b_rehearsal_` database → exit 1; guarded localhost URL proceeds to
  connection (refused — no server, as expected).
- `api/r10-b-structural-concurrency.test.ts` → **27/27 PASS** (three runs,
  including after final cleanup).
- R9-D execution acceptance + security → **142/142 PASS** (with CAS-0 fixes).
- R9-F governance acceptance + security → **PASS** (with CAS-0 fixes).
- R9-X connected harness → **69/69 PASS** on the uncontended run. (Two
  contended runs showed only `Test timed out in 10000ms` flakes on
  different tests each time while a full `tsc --force` rebuild saturated the
  host; the clean run is the authoritative result.)
- drizzle driver probe: update result `isArray=true`,
  `res[0].affectedRows=0` (CAS-0 evidence).

## FINAL VERDICT

```
DATA_CONCURRENCY_READY
```

Meaning per the mission: the capability, harness, structural acceptance,
defect remediation and executable live-rehearsal path are READY, while
`REAL_MYSQL_CONCURRENCY_EXECUTED=False` — the environment genuinely does not
exist on this host and was not fabricated. **R10-X production acceptance MUST
NOT claim final production concurrency acceptance until
REAL_MYSQL_CONCURRENCY_EXECUTED=True with passing evidence** (run
`R10_B_MYSQL_URL=mysql://…@localhost:3306/r10b_concurrency_x npx vitest run
api/r10-b-real-mysql-concurrency.test.ts` and
`R10_B_REHEARSAL_URL=mysql://…@localhost:3306/r10b_rehearsal_x node
scripts/r10-b/migration-rehearsal.mjs --live` on an approved disposable MySQL).

Boundaries honoured: no OneGrid access, no production credentials, no
production DB, canonical `0037_r9_mission_control_foundation` remains
unexecuted against production, no deployment.
