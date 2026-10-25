# R6-B UNEXECUTED MIGRATIONS — LEAD SCORING (0034)

> **Stream:** WBS-R6 Stream B — Lead Scoring Autonomy
> **Branch:** `feature/r6-b-lead-scoring`
> **Rule:** migration artefacts are created for parity and review, then executed
> only by the deployment/integration authority. **R6-B does NOT execute
> migrations.** R6-X owns final convergence and canonical sequencing
> (consistent with `docs/recovery/r5-x-migration-convergence.md` and the R5-E
> precedent `docs/recovery/r5-e-unexecuted-migrations.md`).

## Provisional migration

| File | Journal idx | State | Contents |
|---|---|---|---|
| `db/migrations/0034_lead_scoring_foundation.sql` | 34 | **CREATED, NOT EXECUTED** | Single `CREATE TABLE lead_score_snapshots` (immutable R6-B score records; unique convergence key `(userId, leadId, evidenceSnapshotHash, scoringVersion)`; unique `leadScoreId`; `lss_` index prefix). No ALTERs; no changes to any existing table or to R5 artefacts 0029–0033. |

- Generated offline via `drizzle-kit generate --name lead_scoring_foundation`
  with a non-connecting placeholder DSN; no database was touched.
- Snapshot `db/migrations/meta/0034_snapshot.json` + `_journal.json` idx 34
  generated together; `drizzle-kit check` → "Everything's fine" (journal /
  snapshot / schema parity verified).
- **Migration execution = FALSE.** Do not execute, push, or renumber outside
  the R6-X convergence.
