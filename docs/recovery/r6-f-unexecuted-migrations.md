# R6-F UNEXECUTED MIGRATIONS

> **Stream:** R6-F Lead Governance / Operations
> **Branch:** `feature/r6-f-lead-governance`
> **Date:** 2026-06-28
> **Status:** artefacts created and journal/snapshot parity verified — **NOT executed**

---

## 0034_lead_privacy_governance

| | |
|---|---|
| Artefact | `db/migrations/0034_lead_privacy_governance.sql` |
| Snapshot | `db/migrations/meta/0034_snapshot.json` (prevId chain: `0033` → `0034`) |
| Journal | `db/migrations/meta/_journal.json` idx 34 |
| Table | `lead_privacy_states` |
| Executed | **FALSE** — no `db:push`, no `db:migrate`, no production access |

**Purpose:** durable, F-owned home for per-lead operational privacy state
(`ACTIVE | SUPPRESSED | RESTRICTED | RETENTION_PENDING | RETENTION_EXPIRED |
ARCHIVED`) with provenance (`source`, `actorUserId`, `previousState`,
`reason`) and a `retentionDeadlineAt` schedule. One current state per lead
(`lps_lead_uidx` unique on `leadId`).

**Pre-migration runtime behaviour:** all F runtime code bridges this table
behind a guarded `information_schema` check (same pattern as the R5-F
stream-evidence bridge). Until the migration executes:
- the projection reports the privacy area as `available: false` /
  `supported: false` (never guessed, never an error);
- governance mutations (`setPrivacyState`, retention sweep) **fail closed**
  with an honest migration-pending error;
- leads behave exactly as before (no privacy overlay).

**Execution authority:** R6-X convergence owns canonical sequencing and
execution. F executes nothing, deploys nothing, and touches no production
system.

**Drift note:** snapshot hand-built to drizzle-kit output conventions from
the 0033 baseline (60 tables, chain intact, parity verified programmatically).
R6-X should re-verify drift-cleanliness with `drizzle-kit generate` /
`db:push --dry-run` when a toolchain is available before executing.
