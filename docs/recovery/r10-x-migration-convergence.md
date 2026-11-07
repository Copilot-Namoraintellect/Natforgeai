# R10-X canonical migration reconciliation — offline only

Baseline: `c41cd564692717f6edc78ae581e01f9afab6125c`, branch
`integration/r10-cross-stream`. No database or production service was contacted.
No migration, backup, restore, provider, worker, scheduler or activation was run.

## Canonical package

| Journal index | Canonical SQL | Tables | Snapshot |
|---|---|---:|---|
| 38 | `0038_r10_c_runtime_resilience.sql` | 5 | `meta/0038_snapshot.json` |
| 39 | `0039_r10_d_provider_resilience.sql` | 5 | `meta/0039_snapshot.json` |
| 40 | `0040_r10_e_observability_operations.sql` | 5 | `meta/0040_snapshot.json` |
| 41 | `0041_r10_h_autonomy_activation.sql` | 3 | `meta/0041_snapshot.json` |

All 18 tables have schema declarations and explicit primary keys. The package
contains 269 columns, 27 named unique constraints and 28 non-unique indexes,
with no foreign keys, data seeds, UPDATEs, DELETEs or activation statements.
Each SQL file has a unique canonical tag, one journal entry and one snapshot.
The journal now has 42 entries. Original entries 0–37 remain structurally identical.

The [table comparison](r10-x-migration-table-comparison.md) lists every table,
primary key, unique constraint and index with ordered column membership.
The [machine-readable inventory](r10-x-migration-reconciliation-inventory.json)
contains every column's type, nullability, default and auto-increment flag,
plus preservation hashes for all 83 historical SQL/snapshot artifacts checked.
Hashes normalize checkout CRLF to Git LF; none of those historical files was
rewritten. Existing historical gaps/names are preserved, not renumbered.

## Generation and metadata provenance

`scripts/reconcile-r10-migrations.mjs --write` generated this package with the
installed Drizzle Kit **0.31.10** API, not by relabeling provisional SQL.
It uses `generateMySQLDrizzleJson` to serialize actual Drizzle declarations and
`generateMySQLMigration` to emit each group's CREATE statements from an empty
MySQL schema model. The actual serializer issues UUIDs and MySQL snapshot v5;
snapshots link through `prevId` from preserved 0037 to 0038 → 0039 → 0040 → 0041.
The existing journal format (v7, mysql, per-entry v5, monotonic timestamp,
breakpoints) is retained. Timestamps describe artifact creation, not execution.

Snapshots are cumulative: R9+C, then +D, then +E, then +H. Every snapshot is
compared to a fresh serializer result, ignoring only its newly generated UUID.
New SQL is independently compared to the actual differ output. No metadata
objects or identities are invented by hand. The generator is deliberately
single-use on a journal ending at 37; validation is the repeatable operation.

No `drizzle.config.ts` or dotenv is loaded. No DATABASE_URL is supplied or read.
The schema loader permits only its declaration dependency `drizzle-orm/mysql-core`.
Only the serializer and SQL differ API functions are invoked; no push, migrate,
introspection, database client or studio API is called.

## Provisional evidence and reconciliation differences

The four original `0038_r10_*` sources are preserved in
`db/migrations/archived/r10-provisional/`, outside the journal/executable root,
with their original basenames and contents. Validation checks each against its
Git baseline blob. This follows the repository's archived-artifact convention
and R9-X's separation of retired provisional evidence from canonical execution.
The C basename is reused only for its new canonical generated SQL; its original
provisional is independently preserved in the archive.

- C: same columns, types, nullability, keys and indexes. `CURRENT_TIMESTAMP`
  becomes Drizzle's equivalent `(now())`; inline primary keys become named keys.
- D: no semantic differences; generator formatting and ordering only.
- E: all five provisional tables used `serial AUTO_INCREMENT NOT NULL` without
  an explicit primary key. MySQL SERIAL implies uniqueness, not PRIMARY KEY.
  Canonical SQL adds the five explicit `id` primary keys declared by the schema.
  Types, defaults, unique anchors and non-unique indexes otherwise match.
- H: three missing Drizzle table declarations were added. All scope keys remain
  `varchar(512) CHARACTER SET ascii COLLATE ascii_bin`; action IDs remain binary
  ASCII varchar(120), versions are unsigned BIGINT, state/audit values are JSON.
  PKs remain scope; scope+version; scope+action. Named versus unnamed PK syntax
  is equivalent. No database default or seed can activate autonomy.

## Frozen R9 snapshot discrepancy — explicit inherited limitation

The R9 report describes a schema-consistent snapshot, but actual preserved
`0037_snapshot.json` contains only 101 pre-R9 tables: it omits all 17 tables
created by SQL 0037 and the `approval_requests.approvalType` `mission_action`
extension. Snapshot 0038 catches that metadata up from actual declarations;
SQL 0038 does **not** recreate those R9 tables or repeat the enum ALTER.
All 101 existing snapshot tables are compared against declarations; only the
already-owned approval enum extension is allowed to differ.

Comparing frozen R9 SQL to current declarations also reveals two pre-existing
differences, explicitly asserted by the validator:

1. `mission_schedules.version`: schema default `1`, but SQL 0037 has no default.
2. `mission_governance_decisions`: SQL uses `mgd_decision_id_uidx` and
   `mgd_user_decision_uidx`; declarations use corresponding `*_idx` names.
   Uniqueness and ordered member columns are identical.

`tinyint(1)` versus `boolean` is normalized as an equivalent MySQL alias.
No unexpected R9 divergence is accepted. R9 SQL, entries and snapshots remain
unchanged; R10 emits no R9 repair ALTER. Thus new metadata matches declarations,
while these historical SQL/schema differences remain documented debt. This
package must not be represented as evidence of a live database's schema or as
repair of that debt. Live migration rehearsal and production acceptance remain
outstanding and require separate authorization.

## Disabled-by-default proof

Canonical files contain CREATE statements only. All three H tables start empty.
The existing repository returns `disabled(scope)` when no activation row exists;
that constructor sets configured/effective levels and runtime state to DISABLED,
with UNCONFIGURED authority. The new schema gives state JSON and version no
activation-enabling defaults. Autonomy runtime, permissions and authority code
are unchanged.

## Offline validation

Commands use installed dependencies and require no environment credentials:

```text
node --test scripts/r10-migration-reconciliation.test.mjs
node scripts/validate-r10-migrations.mjs
node scripts/r10-b/migration-rehearsal.mjs --static
node node_modules/drizzle-kit/bin.cjs check --dialect=mysql --out=./db/migrations
vitest run api/lib/runtime-resilience api/lib/provider-resilience api/lib/observability api/lib/autonomy --configLoader runner
tsc db/schema.ts --noEmit --skipLibCheck --moduleResolution bundler --module esnext --target es2022 --types node --pretty false
tsc -b --pretty false
git diff --check
```

- Reconciliation/negative tests: **14 passed**.
- Full static reconciliation: **PASS**, all 18 tables and four metadata steps.
- Existing R10-B static rehearsal: **PASS**, 42 journal entries, zero problems.
  Its static-only head guard now accepts exactly the four R10 successors while
  still checking canonical entry 37; live-mode logic is unchanged and not run.
- Drizzle metadata check: **PASS**, “Everything's fine”.
- C/D/E/H suites: **299 passed, 8 files**, including autonomy frozen compatibility.
- Focused schema TypeScript check: **PASS**.
- Repository-wide `tsc -b`: **FAILED (exit 2, 432 diagnostics)**, including
  missing sandbox-hidden modules and downstream type errors. No diagnostic
  names `db/schema.ts`. Full-project type acceptance remains outstanding in
  a checkout with complete filesystem access; no success is claimed here.
- `git diff --check`: **PASS** for the intentional paths; new text artifacts
  also checked for trailing whitespace. Node syntax checks: **PASS**.
- Git HEAD remains the published baseline, with no staged changes. There are
  25 intentional changed/new paths: schema, four canonical SQLs, four snapshots,
  journal, four archived provisionals (three former root paths retired), three
  report artifacts and five scripts including the static-rehearsal adjustment.
  `AGENTS.md.merge-conflict-backup` remains untouched and untracked.
  The 121 known sandbox visibility artifacts remain apparent API deletions;
  none were staged, deleted, restored or treated as migration changes.

Verdict: canonical R10 artifacts reconciled offline; no database execution or
production acceptance implied. No commit, push, deployment or PR was performed.
