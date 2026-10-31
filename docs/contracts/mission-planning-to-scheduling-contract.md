# MISSION PLANNING → SCHEDULING CONTRACT (R9-B → R9-C/D)

> **Producer:** R9-B Mission Planning & Decomposition
> (`feature/r9-b-mission-planning`)
> **Consumer:** R9 Mission Control scheduling/execution streams (future,
> read-only)
> **Status:** canonical downstream contract — scheduling reads, never
> redefines or mutates
> **Projection version:** `mission-planning-to-scheduling/v1`
> **Source of truth:** `docs/contracts/mission-planning-contract.md` (R9-B
> canonical) + `api/lib/mission-planning/mission-planning-projection.ts`
> (`MISSION_PLANNING_TO_SCHEDULING_FIELD_KEYS` — asserted exact in acceptance)

---

## 1. Purpose and boundaries

R9-B owns mission plans and task definitions. This contract is the **only**
surface through which downstream scheduling (dependency ordering,
sequencing, commit) and execution coordination consume plans. Downstream may
read and must never mutate: no scheduling call may write `mission_plans`,
`mission_plan_tasks`, `mission_plan_lifecycle_events`, or any upstream
authority table, and no consumer may mint plan/task identities, objectives,
inputs/outputs, capabilities, constraints, classifications, statuses,
validity or lifecycle facts.

```
plan != schedule
task definition != execution authorization
scheduling may order tasks; scheduling may NEVER rewrite task authority
```

## 2. Consuming surface

Scheduling reads **only** through the tenant-scoped tRPC procedure on the
`missionPlanning` router:

| Procedure | Read model |
|---|---|
| `missionPlanning.getSchedulingHandoff` | Frozen projection for ONE plan (`planId` input). No listing authority: scheduling discovers plan ids through its own authorised channels. |

The pure projection builder `buildSchedulingProjection`
(`api/lib/mission-planning/mission-planning-projection.ts`) is the frozen
builder; consumers may rebuild projections from durable rows but must never
extend the key allowlist.

## 3. Scheduling-eligibility gate

A projection is scheduling-consumable **only** when `status ===
"READY_FOR_SCHEDULING"` **and** `freshness === "current"` **and**
`planningClaimed === false` **and** `executionClaimed === false`. Consumers
must not infer eligibility from any other field. A `REVIEW_REQUIRED`,
`DRAFT`, `BLOCKED`, `STALE`, `SUPERSEDED`, `CANCELLED` or `INVALIDATED`
plan is never scheduling-consumable.

## 4. Projection field allowlist (exact, 24 keys)

| Key | Type | Semantics |
|---|---|---|
| `contractVersion` | `"mission-planning-to-scheduling/v1"` | Frozen projection version |
| `planId` | `pln1:…` | Opaque canonical plan identity — reference verbatim |
| `planVersion` | int | Plan version |
| `missionId` | `mis1:…` | Owning mission reference |
| `businessId` | number | Owning business (server-verified) |
| `status` | closed enum (9) | Plan lifecycle status (no EXECUTING) |
| `freshness` | `current\|stale` | Computed at read — never stored |
| `validUntil` | ISO-8601 | Plan validity window |
| `taskIds` | `tsk1:[]` | Ordered task identities |
| `tasks` | array | Frozen task views (§4.1) |
| `unresolvedItems` | array | Bounded unresolved planning work |
| `completenessStatus` | closed enum (3) | Planning completeness |
| `missionConstraints` | array | Verbatim mission constraint set |
| `planningAssumptions` | array | Client-declared assumptions, verbatim |
| `missionObjective` | object | `{objectiveId, objectiveStatement, objectiveType}` — verbatim from R9-A |
| `schedulingEligibility` | bool | §3 gate result |
| `planningClaimed` | `false` | always false |
| `planningDisclaimer` | string | verbatim (§5) |
| `executionClaimed` | `false` | always false |
| `executionDisclaimer` | string | verbatim (§5) |
| `limitations` | string[] | Bounded projection limitations |
| `missionAuthorityVersion` | `<sha256>` | Bound R9-A mission material fingerprint (staleness binding) |
| `supersedesPlanId` | `pln1:\|null` | Exact predecessor plan version |
| `eligibleTaskIds` | `tsk1:[]` | Task ids schedulable under §3 (empty when ineligible) |

### 4.1 Task view (exact, 20 keys)

| Key | Type |
|---|---|
| `taskId` | `tsk1:…` |
| `taskType` | closed enum (12) |
| `taskSequence` | int |
| `taskObjective` | string (server-derived canonical) |
| `requiredInputs` | enum[] |
| `expectedOutputs` | enum[] |
| `requiredCapabilities` | string[] |
| `constraints` | array (verbatim mission constraint set) |
| `preconditions` | `{condition, ref}`[] |
| `postconditions` | `{condition, ref}`[] |
| `governanceClass` | closed enum (3) |
| `sideEffectClass` | closed enum (6) |
| `executionClass` | closed enum (4) |
| `capabilityStatus` | closed enum (4) |
| `governanceCharacteristics` | object (§7 of canonical contract) |
| `status` | closed enum (7) |
| `schedulable` | bool — `true` only when the task is `READY_FOR_SCHEDULING`-capable and the plan is scheduling-eligible |
| `planId` | `pln1:…` (ownership reference, verbatim) |
| `missionId` | `mis1:…` (ownership reference, verbatim) |
| `businessId` | number (server-verified) |

## 5. Verbatim disclaimers (on every projection)

```
planningClaimed: false
planningDisclaimer: "A mission plan is bounded task-definition authority,
  not a schedule and never execution authorization. Dependency ordering,
  sequencing, scheduling commits and any execution remain downstream
  authority under separate governance."
executionClaimed: false
executionDisclaimer: "A mission plan is never an execution authorization: no
  task, campaign, budget, Business DNA, experiment, provider, payment or
  billing state may be mutated from this projection. plan != schedule;
  task definition != execution authorization."
```

## 6. Hard rules for scheduling

1. **Read-only.** No scheduling write path to any R9-B or upstream table.
2. **Authority is immutable.** Scheduling may order, sequence and commit
   schedules over the given tasks; it may never rewrite task authority
   (objectives, inputs/outputs, capabilities, constraints,
   classifications). Deviations require a new governed plan version
   (`revise`), never in-place edits.
3. **Staleness demotes.** `freshness: "stale"` projections (or
   non-eligible statuses) must not anchor scheduling.
4. **Unresolved work stays unresolved.** Scheduling must not convert
   `unresolvedItems` into tasks.
5. **Governance binds downstream.** Tasks carry pre-classification
   characteristics for R9-F consumption; a consumable R9-F verdict remains
   required before any material effect.
6. **plan != schedule; task definition != execution authorization.**
