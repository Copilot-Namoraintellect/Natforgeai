# R8-A UNEXECUTED MIGRATIONS — RECOVERY NOTE

> **Stream:** WBS-R8-A Strategic Memory
> **Branch:** `feature/r8-a-strategic-memory`
> **Status:** artefact-only migration; **MIGRATION_EXECUTION=False**

---

## Stream-local provisional migration

`db/migrations/0036_r8_a_strategic_memory_foundation.sql`

- Creates `strategic_memory_records` (versioned strategic-memory authority:
  deterministic `mem1:` identity, immutable `evidenceHash`-bound core,
  CAS-guarded `factStatus`, closed-vocabulary columns only, no execution
  fields) with unique anchors `smr_memory_id_uidx`, `smr_user_memory_uidx`,
  `smr_natural_key_uidx` and secondary indexes.
- Creates `strategic_memory_lifecycle_events` (immutable append-only `smf1:`
  facts) with unique anchor `smle_event_id_uidx`.

## Execution status

**NOT executed.** This file is a schema artefact for review and for R8-X
canonical convergence, exactly like the R6/R7 stream-local provisionals before
it (see `docs/recovery/r6-migration-convergence.md`,
`docs/recovery/r7-migration-convergence.md`). The drizzle schema source of
truth in `db/schema.ts` already carries both tables.

## Discipline

- R7's `0035_r7_business_optimisation_foundation` is **not altered**.
- No `db/migrations/meta/*` snapshot was generated or modified for this
  stream-local provisional (house convention for unexecuted artefacts).
- R8-X owns canonical sequencing, collision resolution and any journal-chain
  verification for the converged R8 migration.
