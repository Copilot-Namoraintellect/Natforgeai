# R7-D Unexecuted Migrations

> **Stream:** WBS-R7-D (Experimentation Engine)
> **Branch:** `feature/r7-d-experimentation`
> **Rule:** Migration artefacts are created for parity and review. They are
> **NOT executed** in this stream. No production or local database was touched
> by migration commands. `MIGRATION_EXECUTION = False`.

| Migration | Status | Contents |
|---|---|---|
| `db/migrations/0035_r7_d_experimentation.sql` | **CREATED, NOT EXECUTED** | 5 new tables: `experiments` (unique `experimentId` `exp_experiment_id_uidx`; unique natural key `(userId, learningId, hypothesisId, designHash)` `exp_natural_key_uidx`; indexes `exp_user_business_idx`, `exp_user_status_idx`), `experiment_lifecycle_events` (unique `experimentLifecycleEventId` `exl_event_id_uidx`; index `exl_user_experiment_idx`), `experiment_assignments` (unique `(userId, experimentId, subjectKey)` `exa_assignment_uidx`; index `exa_experiment_idx`), `experiment_outcome_evidence` (unique `(userId, experimentId, outcomeId)` `exe_evidence_uidx`; index `exe_experiment_idx`), `experiment_results` (unique `resultId` `exr_result_uidx`; unique `(userId, experimentId, calculationVersion)` `exr_natural_uidx`; index `exr_experiment_idx`). |

- **Exact schema delta** (append-only on `db/schema.ts`): five new tables
  only. No existing table, column, index, or the canonical R6 migration
  `0034_r6_lead_autonomy_foundation`, was altered. No FK constraints (house
  convention: opaque references, predicate-enforced ownership).
- Journal parity: `db/migrations/meta/_journal.json` idx 35 + snapshot
  `0035_snapshot.json` were generated together with the SQL (drizzle-kit
  generate, offline; no database connection was opened).
- **Collision documented, NOT resolved here:** the sibling R7 streams each
  independently carry a stream-local provisional `0035_*` migration
  (`0035_r7_a_conversion_outcome_foundation`, `0035_r7_b_attribution_foundation`,
  `0035_r7_c_business_learning_foundation`, `0035_r7_f_optimisation_governance`).
  R7-X owns final R7 migration convergence and renumbering; this stream must
  not renumber or modify any sibling artefact. The sibling tables
  (`business_outcomes`, `attribution_results`, `business_learning_records`,
  `optimisation_governance_decisions`) are consumed by R7-D exclusively
  through guarded read seams that fail closed when the tables are absent —
  until R7-X materialises them, the experimentation runtime degrades
  gracefully and fail-closed: experiments cannot be created, governed,
  activated, or fed evidence, and nothing is fabricated.
- Execution is deferred to the integration/deployment authority. Until
  executed, persistence is exercised in tests via injected in-memory fakes
  only.
