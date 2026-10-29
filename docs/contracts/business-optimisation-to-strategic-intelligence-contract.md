# BUSINESS OPTIMISATION → STRATEGIC INTELLIGENCE HANDOFF CONTRACT (R7 → R8)

> **Producer:** R7 Business Optimisation V1 (`integration/r7-business-optimisation`)
> **Consumer:** R8 Strategic Intelligence (WBS-R8)
> **Status:** canonical R7→R8 handoff contract — R8 consumes, never redefines
> **Version:** `business-optimisation-to-strategic-intelligence/v1`
> **Authority base:** R6 Lead Autonomy V1 (`8030e97a…`); R7-A/B/C/D/E/F frozen
> accepted heads integrated at R7-X (see
> `docs/recovery/r7-x-integration-authority.md`)

---

## 1. Purpose and boundaries

R7 produces governed, bounded, evidence-backed business-optimisation
artefacts. R8 (strategic intelligence) consumes them as **read-only strategic
evidence** for strategic memory, external market intelligence,
environment-change interpretation, opportunity/risk synthesis and strategic
recommendation.

**R8 must NOT mutate R7 authority.** Concretely, R8 can never:

- create, verify, reverse, or revalue a business outcome (R7-A authority);
- mint, supersede, re-weight, or claim causation from attribution (R7-B);
- derive, strengthen, suppress, or contradict learning (R7-C);
- create, activate, assign, bind evidence to, or conclude experiments (R7-D);
- create, approve, execute, or reallocate budget/portfolio instructions
  (R7-E + R7-F);
- evaluate, decide, approve, recover, or re-policy governance decisions
  (R7-F);
- raise total approved budget, move locked/reserved funds, or trigger
  billing/payment/provider spend (R4 settling authority only).

R8 does **not** inherit unrestricted financial execution authority. An R8
recommendation that would change money, experiments, or governance must be
expressed as a **new proposal** through the governed R7 surfaces, subject to
R7-F evaluation and human approval exactly like any other client.

## 2. Consumable evidence (read-only)

R8 may consume, per tenant + business scope, through the frozen projection
surfaces only (never direct table reads):

| Evidence | Surface | Notes |
|---|---|---|
| Canonical business outcomes | `outcome.r7Projections` / `outcome.list` (`conversion-outcome/v1`) | Verbatim causation/attribution disclaimers travel with every projection |
| Attribution history | `attribution.get` / `attribution.list` (`attribution-to-learning/v1` shape) | Association evidence only; never causal proof |
| Learning records | `businessLearning.get` / `list` / experiment-optimisation projections | Confidence, contradictions, novelty and limitations preserved, not flattened |
| Experiment designs & results | `experimentation.getDesign` / `getResult` / `getResultHandoffProjection` | Results are scoped causal evidence within design assumptions only |
| Optimisation proposals & instructions | `budgetPortfolio.getOptimisationProposal` / `getInstruction` / `getStrategyHandoff` | `getStrategyHandoff` is the canonical R8 projection (`business-optimisation-to-strategy/v1`, 23-key allowlist — see `docs/contracts/business-optimisation-to-strategy-contract.md`) |
| Governance decisions | `optimisationGovernance.get` / `listDecisions` | Decisions are immutable; stale/expired status is computed, never stored |
| Approved budget envelope | `budgetPortfolio.getPortfolioSnapshot` | Approved total, committed, reserved, locked keys — read-only |
| Confidence / evidence / limitations | every projection above | Must be preserved in R8 memory; weakening them is tampering |
| Trend / change history | immutable lifecycle/projection reads across all surfaces | History is never edited; corrections are new records |

## 3. Tenant, scope and freshness discipline

- Every R8 read is tenant-scoped (`userId`-predicated) and business-scoped;
  cross-tenant or cross-business evidence never resolves and must fail closed.
- R8 must re-validate at consumption time: `contractVersion`, identity
  patterns (`out1:`/`atr1:`/`lrn1:`/`exp1:`/`opt1:`/`ogd1:`/`psn1:`),
  provenance/freshness fields, and upstream status.
- Stale, superseded, contradicted, expired or terminal evidence must be
  labelled as such in R8 outputs — never silently refreshed or dropped.

## 4. Integrity and audit

- R8 consumption is read-only: no R8 call may write to any R7 table.
- Any R8 strategic recommendation derived from R7 evidence must retain the
  provenance references (ids + versions) of the evidence consumed.
- R7 audit taxonomy already records every durable R7 effect; R8 must not
  duplicate or shadow that authority.

## 5. Non-goals

R8 owns strategic memory, market intelligence, environment interpretation,
opportunity/risk synthesis and recommendation. R8 does not own outcome truth,
attribution, learning, experimentation, budget execution, or governance —
those remain exclusively with the R7 authorities defined in
`docs/contracts/conversion-outcome-intelligence-contract.md`,
`docs/contracts/attribution-intelligence-contract.md`,
`docs/contracts/business-learning-contract.md`,
`docs/contracts/experimentation-contract.md`,
`docs/contracts/budget-portfolio-optimisation-contract.md` and
`docs/contracts/business-optimisation-governance-contract.md`.
