# R6-E Unexecuted Migrations

> **Stream:** WBS-R6 Stream E (Conversion Tracking & Outcome Authority)
> **Branch:** `feature/r6-e-conversion-tracking`
> **Rule:** Migration artefacts are created for parity and review. They are
> **NOT executed** in this stream. No production or local database was
> touched by migration commands.

| Migration | Status | Contents |
|---|---|---|
| `db/migrations/0034_early_mole_man.sql` | **CREATED, NOT EXECUTED** | 1. New table `conversion_events` (durable conversion/outcome records; unique `conversionId`; unique natural key `(userId, sourceSystem, externalConversionId)`; secondary indexes `ce_user_business_idx`, `ce_user_lead_idx`, `ce_user_occurred_idx`, `ce_user_reverses_idx`). 2. New table `conversion_lifecycle_events` (immutable append-only lifecycle facts; unique `lifecycleEventId`; unique `(conversionId, externalLifecycleId)` provider-retry anchor — NULLs distinct; index `cle_user_conversion_idx`). |

- Journal parity: `db/migrations/meta/_journal.json` idx 34 + snapshot
  `0034_snapshot.json` were generated together with the SQL (drizzle-kit
  generate, offline with a dummy `DATABASE_URL`; no database connection was
  opened).
- Execution is deferred to the integration/deployment authority, per the
  R6-E operating rules ("do NOT execute migrations").
- Until executed, the conversion runtime degrades gracefully and fail-closed:
  every read/write is tenant-scoped and insert-first against the durable
  unique anchors; without the tables the store surface has no rows to read
  and persistence requires the tables, which is exercised in tests via
  injected in-memory fakes only. No migration was run against any real
  database.
