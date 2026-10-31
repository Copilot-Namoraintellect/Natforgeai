# MISSION STATE, RECOVERY & OBSERVABILITY CONTRACT (WBS-R9-E)

> **Canonical contract for the R9-E mission-state/recovery/observability
> authority.**
> Branch `feature/r9-e-mission-state-recovery`; programme base `4fc43c3b`;
> frozen upstreams (consumed by branch ref only, never merged): R9-A
> `mission-authority/v1` @ `273ce40`, R9-B `mission-planning/v1` @
> `a358f53`, R9-C `mission-dependency-scheduling/v1` @ `1c5837f`, R9-D
> `mission-execution-coordination/v1` @ `2b7735e` +
> `mission-execution-to-state-recovery/v1` projection, R9-F
> `mission-governance/v1` @ `1665d2f` + `mission-governance-to-execution/v1`
> gate semantics.
> **Contract version:** `mission-state-recovery/v1`
> **Engine version:** `mission-state-recovery-engine/v1`
> **Downstream projection:** `mission-state-to-mission-control/v1`
> (see `docs/contracts/mission-state-to-mission-control-contract.md`)
> **Implementation:** `api/lib/mission-state-recovery/`; router
> `missionStateRecovery` (`api/mission-state-recovery-router.ts`).

---

## 1. Purpose and authority boundary

R9-E answers one question: **what is the mission's current operational
state, what went wrong, and what recovery is proposed — without ever
becoming the authority for any of it.** It derives durable, deterministic
operational state over the immutable execution outcomes produced by R9-D
and the lifecycle authorities owned by R9-A/B/C, proposes recovery
candidates, and keeps an append-only operational timeline.

**Core principles (preserved verbatim on every surface):**

```
execution history is immutable input
observability != authority
uncertainty != success
failure is never silently converted to success
recovery proposal != recovery authorization
retry proposal != retry authorization
authorized recovery != execution
mission state is derived — never set
```

R9-E must never: set mission state, task status, mission health or
recovery lifecycle directly; mark a task SUCCEEDED or a mission
COMPLETED; downgrade a final failure; convert uncertainty to success;
mint execution attempts or retry authority; authorize recovery (R9-F
owns authorization); execute recovery or anything else (R9-D owns
execution); mutate any R9-A/B/C/D/F row; invoke a provider; access
secrets; modify governance policy or permissions.

## 2. The five planes (ownership map)

| Plane | Owner | R9-E posture |
|---|---|---|
| Mission objective | R9-A | read-only via seam |
| Task definition / plan | R9-B | read-only via seam |
| Schedule / dependency evidence | R9-C | read-only via seam |
| Execution history | R9-D | immutable read-only input via frozen projection |
| Governance decisions / approvals | R9-F | read-only consumption via frozen gate |
| **Derived mission/task operational state** | **R9-E** | insert-new-version per observation; deterministic identity; never edited |
| **Mission health classification** | **R9-E** | pure deterministic function of derived state |
| **Failure / uncertainty classification** | **R9-E** | conservative, closed vocabularies; model may never downgrade |
| **Recovery candidate identity + proposals** | **R9-E** | advisory only; lifecycle facts |
| **Recovery authorization** | R9-F | decisions + approval ledger; E consumes, never mints |
| **Recovery execution** | R9-D | E hands governed recovery actions back to D |
| **Operational timeline** | R9-E | append-only observability; can mutate nothing |

## 3. Closed vocabularies (exact)

### 3.1 Task operational status (`taskOperationalStatuses`)

`PENDING` · `READY` · `DISPATCHED` · `PENDING_EXTERNAL` · `SUCCEEDED` ·
`FAILED_RETRYABLE` · `FAILED_FINAL` · `UNCERTAIN` · `BLOCKED` · `STALE` ·
`CANCELLED`

Derivation priority is rule-ordered (§6.2); the first matching rule wins.
No status outside this set may be persisted.

### 3.2 Mission health class (`missionHealthClasses`)

`HEALTHY` · `DEGRADED` · `BLOCKED` · `AT_RISK` · `FAILED` · `UNCERTAIN` ·
`COMPLETED`

### 3.3 Failure classification (`missionFailureClasses`)

`NONE` · `TRANSIENT` · `FINAL` · `AUTHORIZATION_EXPIRED` ·
`DEPENDENCY_INVALID` · `SCHEDULE_STALE` · `PROVIDER_PENDING` ·
`AMBIGUOUS_RESULT` · `CALLBACK_MISMATCH` · `CAPABILITY_UNAVAILABLE` ·
`HUMAN_INTERVENTION_REQUIRED`

### 3.4 Uncertainty classification (`missionUncertaintyClasses`)

`NONE` · `PROVIDER_PENDING` · `TIMEOUT` · `CALLBACK_AMBIGUOUS` ·
`PARTIAL_CONFIRMATION` · `PROVIDER_STATE_UNKNOWN` · `STALE_STATE` ·
`AUTHORIZATION_EXPIRED` · `SCHEDULE_DRIFT`

### 3.5 Recovery types (`missionRecoveryTypes`)

`RETRY` · `REVALIDATE` · `WAIT_EXTERNAL` · `REQUEST_HUMAN_REVIEW` ·
`RESCHEDULE` · `REPLAN` · `CANCEL_TASK` · `CANCEL_MISSION` · `ESCALATE`

### 3.6 Recovery lifecycle status (`missionRecoveryStatuses`)

`PROPOSED` · `REVIEW_REQUIRED` · `AUTHORIZED` · `IN_PROGRESS` · `RESOLVED`
· `FAILED` · `SUPERSEDED` · `STALE` · `CANCELLED` · `INVALIDATED`

### 3.7 Timeline event types (`missionTimelineEventTypes`)

`mission_state_derived` · `task_state_derived` ·
`recovery_candidate_proposed` · `recovery_governance_bound` ·
`recovery_lifecycle_changed` · `uncertainty_observed` ·
`operator_intervention` · `resolution_recorded`

### 3.8 Blocking reasons (`missionBlockingReasons`) — closed, ≤8 per record

`MISSION_NOT_CURRENT` · `MISSION_SUPERSEDED` · `MISSION_STALE` ·
`MISSION_CANCELLED` · `MISSION_INVALIDATED` · `MISSION_BLOCKED` ·
`PLAN_SUPERSEDED` · `PLAN_STALE` · `PLAN_NOT_CURRENT` · `PLAN_BLOCKED` ·
`PLAN_INVALIDATED` · `SCHEDULE_SUPERSEDED` · `SCHEDULE_STALE` ·
`SCHEDULE_NOT_READY` · `SCHEDULE_BLOCKED` · `SCHEDULE_INVALIDATED` ·
`SCHEDULE_CANCELLED` · `TASK_SUPERSEDED` · `TASK_UNRESOLVED` ·
`TASK_BLOCKED` · `TASK_NOT_SCHEDULED` · `DEPENDENCY_NOT_SATISFIED` ·
`GOVERNANCE_REVIEW_PENDING` · `GOVERNANCE_BLOCK` · `GOVERNANCE_UNAVAILABLE`

## 4. Deterministic identity (E-identity)

Every identity rebuilds its hashed fragment field-by-field. Same
authoritative inputs ⇒ same identity; any material change ⇒ new identity.
No client- or model-generated identity exists anywhere.

```
stateDerivationHash   = sha256(canonicalJson({ v: 1, missionFingerprint,
                        planFingerprint, scheduleFingerprint,
                        missionStatus, planStatus, scheduleStatus,
                        taskStateCores, nowBucket }))

missionStateId        = "mst1:" + sha256(canonicalJson({ v: 1, tenantUserId,
                        businessId, missionId, planId, scheduleId,
                        stateDerivationHash }))

taskStateId           = "tst1:" + sha256(canonicalJson({ v: 1, tenantUserId,
                        businessId, missionId, planId, scheduleId, taskId,
                        latestAttemptId, taskStateHash }))

taskStateHash         = sha256(canonicalJson({ v: 1, status, failureClass,
                        uncertaintyClass, retryEligibility,
                        recoveryRequired, blockingReasons, uncertainties }))

recoveryProposalHash  = sha256(canonicalJson({ v: 1, tenantUserId, businessId,
                        missionId, planId, scheduleId, taskId,
                        executionActionId, latestAttemptId, failureClass,
                        uncertaintyClass, recoveryType, scope }))

recoveryCandidateId   = "rcn1:" + sha256(canonicalJson({ v: 1, tenantUserId,
                        businessId, missionId, taskId, latestAttemptId,
                        recoveryType, recoveryProposalHash }))

recoveryLifecycleId   = "rcl1:" + sha256(canonicalJson({ v: 1,
                        recoveryCandidateId, lifecycleType, fromStatus,
                        toStatus, occurredAt }))

timelineEventId       = "mot1:" + sha256(canonicalJson({ v: 1, eventType,
                        missionId, scheduleId|null, taskId|null,
                        recoveryCandidateId|null, fromStatus, toStatus,
                        occurredAt, subjectHash }))
```

Durable convergence anchors (structural exact-once, unique indexes):
`(userId, missionStateId)`, `(userId, taskStateId)`,
`(userId, recoveryCandidateId)`, `(userId, recoveryLifecycleId)`,
`(userId, timelineEventId)`. Identical replay converges
(`idempotent_replay`, zero extra events/facts); conflicting material under
the same anchor fails closed (`MISSION_STATE_REPLAY_CONFLICT`).

**Identity note:** the recovery candidate binds the exact failed attempt
(`executionActionId` + `latestAttemptId`) — a retry candidate preserves
the original attempt scope verbatim (§8).

## 5. Mission operational-state record

| Field | Type | Notes |
|---|---|---|
| `missionStateId` | `mst1:<sha256>` | §4 |
| `tenantId` / `businessId` | number | session anchor; server-verified ownership every call |
| `missionId` / `planId` / `scheduleId` | `mis1:` / R9-B coord / `sch1:` | authoritative refs |
| `missionStatus` | closed string | verbatim R9-A mission status |
| `healthClass` | §3.2 | deterministic (§7) |
| `taskSummary` | object | `{ total, byStatus: {<status>: n}, requiredTotal, requiredSucceeded }` |
| `latestExecutionRefs` | string[] ≤ 100 | latest `exa1:`/`exr1:` refs per task, newest first |
| `blockingReasons` | §3.8[] ≤ 8 | closed labels |
| `uncertainties` | §3.4[] ≤ 8 | closed labels |
| `recoveryCandidateIds` | `rcn1:`[] ≤ 100 | current (non-terminal) candidates |
| `observedAt` | ISO-8601 UTC | server clock of this observation |
| `derivedFromVersion` | `<sha256>` | `stateDerivationHash` of inputs |
| `validUntil` | ISO-8601 UTC | observation validity horizon |

## 6. Task operational-state record and derivation

### 6.1 Record

| Field | Type | Notes |
|---|---|---|
| `taskStateId` | `tst1:<sha256>` | §4 |
| `taskId` / `scheduleId` | coord / `sch1:` | verbatim upstream refs |
| `latestAttemptId` | `exr1:` \| null | latest authoritative attempt |
| `status` | §3.1 | derived, never supplied |
| `failureClass` | §3.3 | conservative classification |
| `uncertaintyClass` | §3.4 | conservative classification |
| `retryEligibility` | boolean | proposal eligibility only — never authorization |
| `recoveryRequired` | boolean | a recovery candidate is warranted |
| `lastUpdatedAt` | ISO-8601 UTC | derivation time |

### 6.2 Derivation rules (rule-ordered; first match wins)

Inputs: R9-B task row, R9-C schedule row (blocking states), R9-D execution
action(s) for the exact task + latest attempt, R9-F governance visibility,
server clock. No inferred success anywhere.

1. **Authority drift.** Mission not current (`STALE`/`SUPERSEDED`/
   `CANCELLED`/`INVALIDATED`/`BLOCKED`) or schedule not current → `BLOCKED`
   with the matching blocking reason; failure class
   `SCHEDULE_STALE`/`DEPENDENCY_INVALID` as applicable; uncertainty
   `SCHEDULE_DRIFT` when the drift is stale-but-recoverable.
2. **Task not executable by planning.** Task `UNRESOLVED`/`BLOCKED`/
   `GOVERNANCE_REVIEW_REQUIRED` or absent from the current schedule →
   `BLOCKED` (`TASK_UNRESOLVED` / `TASK_BLOCKED` / `GOVERNANCE_REVIEW_PENDING`
   / `TASK_NOT_SCHEDULED`).
3. **No execution action.** Never-attempted task → `PENDING` (or `READY`
   when a dispatch-prepared action exists). Optional-looking absence is
   never assumed — absence of evidence stays `PENDING`.
4. **Dispatch prepared, not yet dispatched** → `READY`.
5. **Dispatched / acknowledged without result.** `ACKNOWLEDGED` with
   `PENDING_EXTERNAL` → `PENDING_EXTERNAL` (uncertainty `PROVIDER_PENDING`,
   visible; never success). `DISPATCHED`/`ACKNOWLEDGED` with no result
   beyond the stale horizon → `STALE` (uncertainty `STALE_STATE`).
6. **Explicit success.** Latest attempt `resultStatus = SUCCEEDED` →
   `SUCCEEDED`. Only an authoritative R9-D success record derives success.
7. **Explicit final failure.** `FAILED_FINAL` → `FAILED_FINAL`,
   failure class `FINAL` (or `CALLBACK_MISMATCH` for ambiguous-callback
   final failures). Never retry-eligible. `recoveryRequired = true`,
   recovery type `REQUEST_HUMAN_REVIEW`.
8. **Retryable failure.** `FAILED_RETRYABLE` → `FAILED_RETRYABLE`,
   failure class `TRANSIENT`, `retryEligibility = true`.
9. **Uncertainty.** `UNCERTAIN` (timeout / connection loss / partial /
   provider-state-unknown) → `UNCERTAIN`, failure class `AMBIGUOUS_RESULT`,
   uncertainty per the R9-D uncertainty class. Never success, never
   retry-eligible without human-visible revalidation.
10. **Cancelled.** Action `CANCELLED` → `CANCELLED`. (A task `SUPERSEDED`
    by planning revision is caught earlier by rule 2 — it is no longer part
    of the current plan's executable set.)

`retryEligibility` is proposal material only: **a retry candidate grants
no authority**; fresh R9-F consumption is required (§9).

### 6.3 Required task set

Required = task ∈ current schedule `orderedTaskIds` ∩ current plan task
set. Execution actions bound to tasks outside the current schedule are
plan-revision drift: excluded from completion/blocking math, surfaced as a
visible drift note (at most `DEGRADED` impact). The upstream contracts
define no optionality marker; E never invents one.

## 7. Mission health derivation (E3)

Pure deterministic function over the derived task states + authority
freshness. Priority order:

1. Authority terminal-negative: mission `CANCELLED`/`INVALIDATED` →
   `FAILED`; mission `BLOCKED` → `BLOCKED`; mission `SUPERSEDED`/`STALE` →
   `UNCERTAIN` (drift; re-evaluation required, never silent continuation).
2. Any required task `UNCERTAIN`/`PENDING_EXTERNAL` → `UNCERTAIN`
   (unknown external result prevents false completion).
3. Any required task `BLOCKED` → `BLOCKED`.
4. Any required task `FAILED_FINAL` → `AT_RISK`; all required tasks
   terminal-failed (none succeeded) → `FAILED`.
5. Any required task `FAILED_RETRYABLE`/`STALE` → `DEGRADED`.
6. All required tasks `SUCCEEDED`, no open uncertainty, no blocking
   reason, authorities current → `COMPLETED`.
7. Otherwise → `HEALTHY` (pending/ready/dispatched work in flight, no
   adverse signal).

COMPLETED is never derived from optional-work success, absence of failure
news, or model narrative. Unknown external result ⇒ at best `UNCERTAIN`.

## 8. Recovery candidate identity and scope preservation (E4/E6)

Candidate identity per §4 binds tenant + business + mission + task/action
+ failure/uncertainty state + **latest authoritative attempt** + recovery
type. The candidate `scope` is the verbatim original mission/task/action
scope: `{ missionId, planId, scheduleId, taskId, executionActionId,
latestAttemptId, actionType, adapterType, capability,
actionParametersHash, authorizationContextHash }` — loaded server-side
from the durable R9-D row, never client-supplied.

Hard invariants:

- Recovery **preserves** the original mission objective and constraints;
  no proposal may alter them (a different objective is a different
  mission — outside E entirely).
- Recovery **cannot broaden** task/action scope: a candidate whose scope
  drifts from the failed attempt's bound scope is `INVALIDATED`
  (`RECOVERY_SCOPE_DRIFT`).
- A retry candidate binds the **exact** failed attempt; replay under the
  same anchor with different attempt material fails closed.
- Candidates are **advisory**: creation mints zero authority.

Recovery type selection (deterministic, conservative):

| Condition | Type |
|---|---|
| `FAILED_RETRYABLE` / `TRANSIENT` | `RETRY` |
| `UNCERTAIN` + timeout/partial/provider-unknown | `REVALIDATE` |
| `PENDING_EXTERNAL` beyond policy horizon | `REVALIDATE` (visible; never auto-success) |
| `PENDING_EXTERNAL` within horizon | `WAIT_EXTERNAL` |
| `FAILED_FINAL` | `REQUEST_HUMAN_REVIEW` |
| Schedule `SUPERSEDED`/`STALE`/`INVALIDATED` | `RESCHEDULE` |
| Plan `SUPERSEDED`/`STALE`/`INVALIDATED` | `REPLAN` |
| Mission `STALE`/`SUPERSEDED` | `ESCALATE` |
| Mission `CANCELLED`/`INVALIDATED`/`BLOCKED` | `CANCEL_MISSION` |
| Task `SUPERSEDED`/out-of-schedule with open work | `CANCEL_TASK` |
| Capability unsupported | `ESCALATE` |

## 9. Retry / recovery governance boundary (E6) — R9-F remains authority

E proposes; F authorizes; D executes. Before a recovery becomes
consumable, the **frozen R9-F gate** (`assertMissionActionConsumable`
semantics, `mission-governance-to-execution/v1`) re-validates, for the
exact candidate, server-side:

- the exact R9-F decision row exists for this tenant/business;
- exact subject (`RETRY` → `RETRY`; `REVALIDATE`/`WAIT_EXTERNAL`/
  `RESCHEDULE`/`REPLAN`/`CANCEL_TASK`/`CANCEL_MISSION` → `RECOVERY_ACTION`;
  `REQUEST_HUMAN_REVIEW`/`ESCALATE` → `ESCALATION`) and action
  (`RETRY_STEP`/`RECOVER_STATE`/`ESCALATE_TO_HUMAN`);
- exact refs (mission/plan/task) and `actionParamsFingerprint` over the
  candidate's canonical recovery parameters
  (`sha256(canonicalJson({v:1, params:{ recoveryCandidateId, recoveryType,
  executionActionId, latestAttemptId, taskId, scope }})`);
- current policy version; `ALLOW` within validity; `REVIEW_REQUIRED` with
  an approved ledger row whose `approvalBindingHash` re-validates against
  the exact stored decision and is unexpired;
- `BLOCK` is never consumable; human rejection permanently blocks.

`RECOVERY_REQUIRES_FRESH_REVIEW`: under the default policy every
RECOVERY_ACTION/ESCALATION proposal floors at `REVIEW_REQUIRED` — no
autonomous recovery. No recovery path bypasses R9-F. Changed recovery
parameters after approval ⇒ binding mismatch ⇒ the candidate is
`INVALIDATED` and re-proposal mints a new candidate (new identity).

## 10. Recovery state machine (E7)

```
PROPOSED ──governance ALLOW──► AUTHORIZED ──consume──► IN_PROGRESS ──► RESOLVED
   │         governance REVIEW_REQUIRED                    │
   ▼                 │                                     ▼
REVIEW_REQUIRED ◄─────┘        governance BLOCK      FAILED (visible)
   │  │approval│                    (never consumable)   │
   └──►AUTHORIZED                                        ▼
                                              re-proposal ⇒ SUPERSEDED
SUPERSEDED ◄── newer candidate for same (task, attempt) scope
STALE ◄─────── bound mission/plan/schedule authority drifted
CANCELLED ◄─── governed operator cancellation (audited)
INVALIDATED ◄─ hash drift / scope drift / tamper (audited)
```

`AUTHORIZED` performs nothing. Execution remains R9-D's responsibility:
when a consumed recovery requires execution, E emits a read-only
governed **execution-recovery handoff** (candidate identity + exact scope
+ consumed authorization refs) for R9-D to mint a fresh governed action.
E never dispatches, never invokes an adapter, never marks a retry done.

## 11. Observability / timeline (E8)

Append-only `mot1:` events (§3.7) capture: mission state changes, task
state changes, recovery candidate creation, governance binding, operator
intervention, uncertainty, resolution. Properties:

- **Read-side:** no endpoint, agent or model can mutate mission authority
  through the timeline; it is not an input to derivation.
- **No secrets:** events carry closed labels + identity refs + bounded
  hashes; secret-shaped keys are rejected at every boundary.
- **No chain-of-thought:** no model reasoning is persisted.
- **Append-only:** no update/delete path exists; the event hash binds the
  immutable core.

## 12. Stale / drift detection (E9)

Re-evaluation (`reevaluate`) reloads every upstream authority and
compares: mission superseded/stale/cancelled/invalidated; plan superseded/
stale; schedule superseded/stale; approval expiry; execution action
pending beyond the policy horizon; upstream fingerprint drift; recovery
proposal no longer valid. Stale state triggers re-derivation (a new state
version) and candidate lifecycle effects (`STALE`/`SUPERSEDED`/
`INVALIDATED`); E never silently continues from stale authority, and never
marks stale work successful.

## 13. Operator / read-only surface (E10)

`missionStateRecovery.*` (tRPC, `authedQuery` only): `observe`,
`getMissionState`, `listMissionTaskStates`, `listExecutionAttempts`,
`listRecoveryCandidates`, `getRecoveryCandidate`,
`getOperationalTimeline`, `getMissionHealth`, `proposeRecovery` (derive
candidate for a task), `bindRecoveryGovernance`, `consumeRecovery`,
`reevaluate`, `cancelRecovery`, `getMissionControlHandoff`.

All inputs are `z.strictObject`: clients name ids and bounded material
only. Every client-supplied authority field (`status`, `healthClass`,
`missionStateId`, `recoveryCandidateId`, `decision`, `approved`,
`riskClass`, `failureClass`, `uncertaintyClass`, `retryEligibility`,
`governanceDecisionId` where not a reference to F's own row, fingerprints,
`override`, `force*`, `success`, `completed`, `execute`, …) is rejected at
the boundary (`MISSION_STATE_CLIENT_AUTHORITY_FIELD_FORBIDDEN`) and fails
closed. The read surface mutates nothing; governed writes exist only as
the explicit commands above, each audited exactly once per durable effect.

## 14. Error taxonomy (closed)

Input/ownership: `MISSION_STATE_INPUT_MALFORMED`,
`MISSION_STATE_CLIENT_AUTHORITY_FIELD_FORBIDDEN`,
`SECRET_MATERIAL_REJECTED`, `CROSS_TENANT_MISSION`,
`CROSS_BUSINESS_MISSION`.
Authority: `MISSION_STATE_AUTHORITY_UNAVAILABLE`, `UNKNOWN_MISSION`,
`MISSION_NOT_CURRENT`, `UNKNOWN_TASK`, `TASK_NOT_IN_MISSION`,
`UNKNOWN_RECOVERY_CANDIDATE`, `RECOVERY_CANDIDATE_NOT_CURRENT`,
`GOVERNANCE_DECISION_NOT_FOUND`, `GOVERNANCE_NOT_CONSUMABLE`.
Identity/state: `MISSION_STATE_REPLAY_CONFLICT`,
`MISSION_STATE_TAMPER`, `INVALID_RECOVERY_STATUS`,
`RECOVERY_SCOPE_DRIFT`, `MISSION_STATE_CONFLICT`.

## 15. Schema / migration

Stream-local tables `mission_state_records`, `mission_task_states`,
`mission_recovery_candidates`, `mission_operational_timeline_events`
(`@db/schema` on this branch; provisional migration
`0037_r9_e_mission_state_recovery_foundation` — **artefact only, NOT
executed**; canonical R8 0036 never modified; R9-X owns canonical 0037
convergence). Audit: additive `mission_state_derived`,
`mission_recovery_candidate_proposed`, `mission_recovery_lifecycle`
(one per durable effect; convergence emits zero).

## 16. Security posture (rogue recovery/observability agent)

A compromised agent of this stream cannot: fabricate success (no success
path without an authoritative R9-D success record), hide failure or
uncertainty (classifications derive from immutable R9-D rows; timeline is
append-only), rewrite execution history (no write path to any R9-D
table), create fake attempts, self-authorize retry/recovery (no
authorization path; R9-F gate only), forge approvals (binding-hash
revalidation), widen recovery scope (scope verbatim from durable R9-D
rows; drift ⇒ INVALIDATED), change the mission objective (read-only
seams), mutate plan/schedule (no write paths), lower risk (no risk input
exists), invoke providers (no adapter/registry code in this stream),
access secrets (secret-shaped material rejected at boundaries; nothing
secret is ever read or persisted), execute shell/SQL from input (all
input is inert labels/refs), modify permissions, or suppress the audit
trail (audit writes are fail-closed).
