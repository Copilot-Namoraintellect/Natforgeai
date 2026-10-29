# R7-B Unexecuted Migrations

> **Stream:** WBS-R7-B (Attribution Intelligence)
> **Branch:** `feature/r7-b-attribution-intelligence`
> **Rule:** Migration artefacts are created for parity and review. They are
> **NOT executed** in this stream. No production or local database was touched
> by migration commands. `MIGRATION_EXECUTION = False`.

| Migration | Status | Contents |
|---|---|---|
| `db/migrations/0035_r7_b_attribution_foundation.sql` | **CREATED, NOT EXECUTED** | 1. New table `attribution_results` (immutable attribution records; unique `attributionId` `atr_attribution_id_uidx`; unique natural key `(userId, outcomeId, modelType, modelVersion, windowStart, windowEnd, journeyHash)` `atr_natural_key_uidx`; secondary indexes `atr_user_outcome_idx`, `atr_user_business_idx`). 2. New table `attribution_lifecycle_events` (immutable append-only supersession facts; unique `attributionLifecycleEventId` `atf_event_id_uidx`; index `atf_user_attribution_idx`). |

- **Exact schema delta** (append-only on `db/schema.ts`): two new tables only.
  No existing table, column, index, or the canonical R6 migration
  `0034_r6_lead_autonomy_foundation`, was altered. No FK constraints (house
  convention: opaque references, predicate-enforced ownership).
- Journal parity: `db/migrations/meta/_journal.json` idx 35 + snapshot
  `0035_snapshot.json` were generated together with the SQL (drizzle-kit
  generate, offline with a dummy `DATABASE_URL`; no database connection was
  opened).
- **Numbering collision note (R7-X owned):** R7-A's branch carries its own
  stream-local provisional `0035_r7_a_conversion_outcome_foundation` (its
  `business_outcomes` tables). Both streams branch from the same R6 base
  (`0034`), so both provisional artefacts claim journal idx 35 by necessity —
  this is expected and documented on both sides. **R7-B did not merge,
  renumber, or duplicate R7-A's artefact.** R7-X owns canonical R7 sequencing
  and will converge the two `0035` artefacts (e.g. `0035` + `0036`) at
  integration; until then each stream's runtime treats the other's tables as
  absent and degrades fail-closed.
- Execution is deferred to the integration/deployment authority. Until
  executed, the attribution runtime degrades gracefully and fail-closed:
  evaluation requires a readable outcome (R7-A seam guarded by an
  information-schema check) and insert-first persistence against the durable
  unique anchors — without the tables the store surface has no rows and
  persistence requires the tables, which is exercised in tests via injected
  in-memory fakes only.
