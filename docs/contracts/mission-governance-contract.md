# Mission Governance & Approval Contract (WBS-R9-F)

> Canonical contract for the R9-F mission-governance authority.
> Branch `feature/r9-f-mission-governance`; programme base `4fc43c3b`; frozen
> upstream R8 Strategic Intelligence (`STRATEGIC_INTELLIGENCE_V1_READY`,
> HEAD `4fc43c3b252baa81906cd409ca2ec290baa77825`).
> Implementation: `api/lib/mission-governance/`; router `missionGovernance`
> (`api/mission-governance-router.ts`); schema `mission_governance_decisions`
> (provisional migration `0037_r9_f_mission_governance_foundation`, NOT
> executed; R9-X owns canonical 0037 convergence).

## 1. Purpose and authority boundary

R9-F decides **whether a governed mission subject may proceed** — never
*which* mission is optimal and never *any* execution itself. It governs:
mission-governance policy, mission/action risk classification, approval
requirements, approval binding, human-review requirements, governance
receipts, the execution consumption gate, and retry/recovery governance.

R9-F does **not** own: mission objectives, task planning, dependency
planning, scheduling, the execution engine, provider adapters, state
recovery, strategic intelligence (R8), Business DNA, or budget authority
(R4/R7).

**Core principles enforced (charter):**

1. Planning authority ≠ execution authority. Mission approval ≠ task
   approval. Task approval ≠ provider authorization.
2. Approval for one phase never authorizes another phase unless an explicit
   contract says so — default: **no phase escalation**.
3. Retry authority ≠ new-action authority; recovery authority ≠ policy
   override.
4. No agent may approve itself: human review requires independent
   out-of-band human presence (email OTP), never the tenant session alone.
5. No `EXECUTE` decision exists anywhere in this stream. `ALLOW` is
   bounded, expiring authority for the **exact bound subject/action** only.
6. Risk is server-derived. Declarations and uncertain/untrusted input can
   only **raise** risk; nothing client-, model- or agent-side can lower it.
7. A failed or expired decision never broadens authority through retry or
   recovery: new side effects require a new governed decision.

## 2. Target flow

```
mission action proposal (material only)
+ business policy (versioned, server-side, immutable per version)
+ declared risk signals (material; raise-only)
+ semantic risk floors (action/subject-derived; cannot be lowered)
+ phase autonomy ceilings (policy)
+ tenant-anchored business ownership (server-resolved)
↓ governance evaluation (pure, deterministic)
↓ ALLOW | REVIEW_REQUIRED | BLOCK            ← no EXECUTE
↓ human approval where required (OTP-bound, Approval Centre)
↓ immutable governance receipt (mgd1:)
↓ execution consumption gate (assertMissionActionConsumable)
↓ read-only authorization verdict to downstream R9-D/E
```

## 3. Governance decisions (closed)

| Decision | Meaning |
|---|---|
| `ALLOW` | The exact bound subject/action may proceed until `validUntil`, under the bound policy version. Bounded authority only — never transferable across subjects, phases, missions or parameters. |
| `REVIEW_REQUIRED` | A bound human approval is required before the exact subject/action may be consumed. |
| `BLOCK` | The subject/action must not proceed. Durable, auditable, immutable. |

Anything outside this vocabulary is a programming error, not a decision.
Autonomy ranking: `BLOCK` (0) < `REVIEW_REQUIRED` (1) < `ALLOW` (2);
every evaluation dimension may only narrow the disposition.

## 4. Governed subject classes and phases (F1, F2)

Closed subject taxonomy — adapted to the actual architecture (mission/task
stores are sibling-stream concerns; R9-F binds them as opaque references):

| Subject class | Phase | Governs |
|---|---|---|
| `MISSION_PROPOSAL` | FORMULATION | Formulating a mission from (governed) strategic input |
| `MISSION_PLAN` | PLANNING | The plan: objectives binding, task breakdown |
| `MISSION_SCHEDULE` | SCHEDULING | Committing a schedule/sequencing |
| `TASK` | EXECUTION | Executing one planned task |
| `EXECUTION_STEP` | EXECUTION | Executing one step of a task |
| `RETRY` | LIFECYCLE | Retrying a failed step/attempt |
| `RECOVERY_ACTION` | LIFECYCLE | Recovery from failure/state drift |
| `CANCELLATION` | LIFECYCLE | Cancelling a mission/task |
| `ESCALATION` | LIFECYCLE | Escalating to a human/operator |

**Phase separation.** Policy names the `autonomousPhases` set (default:
`FORMULATION`, `PLANNING`, `SCHEDULING`). A subject whose phase is outside
that set can never receive `ALLOW` — its disposition floors at
`REVIEW_REQUIRED` (`EXECUTION_REQUIRES_REVIEW` / `LIFECYCLE_REQUIRES_REVIEW`).
An approval bound to a `MISSION_PROPOSAL` decision authorizes exactly that
proposal consumption; it does not authorize `MISSION_PLAN`, `TASK`,
`EXECUTION_STEP` or any other subject — each phase needs its own governed
decision (default: no phase escalation).

Unknown subject class → `BLOCK` (`UNKNOWN_SUBJECT_CLASS`).

## 5. Closed action taxonomy (F1)

```
FORMULATE_MISSION      BIND_OBJECTIVES       PLAN_TASKS
SEQUENCE_DEPENDENCIES  COMMIT_SCHEDULE       EXECUTE_TASK
EXECUTE_STEP           RETRY_STEP            INVOKE_PROVIDER
MUTATE_DATA            ACTIVATE_CAMPAIGN     CONSUME_BUDGET
CANCEL_MISSION         ESCALATE_TO_HUMAN     RECOVER_STATE
```

Policy additionally lists `prohibitedActionTypes` (default:
`MODIFY_POLICY`, `SELF_APPROVE`, `INVOKE_BILLING`, `ACCESS_SECRETS`,
`ALTER_PERMISSIONS`): an attempt to govern any of them is durably `BLOCK`ed
(`PROHIBITED_ACTION_TYPE`). Unknown action type → `BLOCK`
(`UNKNOWN_ACTION_TYPE`). Clients never supply prohibited lists, risk, or
decisions.

## 6. Risk classification (F3)

Risk class is server-derived over the closed scale
`LOW < MEDIUM < HIGH < CRITICAL`.

**Declared signals (proposal material — each can only raise):**

| Signal | Values |
|---|---|
| `financialImpact` | `NONE` \| `MINOR` \| `MODERATE` \| `SEVERE` |
| `externalSideEffects` | boolean |
| `customerImpact` | boolean |
| `irreversibleEffects` | boolean |
| `providerCalls` | boolean |
| `dataMutation` | boolean |
| `campaignActivation` | boolean |
| `budgetConsumption` | boolean |
| `regulatoryImplication` | boolean |
| `scopeBreadth` | `SINGLE` \| `MULTI_BUSINESS` \| `PORTFOLIO` |

**Semantic floors (action-derived; declarations cannot lower them):**
`INVOKE_PROVIDER` ⇒ providerCalls; `MUTATE_DATA` ⇒ dataMutation;
`ACTIVATE_CAMPAIGN` ⇒ campaignActivation; `CONSUME_BUDGET` ⇒
budgetConsumption; `RECOVER_STATE` ⇒ dataMutation.

**Subject base:** FORMULATION/SCHEDULING/CANCELLATION subjects base `LOW`;
TASK/EXECUTION_STEP/ESCALATION base `MEDIUM`; RETRY/RECOVERY_ACTION base
`MEDIUM`.

**Raise rules (deterministic, ordered):** `financialImpact=MODERATE` ⇒ ≥
MEDIUM; `SEVERE` ⇒ ≥ HIGH; any of externalSideEffects / customerImpact /
regulatoryImplication ⇒ ≥ MEDIUM; budgetConsumption ⇒ ≥ MEDIUM;
irreversibleEffects ⇒ ≥ MEDIUM; irreversibleEffects ∧ (providerCalls ∨
campaignActivation) ⇒ ≥ HIGH; providerCalls ∧ campaignActivation ⇒ ≥ HIGH;
scopeBreadth MULTI_BUSINESS ⇒ ≥ MEDIUM; PORTFOLIO ⇒ ≥ HIGH;
injection-suspect content in proposal material ⇒ raise one level
(+ `PROMPT_INJECTION_SUSPECTED`). No rule lowers risk. Agents/models cannot
declare or influence the class; omission of a true signal is covered by the
semantic floors.

Disposition starts at `policy.riskDispositions[riskClass]` (default
LOW→ALLOW, MEDIUM→REVIEW_REQUIRED, HIGH→REVIEW_REQUIRED, CRITICAL→BLOCK),
then phase floors and retry/recovery rules narrow it.

## 7. Retry / recovery governance (F7)

- `RETRY` proposals carry `retryContext`:
  `{ retryOf, declaredIdempotent, priorActionParams }`.
- `declaredIdempotent=false` ⇒ risk raised one level, disposition floored at
  `REVIEW_REQUIRED` (`RETRY_NEW_SIDE_EFFECT_REVIEW`): a non-idempotent retry
  is a new side effect, not a replay.
- `fingerprint(priorActionParams) ≠ actionParamsFingerprint` ⇒ risk raised
  one level, floored at `REVIEW_REQUIRED` (`RETRY_SCOPE_BROADENED`): a retry
  whose parameters differ from the failed attempt has silently broadened
  authority — never `ALLOW`.
- `RECOVERY_ACTION` is floored at `REVIEW_REQUIRED`
  (`RECOVERY_REQUIRES_FRESH_REVIEW`): recovery may require fresh human
  review and can never be autonomous under the default policy.
- Consumption binding for retries/recoveries binds the exact parameters;
  reusing an approval on different parameters fails closed
  (`APPROVAL_BINDING_MISMATCH`).

## 8. Approval binding (F4)

Human approvals reuse the governed ledger (`approval_requests`,
`approvalType = "mission_action"` — provisional enum extension, unexecuted).
The approval command is built only from a `REVIEW_REQUIRED` decision and
binds exactly:

tenant (approval row userId) · business · missionRef · planRef · taskRef ·
subjectClass · actionType · actionParamsFingerprint · riskClass ·
policyVersion · expiry · approvalBindingHash.

`approvalBindingHash = sha256({v:1, governanceDecisionId, policyVersion,
actionParamsFingerprint, riskClass})`.

Rejected: forged approval (hash mismatch), stale approval (expired binding,
changed policy version), cross-mission / cross-plan / cross-task approval,
cross-tenant approval (approval row userId ≠ decision userId),
cross-business approval, modified action after approval (params fingerprint
mismatch), self-approval (approval row minted by the proposing agent
identity is never authority; the OTP challenge is the independent human
presence proof), replay outside scope. Human rejection permanently blocks
the decision identity.

## 9. Governance receipts (F5)

Every evaluation persists one immutable, insert-only receipt row
(`mission_governance_decisions`):

| Field | Notes |
|---|---|
| `governanceDecisionId` | `mgd1:<sha256>` deterministic over `{v, userId, businessId, missionRef, planRef, taskRef, subjectClass, actionType, policyVersion, actionParamsFingerprint, summary, declaredRisk, retryContext}` |
| `contractVersion` / `engineVersion` | `mission-governance/v1` / `mission-governance-engine/v1` |
| `userId` / `businessId` | Tenant-anchored; ownership re-verified from the durable businesses row every call |
| `missionRef` / `planRef` / `taskRef` | Opaque pattern-checked references; raw action params are **never** stored — only their fingerprint |
| `subjectClass` / `actionType` | Closed taxonomy values |
| `actionParamsFingerprint` | `sha256(canonicalJson(actionParams))` — binds the exact action |
| `missionRiskClass` / `riskFactors` | Server-derived class + snapshot of the signals that produced it |
| `policyVersion` / `decision` / `reasonCodes` (≤8) | The deciding policy artefact and outcome |
| `approvalRequired` / `approvalBinding` | Exact binding (§8) for REVIEW_REQUIRED decisions |
| `evaluationFingerprint` | `sha256` over the decision outcome — replay/evidence verification |
| `validUntil` / `evaluatedAt` | ISO 8601 verbatim |
| `thresholds` | Bounded snapshot of the policy knobs used |

Receipts are immutable (no update/delete path exists; corrections are new
decisions) and auditable: exactly one `mission_governance_decision` audit
event per inserted receipt; replays/convergence emit zero. Narrow recovery
is audit-only operator vocabulary (`operator_acknowledged`,
`operator_requeued`, `operator_dismissed` → `mission_governance_recovery`
event); there is no forceAllow/forceApprove/override anywhere.

## 10. Execution consumption gate (F6)

`assertMissionActionConsumable` (pure, `api/lib/mission-governance/mission-approval.ts`)
is the **single** authority converter downstream execution must call
immediately before any material effect, re-validated with server-side
authoritative inputs:

- `ALLOW`: consumable only while `validUntil` is unexpired and the current
  policy version is unchanged.
- `REVIEW_REQUIRED`: consumable only with an approved ledger row whose
  binding re-validates against the exact stored decision (decision id,
  policy version, binding hash, params fingerprint, refs, tenant) and is
  unexpired under an unchanged policy.
- `BLOCK`: never consumable; human rejection is permanent.
- The caller supplies the **exact action it intends to consume**
  (subjectClass/actionType/refs/params from its own server-side execution
  context); any deviation from the bound decision ⇒ `APPROVAL_BINDING_MISMATCH`.
- A consumable verdict carries `authorityScope: "MISSION_ACTION"` and the
  exact bound coordinates + expiry. It authorizes nothing else: no other
  subject, phase, mission, task, parameter set, provider call or spend.

No client-provided `ALLOW`, no agent-provided `ALLOW`, no model-generated
authorization: the verdict is computed only from durable rows + the bound
policy.

## 11. Router surface and input discipline

tRPC namespace `missionGovernance` (tenant-scoped, `authedQuery` only):
`evaluate`, `get`, `listDecisions`, `getOperationsProjection`,
`revalidate`, `requestApprovalChallenge`, `resolveApprovalChallenge`,
`recordRecovery`, `getPolicy`.

All inputs are `z.strictObject`: clients reference ids and propose material
only. Every client-supplied authority field (`decision`, `riskClass`,
`approved`, `authorization`, `executable`, `policyVersion`,
`governanceDecisionId`, fingerprints, `override`, `forceAllow`,
`forceApprove`, `lowerRisk`, `selfApprove`, …) is rejected at the boundary
(`CLIENT_AUTHORITY_FIELD_REJECTED`) and fails closed. Raw action params are
bounded (canonical JSON ≤ 16 KiB, JSON value only).

## 12. Schema / migration

- `mission_governance_decisions` — canonical `@db/schema` table (single
  source of truth); provisional migration
  `0037_r9_f_mission_governance_foundation` (**artefact only, NOT
  executed** — `MIGRATION_EXECUTION = FALSE`; R8's canonical 0036 is never
  modified; R9-X owns canonical 0037 convergence).
- `approval_requests.approvalType += "mission_action"` — additive enum
  extension inside the same provisional artefact.
- Audit: additive code-level `mission_governance_decision`,
  `mission_governance_recovery` event types.

## 13. Downstream contract

`docs/contracts/mission-governance-to-execution-contract.md` — the frozen
gate semantics for R9-D/E. Execution may proceed only when the exact
subject/action is consumable; no consumer may mutate F authority.

## 14. Security posture (F8)

Assume a compromised mission/execution agent. It cannot: self-approve
(OTP out-of-band proof), lower risk (server-derived class; raise-only
inputs), change policy (code-level registry, no mutation endpoint), forge
receipts (hash-bound deterministic identity), reuse an approval on a
different action (params fingerprint binding), broaden mission scope
(refs + scopeBreadth raise rules), invoke providers without exact gate
pass (F6), increase spend (financialImpact/CONSUME_BUDGET raise risk;
no autonomous budget action), create hidden tasks (every governed subject
needs its own evaluated receipt), manipulate retry into a new action
(prior-params fingerprint comparison), bypass tenant/business isolation
(ownership re-verified from durable rows every call), access secrets
(prohibited action + injection raise rules), or modify permissions
(prohibited action).
