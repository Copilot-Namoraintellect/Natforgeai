# R7-E BUDGET & PORTFOLIO OPTIMISATION — AUTHORITY / PORTFOLIO INVENTORY (E0)

> **Stream:** WBS-R7 Stream E — Budget & Portfolio Optimisation
> **Branch:** `feature/r7-e-budget-portfolio-optimisation` (base `8030e97`)
> **Date:** 2026-11-10
> **Purpose:** identify every authority R7-E consumes before writing any code.
> No competing budget truth is created; every financial fact below is owned by
> the named authority and consumed read-only.

---

## 1. Frozen upstream authorities (consumed through branch refs only; NOT merged)

| Stream | Branch ref | Frozen HEAD | Verdict | What R7-E consumes |
|---|---|---|---|---|
| R7-A Conversion Outcome Intelligence | `feature/r7-a-conversion-outcome-intelligence` | `3e8aea8` | `CONVERSION_OUTCOME_INTELLIGENCE_READY` | Outcome projection (`conversion-outcome/v1`, 27-key allowlist): `outcomeStatus` (`VERIFIED`/`PROVISIONAL`/`OBSERVED`/terminal), `amountMinor`, `currency`/`currencyExponent`, `occurredAt`, lifecycle, evidence provenance. Consumed as evidence only — never promoted, never mutated. |
| R7-B Attribution Intelligence | `feature/r7-b-attribution-intelligence` | `6ff9eca` | `ATTRIBUTION_INTELLIGENCE_READY` | Attribution learning projection (`attribution-to-learning/v1`): `touchpoints[]` with integer `creditBps`, `confidenceClass` (`HIGH`/`MEDIUM`/`LOW`/`NONE`), `evidenceClass` (`DIRECT_LINKAGE`/`STRONG_ASSOCIATION`/`WEAK_ASSOCIATION`/`INSUFFICIENT_EVIDENCE`), `outcomeStatus` snapshot. Credit is association, never causation. |
| R7-C Business Learning Engine | `feature/r7-c-business-learning` | `53b2ff4` | `BUSINESS_LEARNING_ENGINE_READY` | Experiment/optimisation projection (`business-learning-to-experiment-optimisation/v1`, 23-key allowlist): `confidenceClass` (`INSUFFICIENT_EVIDENCE`/`WEAK`/`MODERATE`/`STRONG`), `evidenceClass`, `status` (`SUPPORTED`/`CONTRADICTED`/…), `supportCount`, `contradictionCount`, `subjectType`/`subjectId`, `freshness{stale, provisional, contradictionUnresolved}`, `governanceAuthorityRequired: "R7-F"`. Learning is evidence, never authority. |
| R7-F Optimisation Governance | `feature/r7-f-optimisation-governance` | `5e4ab95` | `OPTIMISATION_GOVERNANCE_READY` | The governance authority. Proposal surface (`evaluate`, `revalidate`), decision record, approval gate `assertOptimisationActionExecutable`, budget/portfolio authority snapshot shapes, closed action taxonomy (`BUDGET_REALLOCATE`, `BUDGET_DECREASE`, `CHANNEL_REALLOCATE`, `AUDIENCE_REALLOCATE`, `CAMPAIGN_PRIORITY_CHANGE`, `STRATEGY_RECOMMENDATION`, …). |

Contract docs consumed (frozen branch copies, read via `git show` only):
`business-optimisation-governance-contract.md`, `conversion-outcome-intelligence-contract.md`,
`conversion-outcome-to-attribution-learning-contract.md`, `attribution-intelligence-contract.md`,
`business-learning-contract.md`, `business-learning-to-experiment-optimisation-contract.md`.

## 2. R7-F binding surface (E6/E7 consume exactly this)

- **Proposal material** (`buildOptimisationProposal`): `proposalId`, `businessId`,
  `proposalType` (closed taxonomy), `campaignId|null`, `financial{currency,
  allocationDeltas[{allocationKey, campaignId, provider, deltaMinor,
  newCommitment?, irreversibleExternalSpend?}], advisoryFinancialClass?}`,
  `experiment|null`, `portfolio{resultingAllocations?}|null`,
  `learningReference{learningVersion, computedAt}|null`, `evidenceHash`,
  `requestedAt`. Client-supplied authority fields
  (`decision`, `riskClass`, `approved`, `policyVersion`, `ignoreBudget`, …) are
  rejected at the boundary.
- **Budget authority snapshot** (server-resolved): `budgetPeriod` (`YYYY-MM`),
  `currency`, `approvedTotalBudgetMinor`, `committedMinor`, `reservedMinor`,
  `supportedProviders[]`, `lockedAllocationKeys[]`, `stateCapturedAt`.
- **Portfolio authority snapshot**: `currentAllocations` (allocationKey → minor),
  `lastReallocationAtByKey`.
- **Decision**: `ALLOW` / `REVIEW_REQUIRED` / `BLOCK`; `approvalRequired` iff
  REVIEW_REQUIRED; `validUntil`; `governanceDecisionId` (`ogd1:`). Authority only
  ever narrows.
- **Execution gate**: `assertOptimisationActionExecutable(decision, approval,
  currentPolicyVersion, now)` — the single gate before any material change.
  R7-E calls it and revalidates before any state transition; R7-E never modifies
  a governance decision.
- **R7-F default policy** (server-side, conservative): no autonomous total-budget
  increase; no new commitments; no irreversible spend; risk ≥ medium → review;
  portfolio ceilings `maxConcentrationFraction 0.5`, `maxSingleShiftFraction 0.2`,
  `minReallocationIntervalMs 24h`, `maxLearningAgeMs 7d`; `staleBudgetStateMs 15min`.

## 3. R4 financial authority (base `8030e97` — exact existing financial truth)

| Fact | Location | Owner | R7-E rule |
|---|---|---|---|
| Per-campaign allocation field `campaigns.budget` (int, whole USD) | `db/schema.ts` (`campaigns`) | R4 campaign lifecycle | Read-only input to portfolio snapshot; never written by R7-E. |
| Business budget hint `businesses.monthlyBudget` (int) | `db/schema.ts` (`businesses`) | Business profile | Context only; NOT an approved-total authority. |
| Reservation state machine `credit_reservations` (`reserved→settled\|released`, terminal) | `db/schema.ts`, `api/lib/billing/credit-reservation*.ts` | R4-E financial reliability | Reserved funds are immutable to optimisation. R7-E never creates/settles/releases reservations. |
| Billing engines (`credit-engine`, `cost-control`, `cost-tracker`) | `api/lib/billing/*` | R4 | Never invoked. R4 billing authority remains the only settling authority. |
| Billing key registry (frozen idempotency formats) | `docs/contracts/financial-reliability-contract.md` | R4-E | R7-E mints no billing identities and touches no billing key. |
| Admin payment receiving methods (`banking_details`) | `db/schema.ts`, `api/banking-router.ts` | R4 admin | Out of scope; never touched. |

**Existing optimisation/learning logic inspected:** `api/lib/learning/*` (R4-D
learning autonomy — workflow learning, not business-learning evidence),
`api/lib/strategy/*` (strategy snapshots — planning authority R7-E does not
mutate), `api/lib/agents/*` (agent runners with their own billing identity —
untouched). None of these performs portfolio reallocation; no competing
optimisation allocation logic exists in the base.

**R7-F bridge derivation (base-compatible placeholder):** the R7-F production
bridge derives the budget authority snapshot from canonical `campaigns.budget`
rows (`approvedTotalBudgetMinor = Σ budget × 100`, USD, empty locked/reserved
sets), explicitly marked "until R7-E lands a dedicated budget-envelope table".
R7-E's portfolio snapshot (E2) is that dedicated, deterministic authority view:
same authoritative state → same snapshot identity. It **derives from** canonical
campaign/business/reservation truth; it does not replace or duplicate settling
authority.

## 4. Campaign / channel / provider capability inventory

- Campaigns carry `status` (`draft|active|paused|completed`), `platforms` (text),
  `budget` (int USD), `businessId`, `userId`. Disabled/draft/completed campaigns
  receive no new allocation from the solver (constraint, E4).
- Channel/provider capability is expressed as the closed provider set
  (`meta`, `google`, `linkedin`, `tiktok`, `email` per the R7-F bridge
  derivation). The budget authority snapshot's `supportedProviders` is the
  authoritative list; anything outside it cannot receive allocation (E4).
- No live channel-spend execution path exists for R7-E to (mis)use; provider
  execution remains R4/R5 authority.

## 5. Budget periods

- The budget authority snapshot is keyed by `budgetPeriod` (`YYYY-MM`, UTC).
- Current period derivation: UTC month of the snapshot clock. Snapshots are
  deterministic per (tenant, business, period, authoritative state); a stale
  snapshot (age > policy `staleBudgetStateMs` at use time) fails closed before
  any material action (E2/E6).

## 6. Current reservations / commitments

- `committedMinor` = Σ current campaign allocations (canonical campaigns).
- `reservedMinor` = funds held by R4 `credit_reservations` in `reserved` state
  (read-only view where available; empty in the pre-R7-X baseline, matching the
  R7-F bridge placeholder).
- `lockedAllocationKeys` = allocation keys whose funds cannot move (R7-E
  constraint input; empty in baseline).
- `availableReallocatableMinor = approvedTotal − committed − reserved` is a
  derived, server-side quantity; the client can never supply or modify it.

## 7. Audit / approval infrastructure (reused, not rebuilt)

- Audit: canonical `api/lib/audit/audit-event.ts` taxonomy + `persistAuditEvent`.
  R7-E appends its own additive event types (see stream code); convergence paths
  emit zero events.
- Approval: `approval_requests` ledger (R6-D `sales_handoff` authority + R7-F
  `optimisation_action` provisional enum extension). R7-E never approves; for
  REVIEW_REQUIRED proposals it surfaces the R7-F approval command routing only.

## 8. Schema / migration state

- Base canonical chain ends at `0034_r6_lead_autonomy_foundation` (executed
  programme history through R5/R6; journal idx 34 is the accepted tail).
- Provisional sibling artefacts (artefact-only, NOT executed, do not converge):
  `0035_r7_a_conversion_outcome_foundation`, `0035_r7_b_attribution_foundation`,
  `0035_r7_f_optimisation_governance`.
- R7-E appends **one** provisional artefact `0035_r7_e_budget_portfolio_optimisation`
  (idx 35 collision documented; R7-X owns canonical convergence).
  `MIGRATION_EXECUTION=False`. No alteration of 0034 or any sibling artefact.

## 9. Authority boundary summary (what R7-E must NOT own)

R7-A outcome authority; R7-B attribution authority; R7-C learning authority;
R7-F governance policy; R4 billing/settling/reservation mutation; provider
execution; campaign execution; experiment execution; approval authority; total
business budget authority; strategy authority. R7-E produces **proposals,
snapshots, projections** only.

## 10. Findings that shape the design

1. **F1 — Approved-total truth:** the only durable approved-total derivation in
   the base is the R7-F bridge's campaign-envelope sum. R7-E's snapshot makes
   that derivation deterministic and identity-bearing without creating new
   budget truth; until a dedicated budget-authority table exists (R7-X scope),
   `approvedTotal = Σ campaign allocations` per period with zero autonomous
   headroom — meaning optimisation can only **reallocate within** the approved
   envelope (core principle 2/3 hold by construction).
2. **F2 — Governance first:** R7-F already defines the exact proposal and
   snapshot shapes; R7-E binds to them verbatim (frozen validator copies in
   `api/lib/budget-portfolio/r7-f-bridge/`, replaced by canonical imports at
   R7-X — same pattern as R6-C's qualification bridge).
3. **F3 — No-money invariant is structural:** integer minor units everywhere;
   deltas signed; sum of proposed allocations never exceeds the approved total;
   reallocation preserves the allocatable total; rounding is deterministic
   largest-remainder — no money creation (E4/E9-13).
4. **F4 — Everything upstream is read-only:** outcomes, attributions, learning,
   governance decisions are consumed as projections; R7-E writes only its own
   tables (snapshots, proposals, allocation instructions, events).
