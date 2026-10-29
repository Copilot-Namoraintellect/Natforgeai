# BUSINESS OPTIMISATION GOVERNANCE CONTRACT (R7-F)

> **Producer:** R7-F (Optimisation Governance) — `feature/r7-f-optimisation-governance`
> **Consumers:** R7-B (Attribution Intelligence), R7-C (Business Learning),
> R7-D (Experimentation), R7-E (Budget/Portfolio Optimisation), R7-X
> **Status:** canonical governance contract — consumers use, never redefine
> **Implements:** `OPTIMISATION_GOVERNANCE_CONTRACT_VERSION = "optimisation-governance/v1"`
> `OPTIMISATION_GOVERNANCE_ENGINE_VERSION = "optimisation-governance-engine/v1"`
> **Frozen upstream authority (consumed, not merged):** R6 Lead Autonomy V1
> base `8030e97` (`LEAD_AUTONOMY_V1_READY`); R7-X owns programme convergence.

R7-F decides **whether** an optimisation action may proceed. It does not
decide **which** campaign, channel, experiment or allocation is optimal, and
it never becomes the optimisation engine. Governance authorizes or
prohibits; the optimisation algorithm stays in R7-B/C/D/E.

---

## 1. Decision record (the immutable governance receipt)

One row in `optimisation_governance_decisions` per evaluation identity.
Rows are insert-only; corrections are new decisions.

| Field | Type | Meaning |
|---|---|---|
| `governanceDecisionId` | `ogd1:<sha256-64>` | Deterministic: one proposal material + one policy version → one id. Unique convergence anchor with `(userId)`. |
| `businessId` | bigint | Owning business (server-verified, both id + tenant). |
| `userId` | bigint | Tenant. Every query predicates it; cross-tenant is impossible by construction. |
| `proposalId` | varchar(128) | Durable id of the upstream proposal (client-supplied, format-validated). |
| `proposalType` | varchar(32) | Closed taxonomy value (§3). Unknown → BLOCK. |
| `policyVersion` | varchar(96) | Versioned policy artefact bound at evaluation (§5). |
| `decision` | varchar(24) | `ALLOW` \| `REVIEW_REQUIRED` \| `BLOCK` (§2). |
| `reasonCodes` | json (string[], ≤8) | Closed vocabulary (§4), deterministic order. |
| `riskClass` | varchar(16) | `low` \| `medium` \| `high` \| `critical` — server-derived only. |
| `financialImpactClass` | varchar(48) | Closed class (§6) — server-derived only. |
| `financialDeltaMinor` | bigint | Sum of signed allocation deltas (minor units). |
| `approvalRequired` | boolean | True iff `decision = REVIEW_REQUIRED`. |
| `approvalBinding` | json \| null | Present iff review required (§7). |
| `evidenceHash` | varchar(128) | Opaque fingerprint of the upstream evidence bundle cited by the proposal. |
| `proposalFingerprint` | char(64) | Deterministic hash of the material proposal fields. |
| `validUntil` | ISO 8601 \| null | Decision/approval expiry (`null` for BLOCK). |
| `evaluatedAt` | ISO 8601 | Explicit evaluation clock (supplied by caller; never read here). |
| `evaluationFingerprint` | char(64) | Hash over the decision material — replay/evidence verification. |
| `thresholds` | json | Bounded snapshot of the policy thresholds applied (auditability). |
| `createdAt` | timestamp | Persistence time. |

## 2. Closed decision vocabulary

`ALLOW` — the action may proceed autonomously within `validUntil` and only
while the bound `policyVersion` remains current.

`REVIEW_REQUIRED` — a human must approve through the governed approval
ledger before any execution; the decision carries an approval binding (§7).

`BLOCK` — the action must not proceed in this form. Recovery is a new
governed proposal, never a mutation of this record.

Anything outside this vocabulary is a programming error. **Authority only
ever narrows** (`ALLOW → REVIEW_REQUIRED → BLOCK`) as dimensions are
composed; no evaluation path may widen a disposition.

## 3. Closed action taxonomy (`proposalType`)

`LEARNING_PROMOTION`, `EXPERIMENT_CREATE`, `EXPERIMENT_ACTIVATE`,
`EXPERIMENT_STOP`, `BUDGET_REALLOCATE`, `BUDGET_INCREASE`,
`BUDGET_DECREASE`, `CHANNEL_REALLOCATE`, `AUDIENCE_REALLOCATE`,
`CAMPAIGN_PRIORITY_CHANGE`, `STRATEGY_RECOMMENDATION`.

Unknown or unregistered action types are **BLOCKED**
(`UNKNOWN_OPTIMISATION_ACTION_TYPE`). Adding a type is a code change to the
closed list, never runtime data.

## 4. Closed reason-code vocabulary

Defined in `optimisation-governance-contract.ts`
(`OPTIMISATION_GOVERNANCE_REASON_CODES`, 20+ codes, ≤8 per record):
policy presence/version (`POLICY_MISSING`, `UNKNOWN_POLICY_VERSION`,
`STALE_POLICY_VERSION`), tenancy (`OWNERSHIP_MISMATCH`,
`CROSS_TENANT_PROPOSAL`), proposal hygiene (`MALFORMED_PROPOSAL`,
`UNKNOWN_OPTIMISATION_ACTION_TYPE`, `CLIENT_AUTHORITY_FIELD_REJECTED`),
financial authority (`STALE_BUDGET_STATE`, cap/fraction ceilings,
`TOTAL_BUDGET_INCREASE_REQUIRES_APPROVAL`,
`NEW_FINANCIAL_COMMITMENT_REQUIRES_APPROVAL`,
`IRREVERSIBLE_SPEND_REQUIRES_APPROVAL`, `REALLOCATION_SOURCE_LOCKED`,
`RESERVED_FUNDS_IMMUTABLE`, `UNSUPPORTED_PROVIDER`,
`FINANCIAL_CLASS_DECLARATION_MISMATCH`), evidence freshness
(`STALE_LEARNING`), experiment constraints (`EXPERIMENT_*`,
`PROTECTED_TRAIT_OPTIMISATION_BLOCKED`), portfolio limits
(`CONCENTRATION_LIMIT_EXCEEDED`, `SUDDEN_REALLOCATION_SHIFT_LIMIT`,
`REALLOCATION_OSCILLATION_DETECTED`), risk and security
(`APPROVAL_REQUIRED_BY_RISK`, `HIGH_RISK_REVIEW_REQUIRED`,
`CRITICAL_RISK_BLOCKED`, `PROMPT_INJECTION_SUSPECTED`), and approval-gate
codes (`APPROVAL_NOT_FOUND`, `APPROVAL_PENDING`,
`APPROVAL_REJECTED_BY_HUMAN`, `APPROVAL_BINDING_MISMATCH`,
`EXPIRED_APPROVAL`, `EXPIRED_DECISION`, `AGENT_SELF_APPROVAL_FORBIDDEN`).

## 5. Policy authority

Policy is a **code-level, versioned, immutable registry**
(`optimisation-policy.ts`). There is no runtime mutation endpoint; an agent
can never modify its own policy, raise a budget ceiling, or change an
approval threshold. Versions are content-addressed artefacts;
`UNKNOWN_POLICY_VERSION` and `STALE_POLICY_VERSION` fail closed. The
default policy is conservative: no autonomous total-budget increase, no new
commitments, no irreversible spend; risk ≥ medium requires human review;
critical is blocked; unknown actions are blocked.

Policy knobs (all server-side): risk dispositions (validated monotone
non-increasing), decision validity, financial ceilings (autonomous
reallocation cap, fraction-of-total limit, bounded total-increase envelope
— off by default, commitment/irreversibility switches, budget-state
staleness), experiment constraints (concurrency, per-experiment budget,
prohibited dimensions, duration bounds, protected traits), and portfolio
limits (concentration fraction, single-shift fraction, reallocation
interval, learning freshness).

## 6. Financial authority (F3)

All money is integer **minor units**; deltas are signed. The financial
impact class is derived server-side from the action type + proposal
material; a client-declared advisory class that understates the derived
class is recorded (`FINANCIAL_CLASS_DECLARATION_MISMATCH`) and never
honoured. Classes, in increasing authority demand:
`RECOMMENDATION_ONLY` < `REALLOCATION_WITHIN_APPROVED_TOTAL` <
`TOTAL_BUDGET_INCREASE` < `NEW_FINANCIAL_COMMITMENT` <
`IRREVERSIBLE_EXTERNAL_SPEND`.

Hard invariant: **an autonomous optimisation agent must not increase total
authorized business spend merely because its algorithm recommends doing
so.** Under the default policy any total increase routes to human review;
an explicitly configured bounded envelope is required for any autonomous
increase, and the envelope is a policy artefact, never client-selected.
Locked/reserved funds are immutable; unsupported providers cannot receive
budget; stale budget state blocks. This stream never charges, settles,
reserves or releases anything — the R4 billing authority remains the only
settling authority.

## 7. Human approval (F4)

REVIEW_REQUIRED decisions mint one deterministic approval request on the
existing `approval_requests` ledger (`approvalType = "optimisation_action"`,
provisional enum extension — canonicalised by R7-X). The durable binding
pins the exact business, proposal, action, financial impact, policy
version, proposal fingerprint and expiry. Rejected: generic approvals,
stale approvals, cross-business replay, cross-proposal replay, modified
proposal after approval, agent self-approval, client-supplied fake
approval. Human rejection permanently blocks the proposal identity.

The only execution gate is `assertOptimisationActionExecutable(decision,
approval, currentPolicyVersion, now)` — R7-B/C/D/E MUST call it (and
revalidate governance) immediately before any material state change.

## 8. Rogue-agent posture (F7)

- Model/agent output is **proposal material only**; no generated field
  (`approved`, `override`, `admin`, `ignoreBudget`, risk class, decision,
  policy version, financial class) can create authority — client-supplied
  authority fields are rejected at the boundary.
- Policy, thresholds, ceilings and approvals are server-side only.
- The stream contains no billing/payment/provider/CRM execution paths and
  no shell/SQL facility; audit history is append-only and fingerprinted.
- Injection suspicion only ever raises risk, never widens authority.

## 9. Router surface (authed-only; strictObject inputs)

`evaluate` · `get` · `listDecisions` · `getOperationsProjection` ·
`revalidate` · `recordRecovery` · `getPolicy`. No `setPolicy`,
`forceAllow`, `forceComplete`, `setApproved`, or `overridePolicy` exists.

## 10. Downstream contract (R7-B/C/D/E)

1. **proposal → governance evaluation**: build a proposal (material only),
   call `evaluate`; persist/inspect the returned decision.
2. **proposal + valid approval → execution eligibility**: call
   `assertOptimisationActionExecutable` before any material state change;
   for REVIEW_REQUIRED decisions supply the approved approval row.
3. **Revalidate immediately before any material state change**: authority
   snapshots (budget, portfolio, experiment, policy) drift; use
   `revalidate` with fresh proposal material. A changed evaluation is a new
   decision — stored decisions are immutable.

## 11. Audit

Exactly one `optimisation_governance_decision` audit event per inserted
decision (zero on replay/convergence) and one
`optimisation_governance_recovery` per narrow recovery action. The audit
ledger is the existing canonical store, reused unchanged.

## 12. What this contract forbids R7-F

Attribution calculation, learning, experiment result computation,
treatment assignment, budget optimisation algorithm, strategy generation,
campaign creation, conversion authority, lead authority, payment
execution, billing, provider execution, and any mutation of upstream R6/R5
authority. Governance may authorize or prohibit actions; it must not
secretly become the optimisation engine.
