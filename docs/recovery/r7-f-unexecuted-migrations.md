# R7-F UNEXECUTED MIGRATIONS — PROVISIONAL ARTEFACTS ONLY

> **Stream:** WBS-R7 Stream F — Business Optimisation Governance
> **Branch:** `feature/r7-f-optimisation-governance` (base `8030e97`)
> **Date:** 2026-11-05

## Provisional stream-local migration identity

R7-F appends **one** provisional migration artefact set:

- `db/migrations/0035_r7_f_optimisation_governance.sql`
- `db/migrations/meta/0035_snapshot.json`
- journal entry idx 35, tag `0035_r7_f_optimisation_governance`

## Numbering

R7-F is the first R7 stream to append after the canonical R6 `0034`
artefact; idx 35 is the next free programme slot. Sibling R7 streams (A–E)
may create their own provisional artefacts independently. **R7-F does not
resolve any sibling numbering**: no renumbering, no rewriting, no execution
of any sibling artefact, and no claim of canonical programme order. Local
journal/snapshot parity was verified for the R7-F artefact only (generated
from `db/schema.ts` against the accepted R5/R6 chain tail, idx 34
`0034_r6_lead_autonomy_foundation`).

**Canonical sequencing, convergence, and execution authority belong to
R7-X.** Until then these artefacts are inert.

## Execution status

- Migration executed: **FALSE** (artefact created only; no `db:push`, no
  `db:migrate`, no production or shared-environment contact).
- Runtime behavior while the table is absent: the production authority
  bridge (`api/lib/optimisation-governance/optimisation-governance-bridge.ts`)
  probes `information_schema` and fails closed with
  `ProviderAuthorityUnavailable` for governance-decision persistence/reads.
  Authority snapshots (business/budget/portfolio/experiment) derive from
  canonical pre-existing tables, so evaluation degrades gracefully until
  R7-X executes the artefact. Tests exercise the governance path
  exclusively through injected in-memory fakes.

## Schema delta introduced (artefact only)

1. **`optimisation_governance_decisions`** — immutable, insert-only
   governance decisions; deterministic `governanceDecisionId` (`ogd1:`);
   unique convergence anchors `(governanceDecisionId)` and
   `(userId, governanceDecisionId)`; secondary indexes on business, user,
   proposal, decision and evaluatedAt. Mirrors `policy_decisions`
   conventions (R5-E) with the R7-F decision record shape.
2. **`approval_requests.approvalType` enum extension** — adds
   `optimisation_action` (governed optimisation approvals bound to the exact
   decision + proposal fingerprint + policy version + financial impact +
   expiry). Same extension pattern as R6-D's accepted `sales_handoff`
   addition.

No existing table or column is modified otherwise. No foreign keys (repo
convention: enforcement in query predicates). Historical R6 `0034` is
untouched.
