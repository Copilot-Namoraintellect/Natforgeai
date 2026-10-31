# MISSION PLANNING & DECOMPOSITION CONTRACT (R9-B)

> **Owner:** R9-B Mission Planning & Decomposition (`feature/r9-b-mission-planning`)
> **Authority:** turns an eligible governed R9-A mission into an explicit,
> bounded, dependency-aware plan composed of task definitions and plan steps
> **Contract version:** `mission-planning/v1`
> **Engine version:** `mission-planning-engine/v1`
> **Downstream projection:** `mission-planning-to-scheduling/v1`
> **Upstream (frozen, consumed not merged):** R9-A mission authority
> (`mission-authority/v1` + `mission-authority-to-planning/v1`, frozen R9-A
> HEAD `273ce40`) via the canonical durable rows and the frozen planning
> projection; R9-F mission governance (`mission-governance/v1`, frozen R9-F
> HEAD `1665d2f`) by contract reference only — for pre-classification
> vocabulary, never for decisions.

---

## 1. Purpose and boundaries

R9-B owns **mission-plan identity, plan versioning and task-definition
authority**: what work is required to achieve a mission objective, the exact
scope of each task, task inputs/outputs, required capabilities, task
constraints, pre/postconditions, planning assumptions, planning
completeness, task-plan lineage and the read-only downstream scheduling
projection.

**Core authority rules (preserved verbatim on every surface):**

```
mission != task
task definition != execution authorization
plan != schedule
recommendation != execution authorization
```

A task may exist in a plan and still be blocked from execution. A plan may
be complete and still lack every kind of execution authority. There is **no
`EXECUTING` status** in this contract: planning never runs tasks, never
schedules them, never retries, never recovers, never invokes providers,
never moves budget, never approves anything, never mutates missions,
campaigns, Business DNA, strategy, CRM or any upstream authority.

### 1.1 Explicit non-ownership

| Never owned | Owning authority |
|---|---|
| Mission objective, mission scope, mission constraints | R9-A (mission authority) |
| Strategic evidence, candidates, conclusions | R8 authorities |
| Governance decisions, approvals, risk classes, `ALLOW` | R9-F |
| Dependency ordering, scheduling, sequencing | R9-C scheduling |
| Execution, retries, recovery, provider calls | R9-D/E execution |
| Budget settlement / billing | R4 billing authority |
| Business DNA / strategy mutation | Operator / strategy authority |

---

## 2. Mission plan record

| Field | Type | Semantics |
|---|---|---|
| `planId` | `pln1:<sha256>` | Deterministic plan identity (§3) |
| `planVersion` | int ≥ 1 | Monotonic per mission; `revise` mints N+1 with `supersedesPlanId` |
| `tenantId` | number | Session-anchored (`ctx.user.id`); **never client-supplied** |
| `businessId` | number | Owning business — must equal the mission's business; re-verified every call |
| `missionId` | `mis1:<sha256>` | R9-A mission reference, verbatim |
| `missionAuthorityVersion` | `<sha256>` | The R9-A `missionFingerprint` (immutable mission material core) this plan binds |
| `boundMissionVersion` | int | The R9-A optimistic `version` observed at formation — drift detection metadata, **not** an identity input (benign lifecycle CAS bumps must not re-mint plans) |
| `planScopeKey` | string | Canonical planning scope key (§3) — structurally incapable of exceeding mission scope |
| `taskIds` | `tsk1:[]` | Ordered task identities of this plan version |
| `taskSetFingerprint` | `<sha256>` | Fingerprint of the canonical task set (§3) |
| `constraintSetFingerprint` | `<sha256>` | Fingerprint of the verbatim mission constraint set |
| `missionConstraints` | array | **Verbatim** mission constraint set (immutable input) |
| `planningAssumptions` | array ≤ 8 | Client-declared bounded statements, preserved verbatim |
| `unresolvedItems` | array ≤ 16 | Bounded unresolved planning work (§6) |
| `completenessStatus` | closed enum (3) | `COMPLETE` / `COMPLETE_WITH_UNRESOLVED` / `INCOMPLETE` (§7) |
| `status` | closed enum (9) | Plan lifecycle (§8) — **no EXECUTING** |
| `validFrom` | ISO-8601 UTC | Formation time |
| `validUntil` | ISO-8601 UTC | `min(mission.validUntil, validFrom + 30d)` — a plan never outlives its mission |
| `supersedesPlanId` | `pln1:` \| null | Exact predecessor plan version on governed revision |
| `planFingerprint` | `<sha256>` | Immutable plan core fingerprint — replay-conflict anchor (§3) |
| `modelAssistanceFlagged` | boolean | Injection-pattern suspicion label on advisory model wording (never blocks by itself; preserved verbatim) |
| `version` | int | Optimistic CAS for lifecycle transitions |
| `createdAt` / `updatedAt` | ISO-8601 | Persistence timestamps |

### 2.1 Task record

| Field | Type | Semantics |
|---|---|---|
| `taskId` | `tsk1:<sha256>` | Deterministic task identity (§3) |
| `planId` / `planVersion` | `pln1:` / int | Owning plan version, verbatim |
| `missionId` | `mis1:` | Mission reference, verbatim |
| `taskType` | closed enum (12) | Rule-template task type (§4) |
| `taskSequence` | int | Deterministic derivation order within the plan |
| `taskObjective` | string ≤ 500 | **Server-derived canonical objective** from the rule template + mission material — never free client/model text |
| `objectiveWordingDraft` | string ≤ 500 \| null | Advisory model rewording (inert bounded text; never authority; never an identity input) |
| `requiredInputs` | enum[] | Closed artifact vocabulary (§5) |
| `expectedOutputs` | enum[] | Closed artifact vocabulary (§5) |
| `requiredCapabilities` | string[] | Closed capability vocabulary (§6) |
| `constraints` | array | **Verbatim** mission constraint set inherited by the task |
| `preconditions` | `{condition, ref}`[] | Closed condition vocabulary (§5) |
| `postconditions` | `{condition, ref}`[] | Closed condition vocabulary (§5) |
| `governanceClass` | closed enum (3) | Planning-side pre-classification for R9-F (§7) |
| `sideEffectClass` | closed enum (6) | Planning-side pre-classification (§7) |
| `executionClass` | closed enum (4) | Execution posture — authority boundary marker (§7) |
| `capabilityStatus` | closed enum (4) | Feasibility classification of the task's capabilities (§6) |
| `governanceCharacteristics` | object | Declarative characteristics R9-F may consume as material (§7) |
| `status` | closed enum (7) | Planning-side task status (§8) |
| `taskFingerprint` | `<sha256>` | Immutable task core fingerprint |

---

## 3. Deterministic identity (B2)

```
planId = "pln1:" + sha256(canonicalJson({
  v: 1,
  tenantUserId,            // session anchor
  businessId,
  missionId,               // governed R9-A mission (reference only)
  missionAuthorityVersion, // R9-A missionFingerprint — the immutable mission core
  planScopeKey,            // canonical planning scope (never client/model text)
  taskSetFingerprint,      // canonical derived task set
  constraintSetFingerprint // verbatim mission constraint set fingerprint
}))

planScopeKey = "<missionScopeKey>"            // carried from R9-A scopeKey, verbatim
             + "|planning:v1"

taskSetFingerprint = sha256(canonicalJson({ v:1, tasks: [
  // one canonical task core per derived task, sorted by taskId:
  { taskId, taskType, taskObjective,
    inputsFingerprint, outputsFingerprint, constraintsFingerprint }
] }))

constraintSetFingerprint = sha256(canonicalJson({ v:1, constraints: [
  // verbatim mission constraints, canonically normalized + sorted
  // (same derivation as R9-A deriveConstraintSetFingerprint)
] }))

taskId = "tsk1:" + sha256(canonicalJson({
  v: 1,
  tenantUserId,
  businessId,
  missionId,
  planId,
  taskType,
  taskObjective,          // server-derived canonical objective
  inputsFingerprint,      // sha256 over canonical requiredInputs
  outputsFingerprint,     // sha256 over canonical expectedOutputs
  constraintsFingerprint  // sha256 over the task's verbatim constraint set
}))

planFingerprint = sha256(canonicalJson({ v:1, planId, missionId,
  missionAuthorityVersion, taskSetFingerprint, constraintSetFingerprint,
  unresolvedItems }))

taskFingerprint = sha256(canonicalJson({ v:1, taskId, taskType, taskObjective,
  requiredInputs, expectedOutputs, requiredCapabilities, constraints,
  preconditions, postconditions, governanceClass, sideEffectClass,
  executionClass, capabilityStatus }))

mpl1 lifecycle fact identity = "mpl1:" + sha256(canonicalJson({
  v: 1, planId, lifecycleType, targetStatus, successorPlanId,
  occurredAt, reasonCode }))
```

**Same authoritative plan basis converges.** Same tenant + business + mission
+ mission authority fingerprint + plan scope + derived task set + constraint
set ⇒ same `planId`. Durable convergence anchor: unique `(userId, planId)`;
retried/raced identical formation converges (`idempotent_replay`, zero extra
events). A formation arriving under the same anchor with a different
`planFingerprint` fails closed (`PLAN_REPLAY_CONFLICT`).

**Conflicting replay fails closed.** A mission whose durable authority row
changed material under the same `missionId` (`missionFingerprint` drift)
cannot anchor a plan: `PLAN_MISSION_AUTHORITY_DRIFT`. Legitimate mission
change is R9-A governed supersession (a **new** `mis1:` identity), which
plans reference exactly — never by in-place edits.

**Task wording never controls identity.** `taskObjective` is deterministically
derived from the rule template and mission material. Advisory rewording
travels separately (`objectiveWordingDraft`) and is never hashed.

**No client-generated authority.** No client- or model-minted identity,
status, fingerprint, classification, constraint, capability, schedule or
execution field exists anywhere in this stream (`z.strictObject` boundary).

---

## 4. Closed vocabularies and rule-first decomposition (B3)

### 4.1 Task types (12)

`RESEARCH`, `ANALYSE`, `VALIDATE`, `PREPARE_CONTENT`, `REVIEW_CONTENT`,
`CONFIGURE_CAMPAIGN`, `REQUEST_APPROVAL`, `SCHEDULE_ACTION`, `MONITOR`,
`RECONCILE`, `REPORT`, `ESCALATE`.

These map only to capabilities that exist in this repository (§6). Unknown
task types are rejected at the boundary (`UNKNOWN_TASK_TYPE`); known types
whose required capabilities are not present become **unresolved planning
work** (§6) — never silently executable tasks.

### 4.2 Rule decomposition table (deterministic, rule-first)

Task sets derive from the closed mission vocabulary (R9-A §5.1) plus mission
constraints. Mission types not listed fail closed (`MISSION_NOT_PLANNABLE`).

| Mission type | Derived task sequence (in `taskSequence` order) |
|---|---|
| `OPPORTUNITY_PURSUIT` | RESEARCH → ANALYSE → PREPARE_CONTENT → REVIEW_CONTENT → CONFIGURE_CAMPAIGN → MONITOR → REPORT |
| `MARKET_EXPANSION` | RESEARCH → ANALYSE → PREPARE_CONTENT → REVIEW_CONTENT → CONFIGURE_CAMPAIGN → MONITOR → REPORT |
| `POSITIONING_ACTION` | RESEARCH → ANALYSE → PREPARE_CONTENT → REVIEW_CONTENT → REPORT |
| `RISK_RESPONSE` | RESEARCH → ANALYSE → VALIDATE → CONFIGURE_CAMPAIGN → MONITOR → REPORT → ESCALATE |
| `DEFENSIVE_RESPONSE` | RESEARCH → VALIDATE → CONFIGURE_CAMPAIGN → MONITOR → ESCALATE → REPORT |
| `CAPABILITY_ACTION` | RESEARCH → ANALYSE → VALIDATE → CONFIGURE_CAMPAIGN → RECONCILE → REPORT |
| `CHANNEL_SHIFT` | RESEARCH → ANALYSE → CONFIGURE_CAMPAIGN → MONITOR → RECONCILE → REPORT |
| `PORTFOLIO_REBALANCE` | ANALYSE → RECONCILE → REPORT → ESCALATE |

Constraint-driven task additions (deterministic; duplicates collapse):

| Mission constraint present | Effect |
|---|---|
| `HUMAN_REVIEW_REQUIRED` | `REQUEST_APPROVAL` inserted before the first side-effecting task |
| `MEASURABLE_OUTCOME_REQUIRED` | `MONITOR` and `REPORT` ensured (appended if absent) |
| `BUDGET_CEILING` | `RECONCILE` ensured (appended if absent) |
| `PROHIBITED_ACTION` | candidate tasks whose action class matches the prohibited content are **excluded** and recorded in `unresolvedItems` (`PROHIBITED_BY_MISSION_CONSTRAINT`) |

### 4.3 Task templates

Each task type carries a fixed server-side template: canonical objective
wording pattern, required inputs, expected outputs, required capabilities,
preconditions and postconditions. Templates are code-level, versioned and
immutable per engine version; there is no runtime template mutation
endpoint. (Template constants: `api/lib/mission-planning/mission-planning-templates.ts`.)

---

## 5. Artifact and condition vocabularies

### 5.1 Artifact types (task inputs/outputs)

`MISSION_AUTHORITY`, `RESEARCH_FINDINGS`, `ANALYSIS_REPORT`,
`CONTENT_DRAFT`, `REVIEWED_CONTENT`, `CAMPAIGN_CONFIGURATION`,
`APPROVAL_DECISION`, `OBSERVATION_METRICS`, `RECONCILIATION_REPORT`,
`FINAL_REPORT`, `ESCALATION_NOTICE`, `PLAN_RECORD`.

### 5.2 Condition types (preconditions / postconditions)

`MISSION_CURRENT`, `INPUT_ARTIFACT_READY`, `PRIOR_TASKS_COMPLETED`,
`GOVERNANCE_VERDICT_REQUIRED`, `HUMAN_REVIEW_COMPLETED`,
`PROVIDER_AVAILABLE`, `ARTIFACT_PRODUCED`, `EVIDENCE_RECORDED`,
`READY_FOR_SCHEDULING`, `GOVERNANCE_CLASSIFICATION_RECORDED`.

Each condition may carry `ref: string | null` — a bounded reference to an
artifact type or `taskType` from the closed vocabularies; free text refs are
rejected.

---

## 6. Feasibility / capability validation (B6)

### 6.1 Capability registry (closed, code-level)

| Capability | Status | Basis in repository |
|---|---|---|
| `planning_validation` | SUPPORTED | Deterministic server-side validation (this stream) |
| `market_research` | CONDITIONALLY_SUPPORTED | External evidence ingestion exists (R8-C); availability depends on configured sources |
| `analytics_observation` | SUPPORTED | `analytics` router/metrics |
| `content_generation` | SUPPORTED | Content Studio / AI generation (`content-router`) |
| `human_review` | SUPPORTED | Approval ledger + OTP review authority |
| `campaign_configuration` | SUPPORTED | `campaign-router` CRUD (configuration only — activation is governed separately) |
| `governance_evaluation` | SUPPORTED | R5-E/R7-F/R8-F policy + approval infrastructure |
| `social_publishing` | CONDITIONALLY_SUPPORTED | Provider-dependent (Meta/LinkedIn integrations); execution also requires R9-F authorization |
| `email_messaging` | CONDITIONALLY_SUPPORTED | Provider-dependent (email transport requires configuration) |
| `crm_record_management` | SUPPORTED | `lead-router` CRM |
| `image_generation` | SUPPORTED | `image-router` |
| `video_generation` | CONDITIONALLY_SUPPORTED | Feature-flagged (`ENABLE_*_VIDEO`) |
| `budget_reallocation` | CONDITIONALLY_SUPPORTED | R7-E exists; execution under R7-F governance |
| `task_scheduling` | UNRESOLVED | R9-C scheduling is a downstream stream — not yet present |
| `whatsapp_messaging` | UNSUPPORTED | Provider unsupported (R6-X provider truth) |
| `sms_messaging` | UNSUPPORTED | Provider unsupported |
| `shell_execution`, `sql_execution`, arbitrary command execution | — **not capabilities** | Any request resolving here fails closed |

### 6.2 Feasibility classification

`SUPPORTED` — all required capabilities supported.
`CONDITIONALLY_SUPPORTED` — ≥ 1 required capability provider/flag/config-dependent; the task **may exist as a definition** and must carry `executionClass` marking the condition.
`UNRESOLVED` / `UNSUPPORTED` — the work **cannot become a task definition**; it is recorded in `unresolvedItems` with reason `UNSUPPORTED_CAPABILITY`.

Planning never fabricates capability. A provider-dependent task explicitly
indicates that execution still requires provider availability **and** R9-F
authorization (`executionClass = REQUIRES_PROVIDER_AVAILABILITY`).

---

## 7. Governance pre-classification (B7) — material only

Every task carries planning-side characteristics R9-F may consume as
**proposal material**:

| Characteristic | Values |
|---|---|
| `governanceClass` | `AUTONOMY_CANDIDATE` \| `STANDARD_REVIEW` \| `HUMAN_REVIEW_REQUIRED` |
| `sideEffectClass` | `NONE` \| `INTERNAL_DATA` \| `EXTERNAL_COMMUNICATION` \| `PROVIDER_MUTATION` \| `FINANCIAL` \| `CAMPAIGN_ACTIVATION` |
| `executionClass` | `INTERNAL_ONLY` \| `GOVERNANCE_GATED` \| `REQUIRES_PROVIDER_AVAILABILITY` \| `SCHEDULING_BOUNDARY` |
| `governanceCharacteristics` | `{ financialEffect: NONE\|INDIRECT\|DIRECT_SPEND, externalCommunication: bool, providerUse: bool, irreversibleMutation: bool, dataMutation: bool, customerImpact: bool, campaignActivation: bool, reviewHints: string[] }` |

Derivation is deterministic per task type + inherited mission constraints
(e.g. `HUMAN_REVIEW_REQUIRED` ⇒ every side-effecting task
`HUMAN_REVIEW_REQUIRED`; mission `strategicRisk` `HIGH`/`CRITICAL` ⇒ plan
lands `REVIEW_REQUIRED`).

**Hard boundary:** no task sets a governance decision; no task sets `ALLOW`;
no task sets a risk class; no task or plan is, or claims to be, execution
authorization. R9-F remains the only authority that may evaluate
`MISSION_PLAN` / `TASK` subjects.

---

## 8. Plan and task lifecycle (B8)

Plan statuses (closed, exact): `DRAFT`, `VALIDATED`,
`READY_FOR_SCHEDULING`, `REVIEW_REQUIRED`, `BLOCKED`, `SUPERSEDED`, `STALE`,
`CANCELLED`, `INVALIDATED`.

```
 createPlan (eligible mission required)
      │
      ▼
   DRAFT ──(all work unresolved / INCOMPLETE)──┐
      │ validate                               │
      ▼                                        ▼
 VALIDATED ──(governance pre-classification    CANCELLED
      │        demands review)──┐                ▲
      ▼                         ▼                │
 READY_FOR_SCHEDULING      REVIEW_REQUIRED ──────┤
      │                    (exit path owned by   │
      │                     R9-X governance      │
      │                     binding; planning    │
      │                     never self-clears)   │
      ▼                                          │
 SUPERSEDED ◄── revise (planVersion N+1)         │
 BLOCKED ◄── mission BLOCKED / authority drift    │
 STALE ◄── validity lapsed / mission STALE       │
 INVALIDATED ◄── mission INVALIDATED / tamper ───┘
```

- Formation with at least one validated task and no blocking unresolved
  items lands `VALIDATED` (or `REVIEW_REQUIRED` when §7 pre-classification
  demands human review).
- Formation whose decomposition produced no task definitions (all candidate
  work unresolved) lands `DRAFT` with `completenessStatus = INCOMPLETE`.
- `markReadyForScheduling`: `VALIDATED` → `READY_FOR_SCHEDULING` only.
- `revise`: mints planVersion N+1 (`supersedesPlanId` = predecessor),
  predecessor → `SUPERSEDED`; history is never edited.
- Mission staleness/blocked/invalidated states demote the plan to
  `STALE`/`BLOCKED`/`INVALIDATED` (checked on read and on lifecycle calls).
- All transitions persist append-only `mpl1:` facts + one audit event each;
  convergence paths emit zero events; CAS drift fails closed
  (`PLAN_STATE_CONFLICT`).

Task statuses (closed, exact): `DEFINED`, `VALIDATED`,
`READY_FOR_SCHEDULING`, `GOVERNANCE_REVIEW_REQUIRED`, `BLOCKED`,
`SUPERSEDED`, `UNRESOLVED`. Task execution state (pending/running/…)
belongs to downstream streams and does not exist here.

---

## 9. Constraint preservation (B5)

- Every task inherits the **full verbatim** mission constraint set
  (`task.constraints`); the plan carries `missionConstraints` verbatim.
- A task that would violate mission scope is rejected
  (`MISSION_SCOPE_VIOLATION`): no task may widen geography, audience,
  business unit, subject type or channel beyond the R9-A-derived scope; all
  tasks bind `businessId` exactly; planning mints no budget amounts, no
  provider credentials, no permissions.
- Constraint weakening is impossible in this stream: no procedure accepts
  constraint removal or loosening. Legitimate change is upstream governed
  supersession (new `mis1:` / new plan version), never planning mutation.
- The mission objective statement travels verbatim into every plan surface;
  objective mutation fails closed (`MISSION_SCOPE_VIOLATION`).

---

## 10. Model-assisted planning boundary (B4)

Optional client input `modelAssistance` (strict schema):

```
{ proposedTaskTypes?: TaskType[≤12], proposedOrder?: TaskType[],
  draftWording?: string[≤500] }
```

The model may propose task ordering/content **from the closed vocabulary
only**. Server behaviour:

- every proposed task type is re-derived from the rule template server-side;
  the model can never supply objectives, inputs/outputs, capabilities,
  constraints, classifications, identities or status;
- proposed types beyond the rule set are added only when their capability
  status is `SUPPORTED`/`CONDITIONALLY_SUPPORTED`, else they become
  `unresolvedItems` (`MODEL_PROPOSAL_REJECTED` / `UNSUPPORTED_CAPABILITY`);
- `proposedOrder` is advisory metadata only — scheduling owns order; it is
  never persisted as authority;
- `draftWording` rewords at most one bounded objective label, is inert
  bounded printable text, injection-pattern suspicion is recorded
  (`modelAssistanceFlagged`), and it is never hashed into identity;
- arbitrary tool names, shell/SQL, user-supplied executable commands,
  provider names, budget amounts, permission or authority material are
  rejected at the boundary (`CLIENT_AUTHORITY_FIELD_FORBIDDEN`).

A model draft is never required for authority — deterministic decomposition
is complete without it.

---

## 11. Downstream scheduling contract

Read-only projection `mission-planning-to-scheduling/v1`
(`docs/contracts/mission-planning-to-scheduling-contract.md`). Scheduling may
order tasks; scheduling may **never** rewrite task authority (objectives,
inputs/outputs, capabilities, constraints, classifications).

---

## 12. Error taxonomy (closed)

| Code | HTTP | Meaning |
|---|---|---|
| `MISSION_NOT_FOUND` | 404 | Mission id unknown to the tenant |
| `MISSION_AUTHORITY_UNAVAILABLE` | 503 | R9-A durable authority absent (table missing / seam down) — fail closed |
| `MISSION_NOT_ELIGIBLE` | 409 | Mission not `ELIGIBLE_FOR_PLANNING`, stale, or not `RECOMMENDATION_ONLY` |
| `MISSION_NOT_PLANNABLE` | 422 | Mission type outside the rule decomposition table |
| `MISSION_SCOPE_VIOLATION` | 422 | Plan/task would widen mission scope or mutate the objective |
| `MISSION_CONSTRAINT_VIOLATION` | 422 | Constraint set tampered / not preserved verbatim |
| `PLAN_MISSION_AUTHORITY_DRIFT` | 409 | Mission material fingerprint drifted under the same `missionId` |
| `PLAN_REPLAY_CONFLICT` | 409 | Same plan anchor, different plan fingerprint |
| `PLAN_NOT_FOUND` | 404 | Plan id unknown to the tenant |
| `PLAN_STATE_CONFLICT` | 409 | CAS version drift on lifecycle transition |
| `PLAN_NOT_SCHEDULABLE` | 409 | Plan not in `READY_FOR_SCHEDULING` |
| `UNKNOWN_TASK_TYPE` | 422 | Task type outside the closed vocabulary |
| `CLIENT_AUTHORITY_FIELD_FORBIDDEN` | 403 | Client/model supplied an authority field |
| `INVALID_PLAN_INPUT` | 422 | Schema/closed-vocabulary violation |

## 13. Security / agent boundary (rogue-agent posture)

Assume a compromised planning agent. By construction it cannot: create or
widen mission authority (mission read-only through the frozen seam; scope
structurally bounded); remove or loosen constraints (verbatim inheritance
only); fabricate capability (closed registry, statuses derived); fabricate
providers; create executable shell/SQL (not capabilities — fail closed);
lower risk or set `ALLOW` (no risk vocabulary in this stream); self-approve
(no approval authority); create hidden tasks (every task derives from the
deterministic rule table and is hashed into the plan); add spend authority
(no money fields exist); bypass R9-F (no decision/verdict surface); access
secrets (no secret read path; provider credentials never enter planning);
modify permissions (session `userId` anchors every read/write;
`z.strictObject` rejects every authority field).

## 14. Schema / migration

Canonical tables in `db/schema.ts`: `mission_plans`, `mission_plan_tasks`,
`mission_plan_lifecycle_events`. Stream-local provisional artefact
`0037_r9_b_mission_planning_foundation.sql` — **artefact only, NOT executed**
(`MIGRATION_EXECUTION = FALSE`); R8 canonical `0036` is never modified;
R9-X owns canonical `0037` convergence with sibling R9 streams.

Audit: additive code-level `mission_plan_created`, `mission_plan_lifecycle`
(one per durable effect; convergence emits zero).
