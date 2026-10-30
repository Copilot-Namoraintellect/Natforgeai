# R8-B UNEXECUTED MIGRATIONS — RECOVERY NOTE

> **Stream:** WBS-R8-B Business Change Intelligence
> **Branch:** `feature/r8-b-business-change-intelligence`
> **Status:** artefact-only migration; **MIGRATION_EXECUTION=False**

---

## Stream-local provisional migration

`db/migrations/0036_r8_b_business_change_foundation.sql`

- Creates `business_change_events` (immutable change-event authority:
  deterministic `chg1:` identity over tenant + business + subject + change
  type + before/after state fingerprints, immutable `evidenceHash`-bound
  core, CAS-guarded `status`, closed-vocabulary columns only, no execution
  fields) with unique anchors `bce_change_id_uidx`, `bce_user_change_uidx`,
  `bce_natural_key_uidx` and secondary indexes.
- Creates `business_change_lifecycle_events` (immutable append-only `bcl1:`
  facts: confirmation / contradiction / supersession / invalidation / expiry /
  reaffirmation) with unique anchor `bcle_event_id_uidx`.

## 0036 collision (documented, NOT converged)

Three independent stream-local provisional migrations share the `0036`
sequence slot on their own branches — by design, converged only by R8-X:

| Stream | File (its branch only) |
|---|---|
| R8-A Strategic Memory | `0036_r8_a_strategic_memory_foundation.sql` |
| R8-B Business Change (this stream) | `0036_r8_b_business_change_foundation.sql` |
| R8-F Strategic Governance | `0036_r8_f_strategic_governance_foundation.sql` |

None is executed; none modifies R7's `0035_r7_business_optimisation_foundation`.
R8-X owns canonical sequencing, collision resolution and any journal-chain
verification for the converged R8 migration (mirroring
`docs/recovery/r7-migration-convergence.md`).

## Execution status

**NOT executed.** This file is a schema artefact for review and for R8-X
canonical convergence, exactly like the R6/R7 stream-local provisionals before
it. The drizzle schema source of truth in `db/schema.ts` already carries both
tables.

## Discipline

- R7's `0035_r7_business_optimisation_foundation` is **not altered**.
- No `db/migrations/meta/*` snapshot was generated or modified for this
  stream-local provisional (house convention for unexecuted artefacts).
- R8-X owns canonical sequencing, collision resolution and any journal-chain
  verification for the converged R8 migration.
