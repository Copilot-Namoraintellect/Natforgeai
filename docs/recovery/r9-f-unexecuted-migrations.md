# R9-F UNEXECUTED MIGRATIONS — PROVISIONAL ARTEFACTS ONLY

> **Stream:** WBS-R9 Stream F — Mission Governance & Approval
> **Branch:** `feature/r9-f-mission-governance` (programme base `4fc43c3b`)
> **Date:** 2026-11-10

## Provisional stream-local migration identity

R9-F appends **one** provisional migration artefact set:

- `db/migrations/0037_r9_f_mission_governance_foundation.sql`
- `db/migrations/meta/0037_snapshot.json`
- journal entry idx 37, tag `0037_r9_f_mission_governance_foundation`

Contents (schema diff only — no drift):

- `CREATE TABLE mission_governance_decisions` — durable, immutable
  mission-governance receipts (deterministic `mgd1:` convergence anchor,
  exact subject/action coordinates, server-derived mission risk column +
  risk-factor snapshot, approval binding JSON, threshold snapshot; raw
  action params are **never** stored — only their fingerprint).
- `ALTER TABLE approval_requests MODIFY COLUMN approvalType` — additive enum
  extension `mission_action` (same accepted-but-unexecuted pattern as R7-F's
  `optimisation_action` and R8-F's `strategic_recommendation`).

## Numbering

R9-F appends after the canonical R8 `0036`
(`0036_r8_strategic_intelligence_foundation`, R8-X converged; journal idx 36).
idx 37 was the next free programme slot at authoring time. **R9-F does not
resolve sibling numbering**: no renumbering, no rewriting, no execution of
any sibling artefact, and no claim of canonical programme order. If a sibling
R9 stream claims `0037` first, **R9-X owns renumbering/convergence**.

R8's `0036` artefact was **never modified** by R9-F.

## Execution status

**MIGRATION_EXECUTION = FALSE.** These artefacts are inert:

- not executed against any database;
- not applied via `db:push` / `db:migrate`;
- the runtime guards every R9-F read behind a guarded information-schema
  probe and fails closed (`ProviderAuthorityUnavailable`) while the table is
  absent — mirroring the R7/R8 provisional-migration discipline;
- tests run against the in-memory fake, never a live schema.

## Rollup expectation (R9-X)

At R9-X convergence, sibling R9 provisional artefacts (including this one)
are verified for coverage and re-issued as the canonical `0037` programme
migration; stream-local artefacts are then retired. The canonical
`approval_requests` enum extension is unioned once. Until then, this
artefact is the authoritative statement of R9-F schema intent.
