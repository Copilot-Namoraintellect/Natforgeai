# R8-X Migration Convergence (X5 — Canonical 0036)

> One canonical migration replaces the six stream-local provisional 0036
> artefacts. Generated repository-natively with `drizzle-kit generate`
> (offline diff of `db/schema.ts` against the frozen `0035_r7_business_optimisation`
> snapshot). **NOT executed — MIGRATION_EXECUTION=False.**

PROVISIONAL_MIGRATION_COUNT=6
CANONICAL_MIGRATION=0036_r8_strategic_intelligence_foundation
SEMANTIC_COVERAGE=COMPLETE (6/6 provisionals, table + column + index + unique
constraint + enum alteration level)
SCHEMA_MATCH=TRUE (canonical generated from integrated `db/schema.ts`;
`drizzle-kit check` passes)
STATIC_VALIDATION=PASS (46 statements, 0 duplicates, balanced DDL,
journal chain idx 0..36 intact, snapshot contains exactly the 14 R8 tables)
MIGRATION_EXECUTION=False

## Canonical object inventory

- 14 CREATE TABLE (R8-A ×2, R8-B ×2, R8-C ×3, R8-D ×3, R8-E ×3, R8-F ×1):
  - `strategic_memory_records`, `strategic_memory_lifecycle_events`
  - `business_change_events`, `business_change_lifecycle_events`
  - `external_sources`, `external_signals`, `external_signal_lifecycle_events`
  - `strategic_reasoning_bundles`, `strategic_reasoning_records`,
    `strategic_reasoning_lifecycle_events`
  - `strategic_opportunity_risk_candidates`,
    `strategic_opportunity_risk_relations`,
    `strategic_opportunity_risk_lifecycle_events`
  - `strategic_governance_decisions`
- 1 enum alteration: `approval_requests.approvalType` extended with
  `strategic_recommendation` (F's accepted extension).
- 31 CREATE INDEX (A5 + B6 + C6 + D4 + E5 + F5).
- Unique constraints: 18 (incl. exact-once natural keys `smr_natural_key_uidx`,
  `bce_natural_key_uidx`, `xsg_natural_key_uidx` and identity anchors).
- 0 foreign keys (house convention: opaque identity references only).
- No execution columns anywhere (verified in provisionals; preserved in
  canonical by generation from the same schema).

## Reconciliation performed

- One schema reconciliation was required: R8-B's provisional artefact
  contained index `bce_user_value_fp_idx`
  (`userId, subjectType, subjectId, currentStateValueFingerprint`) which the
  B stream's accepted `db/schema.ts` snapshot had never included (the index
  appears nowhere else in B's code or docs). X5 owns object-name
  reconciliation; the index was restored into `db/schema.ts`
  (`businessChangeEvents.userValueFpIdx`) exactly as the provisional defined
  it — a pure additive index with no contract, shape, or behavioural change —
  so that both invariants hold: canonical matches schema.ts AND every object
  accepted in a provisional exists exactly once in the canonical migration.
- Journal/metadata: F's provisional journal entry (`0036_r8_f_strategic_governance_foundation`)
  and its single-stream snapshot were replaced by the canonical entry
  (`idx: 36, tag: 0036_r8_strategic_intelligence_foundation`) and a full
  101-table snapshot via `drizzle-kit generate`/`check` — the repository-native
  approach. R7's `0035` SQL and snapshot are byte-untouched.
- Duplicate SQL elimination: the six provisionals had zero overlapping
  statements (each owned disjoint tables); the canonical has 46 statements
  with 0 duplicates.

## Per-provisional coverage maps

provisional_migration=0036_r8_a_strategic_memory_foundation
objects_defined=strategic_memory_records(25 cols,3 unique), strategic_memory_lifecycle_events(10 cols,1 unique), 5 indexes
canonical_objects=present exactly once (columns verified 1:1)
coverage=COMPLETE
retirement_allowed=True

provisional_migration=0036_r8_b_business_change_foundation
objects_defined=business_change_events(27 cols,3 unique), business_change_lifecycle_events(10 cols,1 unique), 6 indexes (incl. bce_user_value_fp_idx reconciled into schema.ts)
canonical_objects=present exactly once (columns verified 1:1)
coverage=COMPLETE
retirement_allowed=True

provisional_migration=0036_r8_c_market_external_signal_foundation
objects_defined=external_sources(9 cols,2 unique), external_signals(33 cols,2 unique), external_signal_lifecycle_events(10 cols,1 unique), 6 indexes
canonical_objects=present exactly once (columns verified 1:1)
coverage=COMPLETE
retirement_allowed=True

provisional_migration=0036_r8_d_strategic_reasoning_foundation
objects_defined=strategic_reasoning_bundles(8 cols,2 unique), strategic_reasoning_records(24 cols,2 unique), strategic_reasoning_lifecycle_events(10 cols,1 unique), 4 indexes
canonical_objects=present exactly once (columns verified 1:1)
coverage=COMPLETE
retirement_allowed=True

provisional_migration=0036_r8_e_strategic_opportunity_risk_foundation
objects_defined=strategic_opportunity_risk_candidates(35 cols,2 unique), strategic_opportunity_risk_relations(8 cols,1 unique), strategic_opportunity_risk_lifecycle_events(10 cols,1 unique), 5 indexes
canonical_objects=present exactly once (columns verified 1:1)
coverage=COMPLETE
retirement_allowed=True

provisional_migration=0036_r8_f_strategic_governance_foundation
objects_defined=strategic_governance_decisions(21 cols,2 unique), approval_requests.approvalType enum alteration ('strategic_recommendation'), 5 indexes
canonical_objects=present exactly once (enum alteration statement present verbatim)
coverage=COMPLETE
retirement_allowed=True

## Dependency ordering

No inter-table dependencies exist (no FKs). Canonical ordering: all R8
tables precede the `approval_requests` enum alteration in the generated file;
the enum alteration depends only on the pre-existing `approval_requests`
table (created by an earlier, executed programme migration). R7 0035
unchanged and remains the diff base.

## Execution status

MIGRATION_EXECUTION=False. The canonical migration was statically validated
(`drizzle-kit check`, statement-level duplicate scan, column-level coverage
diff vs all six provisionals, journal-chain integrity) and **not executed**
against any database. Real-MySQL execution remains the mandatory R10 /
pre-production gate under the existing programme convention.
