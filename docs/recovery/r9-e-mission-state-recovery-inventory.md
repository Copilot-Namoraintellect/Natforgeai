# R9-E MISSION STATE, RECOVERY & OBSERVABILITY — E0 INVENTORY

> **Stream:** R9-E (`feature/r9-e-mission-state-recovery`)
> **Programme base:** `4fc43c3b252baa81906cd409ca2ec290baa77825`
> **Status:** pre-implementation inventory (E0). Consumes all upstreams by
> frozen branch ref only — nothing merged.

---

## 1. Frozen upstream authorities (resolved)

| Stream | Branch | Accepted HEAD | Verdict |
|---|---|---|---|
| R9-A Mission Authority | `feature/r9-a-mission-authority` | `273ce4074b48d80923325b099a03d36fdee030bb` | MISSION_AUTHORITY_READY |
| R9-B Mission Planning | `feature/r9-b-mission-planning` | `a358f53c3b46a2d137e039f50cd8bbed85ef3841` | MISSION_PLANNING_READY |
| R9-C Dependency & Scheduling | `feature/r9-c-dependency-scheduling` | `1c5837fa7bbb59385a4ad65496fc4b3630026712` | DEPENDENCY_SCHEDULING_READY |
| R9-D Execution Coordination | `feature/r9-d-execution-coordination` | `2b7735e54e001ffab6de643e882fab6c73a71c5b` | EXECUTION_COORDINATION_READY |
| R9-F Mission Governance | `feature/r9-f-mission-governance` | `1665d2f9c7fe59e825c403ce966b0ebdead3d385` | MISSION_GOVERNANCE_READY |

Preflight cross-check: `git ls-remote origin` for each branch returned
exactly the SHAs above; R9-C/R9-D match the expected short prefixes
(`1c5837f`, `2b7735e`).

## 2. What exists on this branch (base 4fc43c3b)

- R8 Strategic Intelligence integrated (`STRATEGIC_INTELLIGENCE_V1_READY`),
  canonical migration `0036_r8_strategic_intelligence_foundation` (NOT
  executed; frozen — never modified by this stream).
- House infrastructure: tRPC + middleware (`authedQuery`), Drizzle +
  `getDb`, canonical `audit_events` ledger, `approval_requests` ledger,
  `conversion-contract` (`canonicalJson`/`sha256Hex`), `r5-test-support`
  fake-DB harness, proven seam pattern (production raw SQL behind guarded
  information-schema checks + in-memory fakes with identical row shapers).
- **No R9 tables/code exist on this branch.** All R9 upstream consumption
  is via branch-ref contracts + guarded raw-SQL seams that fail closed when
  a provisional table is absent.

## 3. R9-D execution-state projection (primary input)

`docs/contracts/mission-execution-to-state-recovery-contract.md` @
`2b7735e` — frozen projection `mission-execution-to-state-recovery/v1`,
exact 31-key allowlist, verbatim disclaimers. R9-D durable tables
(provisional `0037_r9_d_execution_coordination_foundation`):

- `execution_actions` — dispatch intents (immutable core, CAS `version`,
  `dispatchState` ∈ `NEVER_ATTEMPTED|DISPATCH_PREPARED|DISPATCHED|
  ACKNOWLEDGED|SUCCEEDED|FAILED|UNCERTAIN|CANCELLED`).
- `execution_attempts` — append-only attempts (`resultStatus` ∈
  `SUCCEEDED|FAILED_RETRYABLE|FAILED_FINAL|PENDING_EXTERNAL|UNCERTAIN`;
  closed `failureClass`/`uncertaintyClass`; `resultHash` tamper binding).
- `execution_lifecycle_events` — append-only `exl1:` facts
  (`dispatch_state_changed|result_recorded|retry_candidate_emitted`).

Semantics R9-E may rely on: conservative classification (UNCERTAIN /
PENDING_EXTERNAL never success), append-only history, per-attempt
projection rows, retry candidate = review signal only. R9-E must NOT rely
on it for authorization, causation or outcome truth; it must never write
any R9-D table.

## 4. Mission / plan / task / schedule lifecycle authorities

- **R9-A** (`mission_proposals`, `mis1:`): statuses `PROPOSED,
  ELIGIBLE_FOR_PLANNING, REVIEW_REQUIRED, BLOCKED, SUPERSEDED, STALE,
  CANCELLED, INVALIDATED` — **no EXECUTING, no COMPLETED**. Mission
  authority never reports completion; completion is an E-derived health
  class from authoritative task outcomes.
- **R9-B** (`mission_plans`, `mission_plan_tasks`): plan statuses `DRAFT,
  VALIDATED, READY_FOR_SCHEDULING, REVIEW_REQUIRED, BLOCKED, SUPERSEDED,
  STALE, CANCELLED, INVALIDATED`; task statuses `DEFINED, VALIDATED,
  READY_FOR_SCHEDULING, GOVERNANCE_REVIEW_REQUIRED, BLOCKED, SUPERSEDED,
  UNRESOLVED`. Task requiredness: a task is **required** unless its
  constraint set carries an explicit optional marker (`OPTIONAL`) — see §7.
- **R9-C** (`mission_schedules`, `mission_task_plan_snapshots`): schedule
  statuses `PROPOSED, VALIDATED, READY, BLOCKED, SUPERSEDED, STALE,
  INVALIDATED, CANCELLED`; per-task `blockingStates` (`readiness` +
  `reasons`); `dependencyRefs` (HARD/SOFT).

## 5. Governance / retry rules (R9-F)

- Decisions (closed): `ALLOW | REVIEW_REQUIRED | BLOCK` — no EXECUTE.
- Subject classes relevant to recovery: `RETRY`, `RECOVERY_ACTION`,
  `ESCALATION` (phases LIFECYCLE — floored at REVIEW_REQUIRED under the
  default policy: `RECOVERY_REQUIRES_FRESH_REVIEW`).
- Action types: `RETRY_STEP`, `RECOVER_STATE`, `ESCALATE_TO_HUMAN`.
- Frozen consumption gate `assertMissionActionConsumable`
  (`mission-governance-to-execution/v1`): exact subject/action/refs/params
  fingerprint match, current policy version, ALLOW validity window,
  REVIEW_REQUIRED approval binding revalidation (`approvalBindingHash =
  sha256({v:1, governanceDecisionId, policyVersion,
  actionParamsFingerprint, missionRiskClass})`, expiry, tenant). R9-D
  carries a faithful port; R9-E ports the same semantics for recovery
  consumption (single converter, no second engine).
- Approvals: shared `approval_requests` ledger, `approvalType =
  "mission_action"` (provisional enum extension), binding in
  `context.missionGovernanceBinding`. Human rejection permanently blocks.

## 6. Existing workflow state machines / retry-recovery infrastructure

Legacy surfaces inventoried for boundary purposes only — R9-E does not
reuse or mutate them: `autonomous_workflows` + queue/job replay
(`queue_replay_requests`), `operations_router` recovery vocabulary,
`lead_governance` retry, publishing callback machinery. None of these
carry R9 mission semantics; the R9 mission-state machine is new and
self-contained. R9-D's dispatch state machine (§3) is immutable input.

## 7. Distinguishing the five planes (design invariant)

| Plane | Owner | Mutability |
|---|---|---|
| **Execution history** | R9-D | immutable; R9-E reads via frozen projection seams, never writes |
| **Derived operational state** (mission/task state) | R9-E | derived-only; insert-new-version per observation; never client/model-set |
| **Mission health** | R9-E | deterministic classification over derived state; never set directly |
| **Recovery proposal** | R9-E | advisory candidates + lifecycle facts; authorize nothing |
| **Recovery authorization** | R9-F | decisions + approval ledger; E consumes read-only through the frozen gate |

Observability (timeline) is a sixth, strictly read-side plane: it records
what the first five did and can never mutate any of them.

## 8. Schema / migration state

- Canonical R8 `0036` frozen; R9-D provisional `0037_r9_d_*` and R9-F
  provisional `0037_r9_f_*` exist on their branches (artefacts, NOT
  executed). This stream adds its own provisional
  `0037_r9_e_mission_state_recovery_foundation` (artefact only) with
  stream-local tables: `mission_state_records`, `mission_task_states`,
  `mission_recovery_candidates`, `mission_operational_timeline_events`.
  R9-X owns canonical 0037 convergence. `MIGRATION_EXECUTION=False`.

## 9. Gaps / decisions carried into E1

1. **Required vs optional tasks:** the upstream contracts define **no
   optionality marker** (R9-A constraint types are a closed 13-set with no
   OPTIONAL kind; R9-B/R9-C never mark tasks optional — verified against
   the frozen contracts). E therefore never invents optionality. The
   required task set is derived exactly: membership of the current
   schedule's `orderedTaskIds` in the current plan's task set. Execution
   actions bound to tasks **outside** the current schedule (plan-revision
   drift) are excluded from the completion/blocking set and surfaced as a
   visible drift note — this is the repository-native sense in which
   non-current work cannot falsely block completion ("where contract
   permits").
2. **COMPLETED health:** R9-A has no COMPLETED status — health COMPLETED
   is E-derived only when every **required** task (per §9.1) is SUCCEEDED
   from authoritative attempt evidence, no uncertainty is open, no
   blocking reason exists, and mission/plan/schedule authorities are
   current. Out-of-schedule drift degrades at most to DEGRADED, never
   blocks completion.
3. **Provider-pending timeout:** `PENDING_EXTERNAL` remains visible as
   uncertainty; a configurable horizon (default 24 h, policy-bound) marks
   the task STALE — visible, never auto-success.
4. **Real MySQL concurrency:** unavailable on this stream — structural
   CAS/replay/idempotency tests only; promoted to R10/pre-production.
