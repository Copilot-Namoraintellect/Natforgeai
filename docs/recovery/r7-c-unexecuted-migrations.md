# R7-C Unexecuted Migrations

> **Stream:** WBS-R7-C (Business Learning Engine)
> **Branch:** `feature/r7-c-business-learning`
> **Rule:** Migration artefacts are created for parity and review. They are
> **NOT executed** in this stream. No production or local database was touched
> by migration commands. `MIGRATION_EXECUTION = False`.

| Migration | Status | Contents |
|---|---|---|
| `db/migrations/0035_r7_c_business_learning.sql` | **CREATED, NOT EXECUTED** | 1. New table `business_learning_records` (authoritative business-outcome learning records; unique `learningId` `blr_learning_id_uidx`; unique natural key `(userId, evidenceBundleId, learningType, subjectType, subjectId, upstreamStateFingerprint)` `blr_natural_key_uidx`; secondary indexes `blr_user_business_idx`, `blr_user_subject_idx`, `blr_user_status_idx`). 2. New table `business_learning_lifecycle_events` (immutable append-only lifecycle facts; unique `learningLifecycleEventId` `bll_event_id_uidx`; index `bll_user_learning_idx`). |

- **Exact schema delta** (append-only on `db/schema.ts`): two new tables only.
  No existing table, column, index, or the canonical R6 migration
  `0034_r6_lead_autonomy_foundation`, was altered. No FK constraints (house
  convention: opaque references, predicate-enforced ownership).
- Journal parity: `db/migrations/meta/_journal.json` idx 35 + snapshot
  `0035_snapshot.json` were generated together with the SQL (drizzle-kit
  generate, offline with a dummy `DATABASE_URL`; no database connection was
  opened).
- **Collision documented, NOT resolved here:** the sibling R7 streams each
  independently carry a stream-local provisional `0035_*` migration
  (`0035_r7_a_conversion_outcome_foundation`, `0035_r7_b_attribution_foundation`,
  `0035_r7_f_optimisation_governance`). R7-X owns final R7 migration
  convergence and renumbering; this stream must not renumber or modify any
  sibling artefact. The three sibling tables (`business_outcomes`,
  `attribution_results`, `optimisation_governance_decisions`) are consumed by
  R7-C exclusively through guarded read seams that fail closed when the
  tables are absent — until R7-X materialises them, learning derivation
  reports unknown evidence rather than fabricating it.
- Execution is deferred to the integration/deployment authority. Until
  executed, the learning runtime degrades gracefully and fail-closed:
  derivation requires the upstream evidence, which is unavailable without
  the sibling tables; persistence is exercised in tests via injected
  in-memory fakes only.
