# MISSION GOVERNANCE → EXECUTION CONTRACT (R9-F → R9-D/E)

> **Producer:** R9-F Mission Governance & Approval
> (`feature/r9-f-mission-governance`)
> **Consumers:** R9 Mission Control streams — mission formulation/planning
> (R9-A/B/C), dependency/scheduling, execution engine (R9-D), provider
> adapters (R9-E) (future streams, read-only)
> **Status:** canonical downstream contract — R9-D/E read, never redefine or
> mutate
> **Gate version:** `mission-governance-to-execution/v1`
> **Source of truth:** `docs/contracts/mission-governance-contract.md`
> (R9-F canonical) +
> `api/lib/mission-governance/mission-approval.ts`
> (`assertMissionActionConsumable` — the frozen gate)

---

## 1. Purpose and boundaries

R9-F owns mission-governance decisions: whether a governed mission subject
(mission proposal, plan, schedule, task, execution step, retry, recovery
action, cancellation, escalation) may proceed, under phase-separated
authorization, deterministic risk classification, exact approval binding and
immutable receipts. This contract is the **only** surface through which
downstream execution consumes that authority.

Downstream may read and must never mutate: no downstream call may write
`mission_governance_decisions`, approval rows bound to mission governance,
policy registry content, or any upstream authority table; no consumer may
mint decision identities, risk classes, reason codes, approvals, receipts or
recoveries.

**Decision ≠ execution. Consumption ≠ performance.** A consumable verdict
authorizes the consumer to perform **exactly the bound action once**, within
its validity window, under the bound policy version — nothing more. The gate
never invokes providers, moves budget, launches campaigns, mutates state or
executes anything itself.

**Phase discipline (default: no phase escalation).** A consumable
`MISSION_PROPOSAL` decision authorizes exactly that proposal; it does not
authorize `MISSION_PLAN`, `MISSION_SCHEDULE`, `TASK`, `EXECUTION_STEP`,
`RETRY`, `RECOVERY_ACTION`, `CANCELLATION` or `ESCALATION`. Each subject
requires its own governed decision. An approval bound to one subject is never
valid for another (cross-subject replay fails closed).

**R8 strategic approval is not mission execution authority.** An
`ALLOW_RECOMMENDATION` / bound approval from R8-F
(`strategic-intelligence-to-mission-control/v1`) authorizes *candidate
consumption as a governed recommendation* only. It never pre-arms, pre-approves
or bypasses this gate.

## 2. The gate

```ts
assertMissionActionConsumable(input: {
  decision: MissionGovernanceDecision;   // durable receipt row (server-read)
  approval: MissionApprovalView | null;  // ledger row (server-read), null if none
  expectedAction: {                      // the EXACT action the consumer
    subjectClass: string;                //   intends to execute, from its own
    actionType: string;                  //   server-side execution context —
    missionRef: string;                  //   never client authorization material
    planRef: string | null;
    taskRef: string | null;
    actionParams: unknown;
  };
  currentPolicyVersion: string | null;   // the currently registered policy
  now: string;                           // server clock, ISO 8601
}): MissionActionConsumptionVerdict
```

Verdict (closed):

```ts
{ consumable: true,  authorization: {
    authorityScope: "MISSION_ACTION",    // bounded, never transferable
    governanceDecisionId, businessId,
    missionRef, planRef, taskRef,
    subjectClass, actionType,
    approvalRequestId,                  // null for ALLOW, ledger id for approved
    policyVersion, authorizedAt, expiresAt } }
| { consumable: false, reason: MissionGovernanceReasonCode, permanent: boolean }
```

`permanent: true` exactly when a human rejected the decision identity — the
only path forward is a NEW governed proposal. `BLOCK` decisions are never
consumable.

## 3. Gate semantics (normative)

1. **Exactness first.** The expected action's subjectClass, actionType,
   missionRef, planRef, taskRef AND
   `sha256(canonicalJson(actionParams))` must equal the bound decision's
   coordinates and fingerprint. ANY deviation ⇒
   `APPROVAL_BINDING_MISMATCH`. A modified action after approval invalidates
   the approval; a retry with different parameters is a new action.
2. **ALLOW** is consumable only while `now < validUntil` and
   `currentPolicyVersion === decision.policyVersion`; else
   `EXPIRED_DECISION` / `STALE_POLICY_VERSION`.
3. **REVIEW_REQUIRED** is consumable only with an approved ledger row whose
   embedded binding re-validates against the exact stored decision:
   `governanceDecisionId`, `policyVersion`,
   `approvalBindingHash = sha256({v:1, governanceDecisionId, policyVersion,
   actionParamsFingerprint, missionRiskClass})`, `actionParamsFingerprint`,
   refs, subject, action, businessId, tenant (`approval.userId ===
   decision.userId`), unexpired (`expiresAt > now`), unchanged policy.
   `pending` ⇒ `APPROVAL_PENDING`; `rejected` ⇒ `APPROVAL_REJECTED_BY_HUMAN`
   (permanent); `edited`/forged/tampered ⇒ `APPROVAL_BINDING_MISMATCH`.
4. **No authority smuggling.** The gate accepts NO client/agent/model
   authorization input. There is no `ALLOW` input. The verdict derives only
   from durable rows + the bound policy.
5. **Freshness.** Consumers MUST re-read the decision row and re-run the gate
   immediately before any material effect (and after any relevant state
   change). `revalidate` (R9-F router/service) recomputes the decision under
   current policy when inputs may have drifted.

## 4. Retry / recovery consumption

- A consumable RETRY verdict binds the retry's OWN decision + parameters.
  Consuming it performs the retry — it mints no authority for further
  retries.
- Non-idempotent retries (`RETRY_NEW_SIDE_EFFECT_REVIEW`) and retries whose
  parameters differ from the failed attempt (`RETRY_SCOPE_BROADENED`) are
  floored at REVIEW_REQUIRED: they need a fresh governed decision + approval.
- Recovery actions (`RECOVERY_REQUIRES_FRESH_REVIEW`) require a fresh human
  approval under the default policy; a recovery NEVER inherits the failed
  action's authority and NEVER overrides policy.
- A failed, expired or rejected execution cannot broaden authority through
  retry or recovery.

## 5. What the verdict does NOT authorize

- Any subject, phase, mission, plan, task or parameter set other than the
  exact bound coordinates.
- Any provider call, budget movement, campaign activation, data mutation or
  external side effect beyond the bound action itself — downstream systems
  keep their own authorities (R4 billing, R5-E policy, R7-F governance); a
  mission-governance verdict never substitutes for them.
- Reuse after `expiresAt`, after a policy change, or after human rejection.
- Self-approval: the approval act requires independent out-of-band human
  presence (email OTP, purpose `review_authorization`); a runtime agent
  holding the tenant JWT cannot satisfy it.

## 6. Consumer obligations

1. Call `assertMissionActionConsumable` immediately before the material
   effect; treat `consumable: false` as a hard stop.
2. Source `decision` and `approval` from server-side reads predicated on the
   authenticated tenant — never from request payloads.
3. Persist consumption evidence downstream (execution receipts) referencing
   `governanceDecisionId` + `approvalRequestId`; never write R9-F tables.
4. On `STALE_POLICY_VERSION` / `EXPIRED_*`, request a fresh governed
   evaluation — never cache verdicts across policy versions.

## 7. Versioning

`mission-governance-to-execution/v1`. The verdict shape, reason vocabulary
and binding-hash derivation are frozen per gate version; R9-F bumps the
version only with a new governed contract revision accepted downstream.
