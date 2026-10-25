# R6-C UNEXECUTED MIGRATIONS — PROVISIONAL ARTEFACTS ONLY

> **Stream:** WBS-R6 Stream C — Lead Qualification Autonomy
> **Branch:** `feature/r6-c-lead-qualification` (base `a947ecb`)
> **Date:** 2026-06-28

## Provisional stream-local migration identity

R6-C appends **one** provisional migration artefact set:

- `db/migrations/0034_lead_qualification_autonomy.sql`
- `db/migrations/meta/0034_snapshot.json`
- journal entry idx 34, tag `0034_lead_qualification_autonomy`

## Numbering collision — R6-X owns convergence

R6-A (`0034_nostalgic_mephisto` / `0034_lead_identity_foundation`),
R6-B (`0034_lead_scoring_foundation`), R6-E, and R6-F
(`0034_lead_privacy_governance`) each created their own provisional
`0034_*` artefact independently. **R6-C does not resolve this collision**:
no renumbering, no rewriting, no execution of any A/B/E/F artefact, and no
claim of canonical programme order. Local journal/snapshot parity was
verified for the C artefact only (generated from `db/schema.ts` against the
accepted R5 chain tail, idx 33 `0033_opportunity_detection_foundation`).

**Canonical sequencing, convergence, and execution authority belong to
R6-X.** Until then these artefacts are inert.

## Execution status

- Migration executed: **FALSE** (artefact created only; no `db:push`, no
  `db:migrate`, no production or shared-environment contact).
- Runtime behavior while tables are absent: the production authority bridge
  (`api/lib/qualification/qualification-bridge.ts`) detects the missing
  tables via a guarded `information_schema` check and fails closed with
  `QUALIFICATION_AUTHORITY_UNAVAILABLE`. Tests exercise the qualification
  path exclusively through injected in-memory fakes.

## Tables introduced (artefact only)

- `lead_qualifications` — immutable qualification decisions; unique
  `(userId, qualificationId)` convergence anchor; insert-only.
- `lead_qualification_reviews` — durable manual-review records bound to the
  exact decision (`decisionBindingHash`), CAS `version`; unique
  `(userId, reviewId)` and `(userId, qualificationId)`.

No FK constraints (repo convention: enforcement in query predicates).
