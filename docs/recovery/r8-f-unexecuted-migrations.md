# R8-F UNEXECUTED MIGRATIONS — PROVISIONAL ARTEFACTS ONLY

> **Stream:** WBS-R8 Stream F — Strategic Intelligence Governance
> **Branch:** `feature/r8-f-strategic-governance` (base `a2c084a1`)
> **Date:** 2026-11-10

## Provisional stream-local migration identity

R8-F appends **one** provisional migration artefact set:

- `db/migrations/0036_r8_f_strategic_governance_foundation.sql`
- `db/migrations/meta/0036_snapshot.json`
- journal entry idx 36, tag `0036_r8_f_strategic_governance_foundation`

Contents (schema diff only — no drift):

- `CREATE TABLE strategic_governance_decisions` — durable, immutable
  strategic-governance decisions (deterministic `sgd1:` convergence anchor,
  server-derived trust/confidence/risk columns, approval binding JSON,
  threshold snapshot; no raw recommendation text or secrets).
- `ALTER TABLE approval_requests MODIFY COLUMN approvalType` — additive enum
  extension `strategic_recommendation` (same accepted-but-unexecuted pattern
  as R7-F's `optimisation_action`).

## Numbering

R8-F appends after the canonical R7 `0035`
(`0035_r7_business_optimisation_foundation`, R7-X converged). idx 36 was the
next free programme slot at authoring time. **R8-F does not resolve sibling
numbering**: no renumbering, no rewriting, no execution of any sibling
artefact, and no claim of canonical programme order. If a sibling R8 stream
claims `0036` first, **R8-X owns renumbering/convergence**.

R7's `0035` artefact was **never modified** by R8-F.

## Execution status

**MIGRATION_EXECUTION = FALSE.** These artefacts are inert:

- not executed against any database;
- `npm run db:migrate` / `db:push` were NOT run;
- production untouched.

The production bridge degrades guarded-fail-closed: the
`strategic_governance_decisions` table probe reports absent until the
migration is executed under R8-X authority; strategic evidence resolution
fails closed (`EVIDENCE_AUTHORITY_UNAVAILABLE`) until R8-X binds canonical
evidence stores. **Canonical sequencing, convergence, and execution authority
belong to R8-X.**
