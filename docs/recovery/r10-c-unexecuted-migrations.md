# R10-C — UNEXECUTED PROVISIONAL MIGRATION (0038)

> **Stream:** R10-C Runtime Resilience
> **Migration:** `db/migrations/0038_r10_c_runtime_resilience.sql`
> **Status:** ARTEFACT ONLY — **NOT EXECUTED**. `MIGRATION_EXECUTION=False`.
> **Date:** 2026-11-10

---

## 1. What exists

One stream-local provisional migration, `0038_r10_c_runtime_resilience`, defines
the five R10-C runtime tables that back the runtime-resilience envelope:

| Table | Purpose | Unique anchors |
|---|---|---|
| `runtime_workers` | Worker registration + liveness (C1/C3) | `workerInstanceId` |
| `runtime_jobs` | DB-native durable work queue (C2) | `jobId`, `(userId, jobId)` |
| `runtime_leases` | Authority-bound fenced job leases (C2/C4) | `leaseId` |
| `runtime_dead_letters` | Dead-letter evidence preservation (C8) | `deadLetterId` |
| `runtime_lifecycle_events` | Append-only runtime facts (rlf1:) | `lifecycleEventId` |

Canonical source of truth is `db/schema.ts` (the drizzle table definitions);
the SQL file mirrors it for review and later convergence.

## 2. Execution posture

- **NOT executed** against any database. No `db:push`, no `db:migrate`, no
  `db:generate` was run for this stream.
- **NOT added to the drizzle journal** (`db/migrations/meta/_journal.json`).
  R6/R7/R8/R9 stream-local provisionals followed the same artefact-only
  convention before R*-X canonical convergence.
- Canonical R9 migration `0037_r9_mission_control_foundation` is preserved
  unchanged.
- **R10-X owns canonical R10 migration convergence.** When R10-X converges the
  R10 provisional migrations, it will reconcile this file (and any R10-A/B/E/F
  provisionals) into the canonical R10 migration, verify `db/schema.ts` ↔ SQL
  semantic match, and only then — under the governed migration path — execute.

## 3. Why it is safe to leave unexecuted

The R10-C acceptance suites run the **real** runtime services + stores against
a pure in-memory fake database that replicates the durable unique anchors and
the optimistic-CAS semantics (`tryClaimFreshCAS`, `tryClaimReclaimCAS`,
`completeJobWithFenceCAS`). No real database is required to prove the runtime
resilience properties, by construction. Structural concurrency (unique anchors,
CAS lost-update rejection, single-winner claim) is proven deterministically;
real-MySQL concurrent-writer execution remains the R10-X / pre-production gate,
carried forward from R6-X/R7-X/R8-X/R9-X.

## 4. Blast radius

Read-only artefact. No runtime code path executes this file. The drizzle
schema definitions in `db/schema.ts` are type definitions only; nothing
creates these tables at runtime in this stream.
