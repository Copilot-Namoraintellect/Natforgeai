# R6-A UNEXECUTED MIGRATIONS — RECOVERY NOTE

> **Stream:** WBS-R6 Stream A — Lead Identity & Identity Resolution
> **Branch:** `feature/r6-a-lead-identity`
> **Status:** artefacts created, **NOT executed** (deliberate)

## Provisional migration

| Migration | Tables | State |
|---|---|---|
| `0034_nostalgic_mephisto` | `lead_identities`, `lead_identity_provenance`, `lead_identity_merges` | artefact + snapshot + journal entry created; **never executed against any database** |

## Rules honored

- Continues the canonical chain after the accepted R5 base (journal idx 33,
  `0033_opportunity_detection_foundation`). No historical R5 artefact was
  renumbered, edited, or duplicated.
- Journal/snapshot parity verified: `db/migrations/meta/_journal.json` gained
  exactly one entry (idx 34); `db/migrations/meta/0034_snapshot.json` matches
  the generated SQL.
- **Migration execution = FALSE.** No `db:push`, no `db:migrate`, no
  production access. R6-X owns final convergence and canonical sequencing.
- Tables are R6-owned with **no FK constraints** coupling to R5 tables
  (repo convention: enforcement in query predicates).

## Local-dev note

`drizzle-kit generate` was run fully offline with a placeholder
`DATABASE_URL` (config validation only; no connection is opened during
generation). No real credentials were read or used.
