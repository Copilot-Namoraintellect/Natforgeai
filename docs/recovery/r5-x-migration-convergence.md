# R5-X4 Canonical Migration / Schema Convergence

> **Date:** 2026-06-13
> **Base:** `e4493a8` (R4 authority — journal ended at `0028`, 29 entries idx 0–28)
> **Branch:** `integration/r5-marketing-operations`
> **Status:** CONVERGED — canonical linear chain built, drift-clean, **no migration executed**.

## 1. Provisional collision (as landed by the isolated streams)

Every R5 stream appended exactly one migration on top of `0028`, but the
numbers/indexes collided because the streams were developed in isolation:

| Stream | Provisional file | Journal idx/tag | Snapshot file | Defect |
|--------|------------------|-----------------|---------------|--------|
| A | `0029_social_listening_foundation.sql` | 29 / `0029_social_listening_foundation` | `0029_snapshot.json` | number collision (×3 at 0029) |
| B | `0029_add_social_interpretations.sql` | 29 / `0029_add_social_interpretations` | `0029_snapshot.json` | number collision |
| E | `0029_sad_donald_blake.sql` | 29 / `0029_sad_donald_blake` | `0029_snapshot.json` | number collision |
| C | `0030_engagement_execution_foundation.sql` | **29** / `0030_engagement_execution_foundation` | `0029_snapshot.json` | journal idx ≠ file number; wrong snapshot name |
| D | `0030_opportunity_detection_foundation.sql` | 30 / `0030_opportunity_detection_foundation` | `0030_snapshot.json` | idx gap at 29 |
| F | — none — | — | — | F added no migration/schema change |

`db/schema.ts` was touched by A, B, C, D, E (each added its own tables; no
same-table edit conflicts). F touched neither.

## 2. Canonical linear chain (final)

Regenerated with `drizzle-kit generate` at each dependency-ordered merge step
(A → B → E → C → D), so snapshots and `prevId` chaining are tool-correct
rather than hand-edited. Each canonical migration is one stream's delta,
captured against the cumulative previous snapshot:

| Canonical migration | Source (stream) | Supersedes provisional | Contents (deltas) |
|---------------------|-----------------|--------------------------|-------------------|
| `0029_social_listening_foundation` | A | A `0029_social_listening_foundation.sql` | CREATE `social_listening_states`, `social_signals` (+ their secondary indexes, see note) |
| `0030_social_interpretations` | B | B `0029_add_social_interpretations.sql` | CREATE `social_interpretations`; ALTER `agent_runs.agentType` + `ai_usage.agentType` (add `interpretation`); interpretation + listening indexes |
| `0031_policy_foundation` | E | E `0029_sad_donald_blake.sql` | CREATE `business_policies`, `policy_decisions`; ALTER `approval_requests.approvalType` (add `marketing_action`) |
| `0032_engagement_execution_foundation` | C | C `0030_engagement_execution_foundation.sql` | CREATE `engagement_executions`, `engagement_receipts`, `engagement_response_contents` |
| `0033_opportunity_detection_foundation` | D | D `0030_opportunity_detection_foundation.sql` | CREATE `opportunity_candidates`, `opportunity_evidence`, `opportunity_handoffs`, `opportunity_suppressions` |

**Provenance notes**

- Every R5 schema change is present **exactly once**; nothing was dropped.
  Cross-check: the union of the five streams' provisional SQL statements
  (tables + alters + indexes) is identical to the union of the five canonical
  files' statements.
- A's provisional SQL omitted the secondary indexes declared in A's
  `db/schema.ts` (`sls_user_idx`, `ss_user_observed_idx`,
  `ss_integration_occurred_idx`, `ss_campaign_idx`). Regenerating from the
  integrated schema restores them; they are emitted in `0030` (the first
  canonical step whose snapshot diff could see them). Final cumulative state
  is identical to schema — verified by drift check below.
- B's provisional SQL included the two `agentType` enum widens — correctly
  attributed to B's delta (`0030`), since B's `schema.ts` made those edits.
- C's provisional journal idx (29 with a `0030` tag) and D's idx gap are
  normalized to sequential idx 29–33 with matching file numbers.
- The provisional `0029_snapshot.json` (four competing versions) and
  `0030_snapshot.json` (two competing versions) are **discarded**; canonical
  snapshots are regenerated and chain by `prevId`.

## 3. Verification evidence

| Check | Result |
|-------|--------|
| No duplicate migration numbers | PASS — files numbered 0029–0033 uniquely |
| No duplicate journal indexes | PASS — `_journal.json` idx 0–33 sequential (34 entries, no gaps/dups) |
| No lost schema change | PASS — union of provisional deltas == union of canonical deltas |
| Correct snapshot chaining | PASS — every `NNNN_snapshot.json.prevId` == previous snapshot `id` (tool-verified 0000→0033) |
| Schema ↔ final snapshot parity | PASS — `drizzle-kit generate` reports **"No schema changes, nothing to migrate"** against `0033` |
| `drizzle-kit check` | PASS — **"Everything's fine"** (journal/snapshot consistency) |
| Migrations executed | **NONE** — only offline `generate`/`check` were run; no `push`/`migrate`; no database was contacted (`generate`/`check` run offline) |

## 4. Pre-existing base gaps (NOT R5 regressions)

`db/migrations/meta/` at base `e4493a8` already lacked snapshots for journal
entries 2 (`0002_hardening_sprint`), 21 (`0021_narrow_loners`) and 22
(`0022_engagement_inbound_crash_recovery`). These are historical R4-repo gaps,
unchanged by R5, and are **out of R5 scope** (R5 made them neither better nor
worse). They do not affect the R5 chain (0029–0033), which is complete and
intact. Recorded here so the acceptance report is truthful about repository
state.

## 5. Exact final unexecuted production migrations

Execute in order, after the R4 chain (through `0028`) has run:

1. `db/migrations/0029_social_listening_foundation.sql`
2. `db/migrations/0030_social_interpretations.sql`
3. `db/migrations/0031_policy_foundation.sql`
4. `db/migrations/0032_engagement_execution_foundation.sql`
5. `db/migrations/0033_opportunity_detection_foundation.sql`

All five are **unexecuted** as of this report. Deployment prerequisite: run
`drizzle-kit migrate` (or the deployment pipeline's migration step) against the
target database — a deployment action that R5-X explicitly does **not**
perform.
