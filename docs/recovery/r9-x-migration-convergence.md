# R9-X Migration Convergence (X5 — Canonical 0037)

**Date:** 2026-11-12
**Integration branch:** `integration/r9-mission-control`
**Canonical migration:** `0037_r9_mission_control_foundation` (ONE migration)

---

## 1. Inputs and method

Six stream-local provisional migrations were intentionally unexecuted; R9-X owns
convergence:

| # | Provisional migration | Stream |
|---|----------------------|--------|
| 1 | `0037_r9_a_mission_authority_foundation` | R9-A |
| 2 | `0037_r9_b_mission_planning_foundation` | R9-B |
| 3 | `0037_r9_c_dependency_scheduling_foundation` | R9-C |
| 4 | `0037_r9_d_execution_coordination_foundation` | R9-D |
| 5 | `0037_r9_e_mission_state_recovery_foundation` | R9-E |
| 6 | `0037_r9_f_mission_governance_foundation` | R9-F |

Method (repository-native only):

1. Inventoried every statement (table / column / index / unique constraint /
   enum alteration / default) in each provisional — 45 statements total.
2. Retired all six provisionals and the stream-local F `0037_snapshot.json`;
   removed the F `0037` journal entry (journal chain 0–36, R8 canonical 0036
   **unchanged**).
3. Regenerated the migration shell + snapshot with `drizzle-kit generate
   --custom --name r9_mission_control_foundation` (offline; no database
   contact) so `db/migrations/meta/0037_snapshot.json` is byte-consistent
   with the integrated `db/schema.ts` by construction.
4. Populated the canonical SQL with the reconciled union of all provisional
   statements (44 CREATEs + 1 ALTER), stream order A→B→C→D→E→F, F's
   `approval_requests.approvalType` enum extension placed last.
5. Statically validated (below). **Not executed.**

## 2. Canonical object inventory

- **17 tables:** mission_proposals, mission_lifecycle_events (A);
  mission_plans, mission_plan_tasks, mission_plan_lifecycle_events (B);
  mission_task_plan_snapshots, mission_dependency_edges, mission_schedules,
  mission_schedule_lifecycle_events (C); execution_actions, execution_attempts,
  execution_lifecycle_events (D); mission_state_records, mission_task_states,
  mission_recovery_candidates, mission_operational_timeline_events (E);
  mission_governance_decisions (F).
- **27 non-unique indexes** + **34 unique constraints** (durable exact-once
  anchors, including every convergence/replay identity unique).
- **1 enum alteration:** `approval_requests.approvalType` extended with
  `'mission_action'` (F's accepted extension — required by D/E consumption).
- **0 foreign keys** (tenant-scoped identity is enforced in the service layer;
  matches the R6–R8 canonical pattern). **0 duplicate objects.**

## 3. Per-provisional coverage proof

Every schema object, constraint, index, enum alteration and dependency of each
provisional exists **exactly once** in the canonical 0037 (automated
statement-level diff; counts below are tables / indexes+uniques):

```
provisional_migration=0037_r9_a_mission_authority_foundation
objects_defined=2 tables, 7 constraints/indexes (incl. mp_mission_identity_uidx,
  mp_user_mission_uidx, mle_lifecycle_identity_uidx)
canonical_objects=mission_proposals, mission_lifecycle_events + all 7
coverage=COMPLETE
retirement_allowed=True

provisional_migration=0037_r9_b_mission_planning_foundation
objects_defined=3 tables, 10 constraints/indexes (incl. mplans_plan_identity_uidx,
  mplans_user_plan_uidx, mplans_user_mission_version_uidx, mptasks_task_identity_uidx,
  mptasks_user_task_uidx, mpl_lifecycle_identity_uidx)
canonical_objects=mission_plans, mission_plan_tasks, mission_plan_lifecycle_events + all 10
coverage=COMPLETE
retirement_allowed=True

provisional_migration=0037_r9_c_dependency_scheduling_foundation
objects_defined=4 tables, 13 constraints/indexes (incl. snapshot fingerprint uniques,
  dependency natural-key unique, schedule identity unique, msle lifecycle unique)
canonical_objects=mission_task_plan_snapshots, mission_dependency_edges,
  mission_schedules, mission_schedule_lifecycle_events + all 13
coverage=COMPLETE
retirement_allowed=True

provisional_migration=0037_r9_d_execution_coordination_foundation
objects_defined=3 tables, 11 constraints/indexes (exa1/idem1/exr1/ext1/exl1 anchors)
canonical_objects=execution_actions, execution_attempts, execution_lifecycle_events + all 11
coverage=COMPLETE
retirement_allowed=True

provisional_migration=0037_r9_e_mission_state_recovery_foundation
objects_defined=4 tables, 13 constraints/indexes (rcn1/mot1/state identity anchors)
canonical_objects=mission_state_records, mission_task_states,
  mission_recovery_candidates, mission_operational_timeline_events + all 13
coverage=COMPLETE
retirement_allowed=True

provisional_migration=0037_r9_f_mission_governance_foundation
objects_defined=1 table, 7 constraints/indexes + 1 enum alteration
  (mgd1 identity unique + approvalType 'mission_action' extension)
canonical_objects=mission_governance_decisions + all 7 + the enum alteration verbatim
coverage=COMPLETE
retirement_allowed=True
```

## 4. Schema parity

- Integrated `db/schema.ts` ↔ canonical 0037: all 17 canonical tables present
  in `db/schema.ts`; **column-level parity verified for all 17 tables, both
  directions** (e.g. mission_proposals 40/40, mission_schedules 28/28,
  execution_actions 26/26, mission_governance_decisions 24/24 — full table
  in the convergence commit); index/unique names excluded from the column
  diff and verified separately via the constraint inventory above. The
  `0037_snapshot.json` was generated from `db/schema.ts` by `drizzle-kit`
  itself, so schema↔snapshot consistency holds by construction.
- `drizzle-kit check` (offline journal/snapshot consistency): **PASS**
  ("Everything's fine").
- No R8 0036 object was modified; journal chain 0035 → 0036 → 0037( canonical )
  is contiguous and gap-free.

## 5. Verdict

```
PROVISIONAL_MIGRATION_COUNT=6
CANONICAL_MIGRATION=0037_r9_mission_control_foundation
SEMANTIC_COVERAGE=COMPLETE (6/6 provisionals, every object exactly once)
SCHEMA_MATCH=PASS (db/schema.ts ↔ canonical 0037, drizzle snapshot consistent)
STATIC_VALIDATION=PASS (statement diff + duplicate scan + drizzle-kit check)
PROVISIONAL_MIGRATIONS_RETIRED=6 (all retirement_allowed=True)
MIGRATION_EXECUTION=False
```
