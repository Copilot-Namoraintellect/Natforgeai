# R5-E Unexecuted Migrations

> **Stream:** WBS-R5 Stream E (Policy / Safety / Cost Control)
> **Branch:** `feature/r5-e-policy-safety-cost`
> **Rule:** Migration artefacts are created for parity and review. They are
> **NOT executed** in this stream. No production or local database was
> touched by migration commands.

| Migration | Status | Contents |
|---|---|---|
| `db/migrations/0029_sad_donald_blake.sql` | **CREATED, NOT EXECUTED** | 1. New table `business_policies` (versioned typed policy authority per business; unique `(policyId, version)`; active pointer index). 2. New table `policy_decisions` (durable immutable policy decisions; unique `policyDecisionId`; unique `(actionRequestId, policyVersion)` convergence scope). 3. `approval_requests.approvalType` enum gains `marketing_action`. |

- Journal parity: `db/migrations/meta/_journal.json` idx 29 + snapshot
  `0029_snapshot.json` were generated together with the SQL (drizzle-kit
  generate, offline; no database connection was opened).
- Execution is deferred to the integration/deployment authority, per the
  R5-E operating rules ("do NOT execute migrations").
- Until executed, the policy runtime degrades gracefully: no policy rows ->
  `POLICY_MISSING` fail-closed decisions; decision persistence requires the
  table and is exercised in tests via injected fakes only.
