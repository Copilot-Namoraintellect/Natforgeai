# R6-D UNEXECUTED MIGRATIONS — PROVISIONAL ARTEFACTS ONLY

> **Stream:** WBS-R6 Stream D — Nurture / Sales Handoff Autonomy
> **Branch:** `feature/r6-d-nurture-sales-handoff` (base `a947ecb`)
> **Date:** 2026-06-28

## Provisional stream-local migration identity

R6-D appends **one** provisional migration artefact set:

- `db/migrations/0034_nurture_sales_handoff_autonomy.sql`
- `db/migrations/meta/0034_snapshot.json`
- journal entry idx 34, tag `0034_nurture_sales_handoff_autonomy`

The artefact set was generated offline from `db/schema.ts` against the
accepted R5 chain tail (journal idx 33, `0033_opportunity_detection_foundation`)
via `drizzle-kit generate` (snapshot diffing only; a dummy local
`DATABASE_URL` placeholder was supplied because the config requires the
variable to exist — **no database was ever contacted**).

## Numbering collision — R6-X owns convergence

R6-A (`0034_lead_identity_foundation`), R6-B (`0034_lead_scoring_foundation`),
R6-C (`0034_lead_qualification_autonomy`), R6-E, and R6-F
(`0034_lead_privacy_governance`) each created their own provisional
`0034_*` artefact independently. **R6-D does not resolve this collision**:
no renumbering, no rewriting, no execution of any A/B/C/E/F artefact, and no
claim of canonical programme order. Local journal/snapshot parity was
verified for the D artefact only (journal idx 34 ⇄ `0034_snapshot.json` ⇄
SQL file; `prevId` chain intact from idx 33).

**Canonical sequencing, convergence, and execution authority belong to
R6-X.** Until then these artefacts are inert.

## Execution status

- Migration executed: **FALSE** (artefact created only; no `db:push`, no
  `db:migrate`, no production or shared-environment contact).
- Runtime behavior while tables are absent: every D store entry point is
  guarded by an `information_schema` check (same discipline as R5-F/R6-F
  bridges). Reads degrade to honest `unavailable`; writes fail closed with
  `NURTURE_SCHEMA_UNAVAILABLE`. Tests exercise D exclusively through
  injected in-memory executor fakes — no real database is touched.

## Tables introduced (artefact only)

- `nurture_handoff_decisions` — immutable governed decisions; unique
  `nurtureDecisionId` and `(userId, decisionKey)` convergence anchors;
  insert-only (contract §15).
- `sales_handoffs` — exact-once handoff identity; unique `handoffId` and
  `(userId, handoffKey)`; CAS `version`; closed lifecycle (contract §8).
- `handoff_dispatch_receipts` — append-only execution evidence; unique
  `executionIdentity` (contract §11).
- `nurture_touch_records` — append-only nurture touches; unique
  `(userId, touchIdentity)` (contract §7).

Plus one **additive** column-level change:

- `approval_requests.approvalType` gains the value `sales_handoff`
  (R5-E `marketing_action` precedent; additive enum extension only).

No FK constraints (repo convention: enforcement in query predicates).
