# R7-A Unexecuted Migrations

> **Stream:** WBS-R7-A (Conversion Outcome Intelligence)
> **Branch:** `feature/r7-a-conversion-outcome-intelligence`
> **Rule:** Migration artefacts are created for parity and review. They are
> **NOT executed** in this stream. No production or local database was touched
> by migration commands. `MIGRATION_EXECUTION = False`.

| Migration | Status | Contents |
|---|---|---|
| `db/migrations/0035_r7_a_conversion_outcome_foundation.sql` | **CREATED, NOT EXECUTED** | 1. New table `business_outcomes` (authoritative business-outcome records; unique `outcomeId` `bo_outcome_id_uidx`; unique natural key `(userId, conversionId, evidenceSource, evidenceIdentity)` `bo_natural_key_uidx`; secondary indexes `bo_user_business_idx`, `bo_user_conversion_idx`, `bo_user_lead_idx`, `bo_user_status_idx`). 2. New table `business_outcome_lifecycle_events` (immutable append-only lifecycle facts; unique `outcomeLifecycleEventId` `bole_event_id_uidx`; unique `(outcomeId, externalLifecycleId)` provider-retry anchor `bole_external_uidx` — NULLs distinct; index `bole_user_outcome_idx`). |

- **Exact schema delta** (append-only on `db/schema.ts`): two new tables only.
  No existing table, column, index, or the canonical R6 migration
  `0034_r6_lead_autonomy_foundation`, was altered. No FK constraints (house
  convention: opaque references, predicate-enforced ownership).
- Journal parity: `db/migrations/meta/_journal.json` idx 35 + snapshot
  `0035_snapshot.json` were generated together with the SQL (drizzle-kit
  generate, offline with a dummy `DATABASE_URL`; no database connection was
  opened).
- Execution is deferred to the integration/deployment authority. R7-X owns
  final R7 migration convergence; sibling R7 streams must not renumber or
  duplicate this artefact.
- Until executed, the outcome runtime degrades gracefully and fail-closed:
  every read/write is tenant-scoped and insert-first against the durable unique
  anchors; without the tables the store surface has no rows to read and
  persistence requires the tables, which is exercised in tests via injected
  in-memory fakes only.
