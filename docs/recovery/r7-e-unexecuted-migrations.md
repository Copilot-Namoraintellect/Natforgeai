# R7-E UNEXECUTED MIGRATIONS — PROVISIONAL ARTEFACTS ONLY

> **Stream:** WBS-R7 Stream E — Budget & Portfolio Optimisation
> **Branch:** `feature/r7-e-budget-portfolio-optimisation` (base `8030e97`)
> **Date:** 2026-11-10

## Provisional stream-local migration identity

R7-E appends **one** provisional migration artefact set:

- `db/migrations/0035_r7_e_budget_portfolio_optimisation.sql`
- `db/migrations/meta/0035_snapshot.json`
- journal entry idx 35, tag `0035_r7_e_budget_portfolio_optimisation`

## Numbering / collision

The canonical R6 chain ends at idx 34 (`0034_r6_lead_autonomy_foundation`).
Sibling R7 streams independently created their own provisional idx-35
artefacts (`0035_r7_a_conversion_outcome_foundation`,
`0035_r7_b_attribution_foundation`,
`0035_r7_f_optimisation_governance`). **R7-E does not resolve any sibling
numbering**: no renumbering, no rewriting, no execution of any sibling
artefact, no claim of canonical programme order. Local journal/snapshot parity
is verified for the R7-E artefact only (generated from `db/schema.ts` against
the accepted R5/R6 chain tail, idx 34).

**Canonical sequencing, convergence, and execution authority belong to
R7-X.** Until then these artefacts are inert.

## Execution status

- Migration executed: **FALSE** (artefact created only; no `db:push`, no
  `db:migrate`, no production or shared-environment contact).
- Runtime behavior while the tables are absent: the R7-E production bridge
  probes `information_schema` and fails closed (`EVIDENCE_UNAVAILABLE` for
  evidence reads; snapshot/proposal persistence requires the R7-E tables).
  Tests exercise the full optimisation path exclusively through injected
  in-memory fakes.

## Schema delta introduced (artefact only)

1. **`budget_portfolio_snapshots`** — deterministic, insert-only portfolio
   snapshots (`psn1:` identity); unique anchors `(portfolioSnapshotId)` and
   `(userId, portfolioSnapshotId)`; index on `(userId, businessId)`. Carries
   the approved total, committed/reserved/available amounts (integer minor
   units), current allocations, supported providers, locked and disabled
   allocation keys.
2. **`budget_portfolio_proposals`** — insert-only optimisation proposals
   (`opt1:` identity); unique anchors `(optimisationId)` and
   `(userId, optimisationId)`; indexes on `(userId, businessId)` and
   `(userId, status)`. Carries current/proposed/delta allocations (integer
   minor units), evidence refs, objective, algorithm/constraint versions,
   evidence-bundle hash, confidence class, closed reason codes (≤8), the
   frozen R7-F governance decision JSON + id, approval flag, closed lifecycle
   status, content hash and validity.
3. **`budget_portfolio_allocation_instructions`** — insert-only authorised
   optimisation instructions (`ins1:` identity); unique anchors
   `(instructionId)` and `(userId, instructionId)`; index on
   `(userId, optimisationId)`. Carries the governance decision + approval
   binding, policy version, authorisation/expiry times and the authorised
   target allocation (integer minor units).

No FK constraints couple these tables to anything (house convention: opaque
references, predicate enforcement). Upstream R4/R6/R7 tables are read-only
for this stream.
