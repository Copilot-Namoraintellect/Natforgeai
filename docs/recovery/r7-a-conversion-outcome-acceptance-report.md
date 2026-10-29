# R7-A Conversion Outcome Intelligence — Final Acceptance Report

> **Stream:** WBS-R7-A — Conversion Outcome Intelligence
> **Branch:** `feature/r7-a-conversion-outcome-intelligence`
> **Programme base:** `8030e97adc9fe8e6bf1cc3a93a8a66da56025a46`
> **Frozen upstream:** R6 Lead Autonomy V1 (`integration/r6-lead-autonomy`,
> accepted HEAD `8030e97a…`, `LEAD_AUTONOMY_V1_READY`) — consumed, not merged.
> No sibling R7 branches merged. No migrations executed. No production access.
> No live payment/billing/provider invocation.

---

## IDENTITY

```
branch=feature/r7-a-conversion-outcome-intelligence
HEAD=top commit of this branch (7521597 at push time — the commit that lands
     this report; verifiable via git log; a commit cannot embed its own hash)
remote=origin (https://github.com/Copilot-Namoraintellect/Natforgeai.git)
working_tree=clean (committed atomically per slice, pushed immediately)
```

## A0 — AUTHORITY / DOMAIN INVENTORY

`docs/recovery/r7-a-conversion-outcome-inventory.md` — completed before any
code edit. Inventoried R6-E conversion authority (contracts, tables, all eight
`api/lib/conversion/` modules), R6-A identity, R6-B/C/D/F context, R4
billing/payments, legacy analytics/KPI/learning monetary concepts, monetary
utilities, audit taxonomy, router/service conventions, migration state
(canonical `0034_r6_lead_autonomy_foundation`, not executed), and provider
seams. Authority collisions resolved explicitly: conversion authority (R6-E),
business outcome authority (R7-A, new `business_outcome*` namespace — verified
unused), billing/payment authority (R4), future attribution authority (R7-B).
No collisions found.

## A1 — CANONICAL OUTCOME CONTRACT

`docs/contracts/conversion-outcome-intelligence-contract.md` — versioned
(`conversion-outcome/v1`), closed vocabularies: 12 outcome types (positive /
reversal / non-monetary groups), 6 statuses (OBSERVED, PROVISIONAL, VERIFIED,
REVERSED, CANCELLED, SUPERSEDED), 2 value types, 8 metric units, 8 evidence
sources, 7 evidence authority classes, 6 lifecycle types. Addresses outcomeId,
businessId, leadId, conversionId, outcomeType, outcomeStatus, valueType,
amountMinor, currency, quantity/metricUnit, evidenceSource/Identity/Hash,
verification state (server-derived), occurredAt/recordedAt, and
reverses/renews/supersedes lineage.

## A2 — OUTCOME IDENTITY

`out1:` + sha256 over `{v, tenantUserId, businessId, conversionId,
evidenceSource, evidenceIdentity}` (`outcome-identity.ts`). Same business +
same canonical conversion + same authoritative evidence → same identity.
Pure function (no clock/randomness); retries and webhook replays converge.
No client-selected ids; `OUTCOME_CLIENT_AUTHORITY_FIELD_FORBIDDEN` guard runs
before schema parse. Tenant and business are bound inside the hash — cross-
tenant/cross-business evidence cannot collide or correlate.

## A3 — OUTCOME CLASSIFICATION

`outcome-classification.ts` — deterministic, rule-first; no model in the
authority path. Derivation map from the 14 R6-E conversion types (unknown →
fail closed); five governed proposal rules (reversals forced; non-monetary
events cannot be reclassified monetary; UPGRADE/DOWNGRADE refinements;
ambiguous offline outcomes narrowed by evidenced proposal). Model/agent output
is untrusted proposal subject to the same strict schema; low/ambiguous
evidence lands OBSERVED/PROVISIONAL; protected traits are not classifier
inputs and cannot be expressed in the schema.

## A4 — VALUE VERIFICATION

`outcome-value.ts` — integer minor units (bigint grammar shared with R6-E,
1e15 bound, no NaN/Infinity, no floating-point), closed 20-code ISO currency
(JPY exponent 0), positive/negative polarity by outcome family, non-monetary
quantity + closed metric unit with no fabricated currency, payment-credential
digit-run guard. R6-E conversion amounts are revalidated before use as
business value: equality cross-check against governed conversion authority
(conflicts fail closed `OUTCOME_VALUE_CONFLICT`); conversion metadata is never
trusted merely for containing a number.

## A5 — OUTCOME LIFECYCLE

`business_outcome_lifecycle_events` — append-only, no update path;
`outcome-lifecycle.ts` transition graph with fail-closed impossible-transition
rejection. Verification (OBSERVED/PROVISIONAL → VERIFIED, bound to
authoritative corroborating evidence), reversal/refund/cancellation
(references the original; reversal-of-reversal forbidden; partial reversal
keeps target VERIFIED with the fact recorded), renewal lineage (new positive
outcome; target unchanged with renewal fact), supersession (target SUPERSEDED,
history preserved). Current state derived from immutable events + CAS-guarded
status; history never overwritten.

## A6 — TENANT / SECURITY / PRIVACY

Session `userId` anchors every identity, predicate and hash. `businessId`
revalidated against the conversion's business; conversion-carried lead
re-verified from the durable leads row; lineage targets tenant+business
scoped; no client force-state; no arbitrary value/lifecycle mutation; no PII
columns. No billing/payment/CRM/lead/conversion writes anywhere in the
stream. Model/agent output treated as untrusted data everywhere.

## A7 — PERSISTENCE / CONCURRENCY

Two new tables (`business_outcomes`, `business_outcome_lifecycle_events`)
with durable unique anchors: `bo_outcome_id_uidx`, `bo_natural_key_uidx`,
`bole_event_id_uidx`, `bole_external_uidx` (NULLs distinct). Insert-first
convergence + optimistic CAS (`version`) + evidence-hash verification on every
read. Proven in the acceptance suite: duplicate create converges (case 5),
concurrent duplicate converges (case 6), conflicting replay fails closed
(case 7), reversal replay converges (case 17), lifecycle history immutable
(cases 19/20), supersession/reversal does not duplicate value (cases 18/20).
Real-MySQL concurrency execution deferred to R7-X/R10 (schema anchors
structurally verified; deterministic in-memory concurrency green) — no
real-DB evidence fabricated.

## A8 — DOWNSTREAM PROJECTION / HANDOFF

`outcome-projection.ts` — frozen 27-key `conversion-outcome/v1` read-only
projection for R7-B/R7-C. `docs/contracts/conversion-outcome-to-attribution-learning-contract.md`
states explicitly: **outcome evidence does not imply attribution or
causation**; projections carry verbatim causation + attribution disclaimers;
net-value computation is downstream-owned; all fields read-only.

## A9 — CONNECTED ACCEPTANCE

`api/outcome-acceptance.test.ts` — 33 adversarial cases over the REAL R6-E
conversion router AND REAL R7-A outcome router/service/store/projection,
connected end-to-end (canonical conversion ingest → business outcome record)
against an in-memory fake replicating the durable unique anchors. All 30
required cases proven plus renewal lineage, partial reversal, and
classification rules. Full mapping (case → requirement) is 1:1 with the
mission's A9 list 1–30.

## TESTS

```
targeted= api/outcome-acceptance.test.ts 33/33 green; api/conversion-acceptance.test.ts 30/30 green;
  api/lib/audit (2 files) 32/32 green; api/r6-x-harness 30/30; api/r6-x-security-acceptance 34/34;
  api/r6-x-review-acceptance 27/27 (R6 connected regressions 91/91)
affected_regressions= conversion (R6-E), audit taxonomy, R6-X connected harness/security/review,
  lead identity (R6-A) — all green
full_suite= npx vitest run → 6524 tests: 6441 passed, 3 failed, 66 skipped, 14 todo
  (407 files: 402 passed, 4 failed, 1 skipped). ALL 4 failures reproduce identically
  at the pristine programme base 8030e97a (verified in a detached worktree) — pre-existing,
  not R7-A-related:
  1. db/__tests__/lead-qualification-schema.test.ts (source-format assertion; fails at base)
  2. api/lib/billing/credit-engine.test.ts "reports the configured database name…" (env; fails at base)
  3. api/lib/creative/creative-generation-claim.test.ts same database-name guard (env; fails at base)
  4. src/pages/Campaigns.test.tsx file-level firebase auth/invalid-api-key (missing VITE_FIREBASE_* env; fails at base)
  A first full-suite pass also showed one r4-x6-full-autonomy-e2e beforeEach hook timeout (10s) that
  did not reproduce on re-run — slow-machine flake, unrelated to R7-A.
typescript= npx tsc -b → exit 0
build= npm run build → vite + esbuild bundle + deployment verification passed
diff_check= git diff --check → clean on every slice
```

## SCHEMA

```
schema_changed= true (append-only: business_outcomes + business_outcome_lifecycle_events in db/schema.ts)
provisional_migration= db/migrations/0035_r7_a_conversion_outcome_foundation.sql (+ meta journal idx 35 + snapshot)
migration_execution=False
```

R6 canonical `0034_r6_lead_autonomy_foundation` untouched. Delta documented in
`docs/recovery/r7-a-unexecuted-migrations.md`. Generated offline with a dummy
`DATABASE_URL` (no database connection opened). R7-X owns final convergence.

## SECURITY

```
SECURITY_VERDICT= PASS
OUTCOME_INTEGRITY_VERDICT= PASS (deterministic tenant-anchored identity; immutable core; hash-verified reads)
TENANT_ISOLATION_VERDICT= PASS (session userId anchors every hash/predicate; cross-tenant business/conversion/lead/lineage fail closed — cases 2/3/4)
VALUE_INTEGRITY_VERDICT= PASS (integer minor units; closed currency; polarity rules; conversion cross-check; no floating-point money — cases 8/9/10/12)
AGENT_ISOLATION_VERDICT= PASS (no agent write path; model output untrusted proposal only — cases 11/12/25/26)
PROMPT_INJECTION_RESISTANCE_VERDICT= PASS (injection-shaped evidence identity is inert data; attests at most PROVISIONAL — case 25)
TOOL_LEAST_PRIVILEGE_VERDICT= PASS (six procedures; no billing/payment/shell/SQL/provider surface — case 28)
CROSS_AGENT_TRUST_VERDICT= PASS (no trust of downstream or peer-stream state; R6 consumed read-only via contracts)
SELF_MODIFICATION_GUARD_VERDICT= PASS (no policy/security-control mutation surface)
SECRET_ISOLATION_VERDICT= PASS (no secret access; credential digit-run guard on evidence identities)
PRIVILEGE_ESCALATION_FOUND= none
ROGUE_AGENT_BLAST_RADIUS= contained to idempotent, tenant-scoped outcome rows; zero billing/lead/conversion/CRM impact
UNRESOLVED_AGENT_SECURITY_DEBT= none known
```

## EXTERNAL LIMITATIONS

- Real-MySQL execution (true row-level unique-key contention, transaction
  isolation) not exercised here — deferred to R7-X/R10 per programme rules;
  deterministic in-memory concurrency green. No real-DB evidence fabricated.
- No live provider/payment/billing system invoked (forbidden by programme).
- 4 pre-existing suite failures (3 tests + 1 firebase env file failure) and 1
  slow-machine hook-timeout flake reproduce identically at the pristine
  programme base; they are documented here truthfully and were not introduced
  or worsened by R7-A.

## FINAL VERDICT

```
CONVERSION_OUTCOME_INTELLIGENCE_READY
```

Basis: business value cannot be fabricated (cases 11/12/18/25/26), duplicated
(cases 5/6/18/20), cross-tenanted (cases 2/3/4), silently overwritten
(cases 7/19/20/23/27), or promoted to verified status by an untrusted
client/agent (cases 11/14/15/26). Exact-once persistence, immutable lifecycle,
read-only downstream projection, and no attribution claim are all proven by
the connected acceptance suite; targeted regressions, tsc, build, and
diff-check are green; the only full-suite failures pre-date this stream.
