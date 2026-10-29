# BUDGET & PORTFOLIO OPTIMISATION CONTRACT (R7-E)

> **Producer:** R7-E (Budget & Portfolio Optimisation) — `feature/r7-e-budget-portfolio-optimisation`
> **Consumers:** R7-F (governance evaluates every proposal), R7-X (programme
> convergence), future R8 strategic intelligence/planning (via the E8 handoff
> contract)
> **Status:** canonical optimisation contract — R7-F and R8 consume, never redefine
> **Implements:** `BUDGET_PORTFOLIO_CONTRACT_VERSION = "budget-portfolio/v1"`,
> `BUDGET_PORTFOLIO_ALGORITHM_VERSION = "budget-portfolio-algorithm/v1"`,
> `BUDGET_PORTFOLIO_CONSTRAINT_VERSION = "budget-portfolio-constraints/v1"`
> **Frozen upstream authority (consumed, not merged):** R7-A (`3e8aea8`),
> R7-B (`6ff9eca`), R7-C (`53b2ff4`), R7-F (`5e4ab95`); R6 Lead Autonomy V1
> base `8030e97`; R4 financial authority (billing/settling only).
> **Inventory:** `docs/recovery/r7-e-budget-portfolio-inventory.md`

R7-E converts governed evidence (outcomes, attribution, learning), the current
campaign/channel portfolio and the approved budget authority into **bounded,
explainable optimisation proposals**. R7-E proposes; R7-F authorizes; R4
settles. This stream never executes billing, payments, provider spend,
campaign mutation or strategy mutation.

---

## 1. Monetary convention

All money is integer **minor units** (cents). No floating-point money exists
anywhere in this stream: budgets, allocations, deltas, caps and thresholds are
integers; ratios that must be compared (concentration, shift fraction) are
computed with integer cross-multiplication or basis points. Deltas are signed;
allocations are non-negative. Rounding, where redistribution requires it, is
deterministic largest-remainder with a stable key-order tie-break — rounding
never creates or destroys money (Σ proposed = Σ current across a pure
reallocation).

## 2. Closed vocabularies

**Objectives (closed):** `MAXIMISE_EVIDENCE_WEIGHTED_VALUE` (default),
`REBALANCE_TO_POLICY_TARGET`.

**Confidence classes (closed, R7-E-derived evidence-strength label):**
`STRONG`, `MODERATE`, `WEAK`, `INSUFFICIENT`.

**Proposal status (closed lifecycle):**
`PROPOSED` (created, governance evaluation recorded on it) →
`ALLOWED` (governance ALLOW) /
`REVIEW_REQUIRED` (governance REVIEW_REQUIRED, awaiting human approval) /
`BLOCKED` (governance BLOCK — terminal for this identity) →
`AUTHORIZED` (executable assertion passed within validity) /
`REJECTED` (human rejection — permanent for this identity) /
`EXPIRED` (decision/approval validity lapsed — re-proposal required) /
`NO_CHANGE` (solver determined the portfolio must hold; no governance
evaluation is required because no material changes).
Corrections are new proposal identities; rows are insert-only.

**Reason codes (closed, ≤ 8 per record, deterministic order):**
`NO_VIABLE_IMPROVEMENT`, `CHANGE_BELOW_MINIMUM_THRESHOLD`, `EVIDENCE_INSUFFICIENT`,
`EVIDENCE_STALE`, `EVIDENCE_CONTRADICTED`, `LEARNING_CONTRADICTED`,
`SNAPSHOT_STALE`, `LOCKED_FUNDS_PRESERVED`, `RESERVED_FUNDS_PRESERVED`,
`UNSUPPORTED_PROVIDER_EXCLUDED`, `DISABLED_CAMPAIGN_EXCLUDED`,
`MIN_ALLOCATION_FLOOR_APPLIED`, `CONCENTRATION_CEILING_APPLIED`,
`PER_CYCLE_SHIFT_CAP_APPLIED`, `COOLDOWN_ACTIVE`, `REVERSAL_STABILITY_HOLD`,
`GOVERNANCE_ALLOWED`, `GOVERNANCE_REVIEW_REQUIRED`, `GOVERNANCE_BLOCKED`,
`GOVERNANCE_UNAVAILABLE`, `TOTAL_BUDGET_INCREASE_FORBIDDEN`.

## 3. Allocation keys

`camp:<campaignId>` — campaign allocation (v1 canonical granularity).
The grammar `^[A-Za-z0-9][A-Za-z0-9:_|-]{0,95}$` matches the R7-F
`ALLOCATION_KEY_PATTERN`; governance rejects anything outside it. Channel- and
audience-level keys remain available for future versions without a vocabulary
change.

## 4. Portfolio snapshot (E2 — the deterministic authority view)

Identity: `portfolioSnapshotId = "psn1:" + sha256(canonicalJson({v:1, userId,
businessId, budgetPeriod, currency, approvedTotalBudgetMinor, committedMinor,
reservedMinor, currentAllocations, supportedProviders, lockedAllocationKeys,
disabledAllocationKeys}))`.

**Same authoritative state → same snapshot identity.** No wall-clock field
participates. The snapshot is assembled **server-side only** (client may
supply nothing but `{businessId}`): the current allocations derive from
canonical campaign rows; committed/reserved derive from canonical
commitment/reservation truth; the approved total derives from the budget
authority derivation documented in the inventory (E0 §10-F1) — the client can
never fabricate the total budget or available funds.

| Field | Type | Meaning |
|---|---|---|
| `portfolioSnapshotId` | `psn1:<sha256-64>` | Deterministic snapshot identity (above). |
| `userId` | number | Tenant anchor (server session). |
| `businessId` | number | Owning business (id + tenant re-verified). |
| `budgetPeriod` | `YYYY-MM` | Budget period (UTC). |
| `currency` | `AAA` | Closed 3-letter code. |
| `approvedTotalBudgetMinor` | int | Approved total for the period (minor). |
| `committedMinor` | int | Σ current campaign allocations. |
| `reservedMinor` | int | Funds held by reservations (immutable). |
| `availableReallocatableMinor` | int | `approvedTotal − committed − reserved` (derived, server-side). |
| `currentAllocations` | `Record<key, int>` | Current allocation per key (minor). |
| `supportedProviders` | `string[]` | Providers that may receive allocation. |
| `lockedAllocationKeys` | `string[]` | Keys whose funds cannot move. |
| `disabledAllocationKeys` | `string[]` | Keys ineligible for new allocation (draft/completed campaigns, unsupported providers). |
| `capturedAt` | ISO 8601 | Capture time (freshness only — never in the identity). |

A snapshot older than the governance policy staleness horizon
(`staleBudgetStateMs`) **fails closed** before any material action. Snapshots
are insert-only; replays converge on `(userId, portfolioSnapshotId)`.

## 5. Optimisation proposal (E1 record — the explainable deliverable)

Identity: `optimisationId = "opt1:" + sha256(canonicalJson({v:1, userId,
businessId, portfolioSnapshotId, objective, algorithmVersion,
constraintVersion, evidenceBundleHash}))` where `evidenceBundleHash` covers
the sorted outcome/attribution/learning reference sets. Identical inputs ⇒
identical proposal ⇒ durable convergence (duplicate/concurrent requests
re-read the committed row; `idempotent_replay`). Replaying the same identity
with different material fails closed (`OPTIMISATION_REPLAY_CONFLICT`).

Content integrity: `proposalContentHash = sha256(canonicalJson({v:1,
optimisationId, currentAllocations, proposedAllocations, deltaAllocations,
confidenceClass, reasonCodes}))` — re-verified on every read (tamper →
`OPTIMISATION_EVIDENCE_CONFLICT`).

| Field | Type | Meaning |
|---|---|---|
| `optimisationId` | `opt1:<sha256-64>` | Deterministic proposal identity (above). |
| `userId` | number | Tenant anchor. |
| `businessId` | number | Owning business. |
| `portfolioSnapshotId` | `psn1:…` | The snapshot this proposal is computed against. |
| `budgetPeriod` | `YYYY-MM` | Copied from the snapshot. |
| `currentTotalBudgetMinor` | int | Σ current allocations (minor). |
| `currentAllocations` | `{allocationKey, campaignId, provider, amountMinor}[]` | Authoritative starting point. |
| `proposedAllocations` | same shape | Solver output; Σ ≤ approved total. |
| `deltaAllocations` | `{allocationKey, deltaMinor}[]` | Signed deltas; Σ = 0 for a pure reallocation. |
| `evidenceRefs` | `string[]` | Opaque upstream ids cited (outcome `out1:`, attribution `atr1:`, learning `lrn1:`). |
| `learningRefs` / `attributionRefs` / `outcomeRefs` | `string[]` | Partitioned references (provenance). |
| `objective` | closed | §2. |
| `algorithmVersion` | `budget-portfolio-algorithm/v1` | Closed. |
| `constraintVersion` | `budget-portfolio-constraints/v1` | Closed. |
| `confidenceClass` | closed | §2 — evidence-strength label for the whole proposal. |
| `reasonCodes` | closed (≤8) | §2 — deterministic order; explainability. |
| `governanceDecisionId` | `ogd1:… \| null` | R7-F decision bound to this proposal (null for NO_CHANGE). |
| `approvalRequired` | boolean | Copied verbatim from the R7-F decision (never R7-E-derived). |
| `status` | closed | §2 lifecycle. |
| `createdAt` | ISO 8601 | Persistence time. |
| `validUntil` | ISO 8601 \| null | Copied from the R7-F decision (null for BLOCKED/NO_CHANGE). |

The governance **decision material** sent to R7-F (proposal type
`BUDGET_REALLOCATE` for material moves, `STRATEGY_RECOMMENDATION` for
NO_CHANGE explainability-only outputs) cites exactly: `proposalId =
optimisationId`, the snapshot-derived `financial.allocationDeltas` and
`portfolio.resultingAllocations`, and `evidenceHash = evidenceBundleHash`.
R7-E never supplies decision/risk/approval/policy fields; R7-F's verdict is
persisted verbatim and is immutable to R7-E.

## 6. Evidence → performance model (E3)

Deterministic integer weights; no model opinion assigns financial weight.
Per allocation key the score folds:

- outcome status — `VERIFIED` weight > `PROVISIONAL` > `OBSERVED`
  (verified outcomes always outweigh provisional where policy specifies);
- outcome value (integer minor) as mass;
- attribution evidence — credit allocated at `confidenceClass`
  (`HIGH` > `MEDIUM` > `LOW`); `NONE`/`INSUFFICIENT_EVIDENCE` contributes zero;
- learning — `confidenceClass` (`STRONG` > `MODERATE` > `WEAK`);
  `CONTRADICTED`/stale learning reduces or blocks movement on the subject;
- contradiction count, recency bucket, and evidence volume as bounded integer
  factors.

Single-event influence is explicitly capped (a fixed ceiling on any one
outcome's contribution to a key's score), so no single short-term outcome can
trigger runaway allocation. Weak/contradicted/stale evidence reduces or blocks
optimisation strength; it never accelerates it.

## 7. Bounded solver (E4) and stability (E5)

The solver guarantees, for every proposal that changes money:

1. Σ proposed allocations ≤ approved total budget (and = current allocatable
   total for a pure reallocation);
2. no negative allocation; no arbitrary deltas — every delta is a movement
   from one in-scope key to another;
3. locked funds, reserved funds and disabled/unsupported allocations are
   preserved exactly (zero delta);
4. per-cycle shift cap, concentration ceiling, minimum-allocation floor and
   unsupported-provider exclusions are enforced before governance ever sees
   the proposal;
5. anti-oscillation: maximum change per cycle, cooldown per allocation key,
   minimum evidence delta (hysteresis) and repeated-reversal detection —
   noisy small signals produce `NO_CHANGE` with
   `CHANGE_BELOW_MINIMUM_THRESHOLD`/`REVERSAL_STABILITY_HOLD`, never thrash.

## 8. Governance binding and execution boundary (E6/E7)

- Every material proposal is evaluated by **R7-F** before execution
  eligibility. `ALLOW` ⇒ eligible only within the exact governed proposal;
  `REVIEW_REQUIRED` ⇒ human approval on the approval ledger is required;
  `BLOCK` ⇒ never executable. R7-E revalidates governance (fresh snapshot,
  fresh policy, fresh evidence) immediately before any authorization state
  transition.
- The only execution gate is R7-F's `assertOptimisationActionExecutable`;
  R7-E calls it and never modifies a governance decision, never self-approves,
  and exposes no endpoint that marks a proposal allowed.
- R7-E emits **optimisation instructions only**. No billing, payment,
  provider, CRM, campaign or strategy execution exists in this stream; the
  authorised-instruction projection (E8) is read-only planning material.

## 9. Downstream strategy handoff (E8)

`docs/contracts/business-optimisation-to-strategy-contract.md` — read-only
projection for future R8 planning: optimisation id, business, budget period,
current vs proposed allocation, evidence refs, confidence, constraints,
governance decision, approval status, validity, algorithm/version, reason
codes. R7-E never mutates strategy.

## 10. Rogue-agent posture

- The optimisation agent cannot raise the total budget, unlock reserved
  funds, alter evidence, fabricate outcomes, modify attribution confidence,
  delete contradictions, change a governance result, self-approve, execute
  payment/billing, reach provider credentials, run shell/SQL, or modify its
  own constraints/permissions: every one of those authorities lives in a
  frozen upstream stream consumed read-only, and every client-supplied
  authority field is rejected at the boundary (`z.strictObject`).
- Policy knobs (caps, ceilings, thresholds, freshness horizons) are
  server-side code constants in the frozen constraint set; there is no
  runtime mutation endpoint.

## 11. Schema

`budget_portfolio_snapshots`, `budget_portfolio_proposals`,
`budget_portfolio_allocation_instructions` — stream-local provisional
migration `0035_r7_e_budget_portfolio_optimisation` (artefact only, **NOT
executed**; collision with sibling provisional `0035_*` artefacts documented
in `docs/recovery/r7-e-unexecuted-migrations.md`; R7-X owns canonical
sequencing). No FKs (house convention: opaque references, predicate
enforcement); upstream tables are read-only.

---

**R7-F and R8: consume optimisation through this contract. Optimisation
proposes; governance authorizes; R4 settles. Do not redefine optimisation
authority.**
