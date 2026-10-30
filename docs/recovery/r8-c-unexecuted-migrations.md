# R8-C Unexecuted Migrations

> **Stream:** R8-C Market & External Signal Intelligence
> **Branch:** `feature/r8-c-market-external-signals`
> **Migration:** `db/migrations/0036_r8_c_market_external_signal_foundation.sql`
> **Status:** provisional, stream-local, **artefact only — NOT executed**
> (`MIGRATION_EXECUTION=False`)

## What was added

| Table | Purpose |
|---|---|
| `external_sources` | Tenant-scoped server-side registered-source registry (`src1:` identity; server-derived `registryClass`). |
| `external_signals` | Immutable market/external evidence rows (`xsig1:` identity; inert `claimText`; derived trust/freshness/relevance/corroboration classes; CAS `version`). |
| `external_signal_lifecycle_events` | Append-only `xsf1:` lifecycle facts (corroboration / contradiction / supersession / staleness / invalidation). |

The Drizzle schema definitions live in `db/schema.ts` (house convention: the
code schema is the authority the services build against; the SQL file is the
provisional migration artefact).

## Collision statement (R8-X owns convergence)

The R8 programme base (`a2c084a1…`) already ends at canonical, unexecuted
`0035_r7_business_optimisation_foundation`. Three stream-local provisional
`0036` migrations now exist:

- `0036_r8_a_strategic_memory_foundation` — R8-A (`feature/r8-a-strategic-memory` @ `23d0f22`)
- `0036_r8_f_strategic_governance_foundation` — R8-F (`feature/r8-f-strategic-governance` @ `44118e3`)
- `0036_r8_c_market_external_signal_foundation` — this stream

They are **not converged here** (mission: do NOT converge; do not modify R7's
`0035`; R8-X owns canonical sequencing). On convergence R8-X must:

1. Re-sequence the three `0036` artefacts into the canonical R8 chain
   (journal + snapshot regeneration via drizzle-kit against the merged
   schema);
2. Merge the disjoint table sets (no name collisions: `strategic_memory_*`,
   `strategic_governance_*`, `external_*`);
3. Reconcile any shared-table additions (none — R8-C adds only new tables and
   touches no existing table);
4. Execute once, on the integration environment, under R8-X governance.

## Verification performed (without executing)

- Table/column definitions in `db/schema.ts` type-check against the services
  (`tsc -b` clean in this branch's acceptance run).
- Natural unique anchors replicate the house exact-once pattern
  (`(userId, originKey)`, `(userId, sourceId, eventKey)`, unique `xsf1:` fact
  ids); the acceptance harness replicates them in its fake DB and proves
  convergence + conflict behaviour.
- No existing migration file, journal entry, or snapshot was modified.
- No DDL was run against any database.
