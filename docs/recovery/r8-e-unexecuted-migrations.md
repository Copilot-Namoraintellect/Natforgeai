# R8-E Unexecuted Migrations — Recovery Note

> **Stream:** R8-E Strategic Opportunity & Risk Intelligence
> (`feature/r8-e-strategic-opportunity-risk`)
> **Date:** 2026-11-10
> **Status:** artefact only — `MIGRATION_EXECUTION=False`.

## Provisional artefact

`db/migrations/0036_r8_e_strategic_opportunity_risk_foundation.sql`

Three stream-local tables:

| Table | Purpose |
|---|---|
| `strategic_opportunity_risk_candidates` | Immutable candidate rows (sor1: identity, convergence anchor `(userId, candidateId)`, fingerprint-bound material core, CAS `version`) |
| `strategic_opportunity_risk_relations` | Deterministic overlap/portfolio relations (lineage only, never score inputs) |
| `strategic_opportunity_risk_lifecycle_events` | Append-only sorl1: lifecycle facts |

## Collision statement (do NOT converge here)

The programme base and sibling R8 streams each carry their own stream-local
provisional 0036 artefact:

- R8-A strategic memory, R8-B business change, R8-C market external signals,
  R8-D strategic reasoning (`0036_r8_d_strategic_reasoning_foundation.sql`),
  R8-F strategic governance — **all provisional, none executed**.

The 0036 journal name collides across streams **by design**. R8-X owns
canonical sequencing: it will rename/rebase these artefacts into a single
canonical 0036 (or a follow-on 0037) at convergence, resolving constraint and
index collisions. **This stream must not rename, execute, or converge any
0036 — including its own.**

## Housekeeping rules honoured

- `db/schema.ts` carries the matching drizzle definitions (canonical source
  of truth for the unexecuted tables), appended after the R7 tables; no R7
  (`0035…`) definitions were modified.
- No migration was executed against any database; `npm run db:push` /
  `db:migrate` were not invoked.
- R8-E reads **zero** upstream R8 tables at runtime on this branch: the R8-D
  read surface binds at R8-X through the registration port
  (`registerStrategicReasoningReadPort`); absent binding fails closed
  (`UNKNOWN_REASONING_REFERENCE` / `REASONING_AUTHORITY_UNAVAILABLE`
  semantics — see `strategic-opportunity-risk-reasoning-seam.ts`).
