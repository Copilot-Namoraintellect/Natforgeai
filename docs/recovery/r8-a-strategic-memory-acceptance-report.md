# R8-A STRATEGIC MEMORY — ACCEPTANCE REPORT

> **Stream:** WBS-R8-A Strategic Memory
> **Branch:** `feature/r8-a-strategic-memory`
> **Programme base:** `a2c084a1f0bca110a00e51f83632733789cec5f7` (unchanged)
> **Frozen upstream:** R7 Business Optimisation V1 (`integration/r7-business-optimisation`,
> accepted HEAD `a2c084a1…`, verdict `BUSINESS_OPTIMISATION_V1_READY`)
> **Handoff contract consumed:** `docs/contracts/business-optimisation-to-strategic-intelligence-contract.md`
> **Status:** A0–A9 complete; acceptance suite green.

---

## IDENTITY

```
branch=feature/r8-a-strategic-memory
HEAD=549a5a2… (549a5a2… on origin/feature/r8-a-strategic-memory, pushed)
remote=https://github.com/Copilot-Namoraintellect/Natforgeai.git
working_tree=clean
```

Commit chain (atomic slices, each pushed immediately):

| Slice | Commit | Content |
|---|---|---|
| A0 | `48968a9` | authority/memory inventory |
| A1 | `fb972e2` | strategic-memory contract (`strategic-memory/v1`) |
| A2–A8 | `84004f3` | lib (contract/identity/temporal/store/seam/service/projection), router, schema, provisional 0036, audit types, downstream contract |
| A9 | `cd34cd5` | 36-case connected acceptance suite + AGENTS.md §26 |
| fix | `549a5a2` | audit taxonomy expectation extended (R8-A event types) |

Git governance honoured: no branch switches, no sibling-R8/integration
merges, no resets/clean/stash, no force push, no history rewrite.

## A0 — AUTHORITY / MEMORY INVENTORY = COMPLETE

`docs/recovery/r8-a-strategic-memory-inventory.md`. Findings: **no**
pre-existing strategic/campaign memory, Business-DNA-fact or long-term
business-context authority exists; the capability is net-new. Business DNA
(`business_dna_snapshots`), strategy snapshots, campaigns and all R7 tables
( outcomes, attribution, learning, experiments, portfolio, governance — frozen
`0035`, not executed) were inventoried as reference-only authorities. R8-A
duplicates none of them.

## A1 — STRATEGIC MEMORY CONTRACT = COMPLETE

`docs/contracts/strategic-memory-contract.md`, version `strategic-memory/v1`.
All mandated fields defined with closed vocabularies: memoryId, businessId,
memoryType (9 closed types — `RISK_POSTURE`/`CAPABILITY_STATE` deliberately not
adopted, contract §3.1), subjectType/subjectId, statementType (FACT |
ASSUMPTION), factStatus (6 closed), evidenceRefs, sourceAuthority (9 closed),
sourceVersion (frozen per source), confidenceClass (5 closed, server-derived),
validFrom/validUntil/observedAt/recordedAt, supersedesMemoryId,
contradictsMemoryIds, contextScope (closed server-derived shape), limitations,
plus evidenceHash/sourceFingerprint integrity binding.

## A2 — MEMORY IDENTITY / EVIDENCE BINDING = COMPLETE

`mem1:` = sha256(canonicalJson({v:1, tenantUserId, businessId,
sourceAuthority, sourceIdentity, memoryType, contextScope})). No fuzzy
matching; no client-selected authoritative ids; upstream rows are loaded and
re-verified server-side (tenant, business, frozen contractVersion,
integrity hashes where the upstream store asserts them). Rejection paths
implemented and tested: unknown source, cross-business, cross-tenant, stale
contract version, tamper-shaped material, missing provenance.

## A3 — FACT VS ASSUMPTION = COMPLETE

FACT mints only through governed ingestion; operator path is structurally
incapable of FACT (boundary rejection, case 12). ASSUMPTION requires basis
(closed basisType + summary), limitations, and validUntil (expiry/review).
Confidence is server-derived by the deterministic mapping (contract §5.3);
no promotion path exists (case 14). Model/client text cannot create FACT
(case 13); protected-trait material rejected (case 27).

## A4 — TEMPORAL / CURRENT-STATE MODEL = COMPLETE

Statuses CURRENT / STALE / SUPERSEDED / CONTRADICTED / EXPIRED / INVALIDATED
with deterministic precedence (contract §8). Born-expired records are
materialized EXPIRED at insert; sweepExpiry materializes later expirations
(insert-first + CAS, replay-convergent). `r8Projections` returns only CURRENT
memory as active; non-active records are queryable and labelled, never
silently active (cases 18, 19).

## A5 — CONTRADICTION / SUPERSESSION = COMPLETE

Append-only `smf1:` facts + CAS transitions; exact predecessor bindings;
history never deleted (rows immutable, evidenceHash-bound). Contradiction
remains visible in both directions (`contradictsMemoryIds` /
`contradictedByMemoryIds`, case 17). Same-subject refresh without explicit
lineage marks the prior memory STALE (visible, non-active). Cases 15, 16, 20.

## A6 — R7 STRATEGIC HANDOFF INGESTION = COMPLETE

Frozen seam (`strategic-memory-upstream-seam.ts`) consumes out1: (R7-A with
integrity assertion + verbatim disclaimers), atr1: (R7-B — association only),
lrn1: (R7-C — confidence/contradiction/novelty preserved), exp1:/exr1: (R7-D —
design-assumption limitations preserved), opt1: (R7-E via the frozen 23-key
strategy handoff), ogd1: (R7-F — governance bound incl. validUntil travels
verbatim), plus governed business_dna and strategy_snapshot derivations.
Upstream supersession chains and invalidations (reversal, attribution
supersession, contradicted learning) re-evaluate dependent memory via
insert-first lifecycle facts (cases 21, 22, 23). R7 evidence is never
strengthened: attribution stays association, provisional stays provisional
(case 2, 4). No R7/upstream table is ever written (cases 31, 33–35).

## A7 — SECURITY / TENANT / AGENT BOUNDARIES = COMPLETE

Session-anchored tenant isolation with durable-row re-verification on every
call; client-authority smuggling fails closed; no delete/force-state/promote
paths exist on the surface; prompt-injected text is stored verbatim as
untrusted content only (case 28); agents cannot erase history, raise
confidence, alter Business DNA, or touch billing/providers (cases 29–31,
36). Protected-trait rejection is policy-enforced (case 27).

## A8 — DOWNSTREAM PROJECTION = COMPLETE

`docs/contracts/strategic-memory-to-reasoning-contract.md`
(`strategic-memory-to-reasoning/v1`, exact 30-key allowlist asserted in case
32). Read-only; downstream mutation is impossible through the surface.

## A9 — CONNECTED ACCEPTANCE = COMPLETE (36/36)

`api/strategic-memory-acceptance.test.ts` — REAL conversion + outcome routers,
hand-verified R7-B/C/D fixtures (deterministic hashes, REAL stores), REAL
strategic-memory router/service/store/seam over an in-memory fake DB
replicating the durable unique indexes. All 36 mandated cases pass:

| # | Case | # | Case |
|---|---|---|---|
| 1 | R7 outcome → memory | 19 | stale marked correctly |
| 2 | attribution = association | 20 | changed objective supersedes |
| 3 | verified learning → pattern | 21 | R7 reversal invalidates dependents |
| 4 | provisional stays provisional | 22 | attribution supersession re-evals |
| 5 | unknown source rejected | 23 | learning contradiction re-evals |
| 6 | cross-business rejected | 24 | experiment limitations preserved |
| 7 | cross-tenant rejected | 25 | optimisation bounded by governance |
| 8 | stale version rejected | 26 | no cross-context overgeneralisation |
| 9 | deterministic identity | 27 | protected trait rejected |
| 10 | duplicate ingest converges | 28 | prompt injection resisted |
| 11 | conflicting replay fails closed | 29 | history cannot be erased |
| 12 | FACT needs authority | 30 | confidence cannot be raised |
| 13 | model text cannot create FACT | 31 | Business DNA unaltered |
| 14 | no assumption→fact promotion | 32 | projection read-only + exact keys |
| 15 | supersession preserves history | 33 | no strategy mutation |
| 16 | contradiction preserves both | 34 | no budget mutation |
| 17 | contradiction visible | 35 | no experiment activation |
| 18 | expired excluded from active | 36 | no provider/payment/billing action |

Coverage note (honest): the r7_budget_portfolio ingest path reuses the frozen
R7-E handoff builder and is compile-verified with the R7-X harness green; the
36-case fixture budget covered case 25 through the R7-F governance source
rather than a full R7-E proposal fixture. Deferred to R8-X connected
hardening: real-MySQL concurrency execution (house-standard deferral, same as
R6/R7).

## TESTING

```
targeted            = 36/36 PASS (api/strategic-memory-acceptance.test.ts)
affected_regressions= 308/308 PASS
                      (audit-event 20, audit-store, business-dna ×3,
                       strategy-snapshot ×3, outcome-acceptance,
                       attribution-acceptance, business-learning-acceptance,
                       experimentation-acceptance, r7-x-harness,
                       r7-f-acceptance, admin-audit-ledger)
typescript          = tsc -b CLEAN
build               = npm run build PASS (vite + esbuild boot/worker +
                      deployment verification)
diff_check          = git diff --check CLEAN (every slice)
secret_pii_scan     = clean (no secrets/PII in changed files)
full_suite          = 431 files / 6989 tests: 6903 passed, 68 skipped,
                      14 todo. Final state after the 549a5a2 fix: the only
                      remaining failures are pre-existing and unrelated to
                      this diff (zero changed files in src/, campaign-router,
                      workflow between base a2c084a and HEAD):
                      - src/pages/Campaigns.test.tsx: auth/invalid-api-key
                        (Firebase env absent in test environment)
                      - api/campaign-router.test.ts (2) and
                        api/lib/workflow/__tests__/r4-x6-full-autonomy-e2e.test.ts:
                        pass in isolation; load-flake under full parallel
                        suite run
```

Environment note: Node.js was not installed on the workstation; a portable
Node v22.17.0 was provisioned at `C:\c\Users\27768\tools\node` (outside the
repository) solely to execute the verification commands. No repo changes
depend on it.

## SCHEMA

```
schema_changed       = true (db/schema.ts: strategic_memory_records +
                       strategic_memory_lifecycle_events, additive only)
provisional_migration= 0036_r8_a_strategic_memory_foundation (artefact only)
migration_execution  = False
```

R7's `0035_r7_business_optimisation_foundation` is untouched; no meta snapshot
generated; R8-X owns canonical convergence
(`docs/recovery/r8-a-unexecuted-migrations.md`).

## SECURITY

```
SECURITY_VERDICT                        = PASS
STRATEGIC_MEMORY_INTEGRITY_VERDICT      = PASS (immutable hash-bound core;
                                          deterministic reproducible identity;
                                          conflicting replay fails closed)
TENANT_ISOLATION_VERDICT                = PASS (session-anchored, durable-row
                                          re-verified; cross-tenant/cross-
                                          business evidence fails closed)
EVIDENCE_INTEGRITY_VERDICT              = PASS (source fingerprints + upstream
                                          integrity assertions; disclaimers
                                          verbatim; no truth strengthening)
TEMPORAL_INTEGRITY_VERDICT              = PASS (expired/stale/superseded never
                                          silently active; sweep replay-safe)
CONTRADICTION_INTEGRITY_VERDICT         = PASS (both records preserved; visible
                                          in both directions; no model
                                          suppression path)
AGENT_ISOLATION_VERDICT                 = PASS (no delete/force/promote paths;
                                          no shell/SQL/tool/secrets surface)
PROMPT_INJECTION_RESISTANCE_VERDICT     = PASS (injection text stored as
                                          untrusted content; authority fields
                                          rejected; case 28)
TOOL_LEAST_PRIVILEGE_VERDICT            = PASS (read-only upstream seam; no
                                          execution procedures)
CROSS_AGENT_TRUST_VERDICT               = PASS (no trust delegation; single
                                          authority, reference-only upstream)
SELF_MODIFICATION_GUARD_VERDICT         = PASS (no permission/role/policy
                                          mutation surface)
SECRET_ISOLATION_VERDICT                = PASS (no secret access; scan clean)
PRIVILEGE_ESCALATION_FOUND              = none
ROGUE_AGENT_BLAST_RADIUS                = contained to insert-only memory rows
                                          within the authenticated tenant —
                                          no spend, experiments, campaigns,
                                          strategy, billing, or upstream
                                          authority reachable
UNRESOLVED_AGENT_SECURITY_DEBT          = none known (R8-X real-MySQL
                                          concurrency execution deferred by
                                          programme convention)
```

READY criterion check: no untrusted actor can fabricate strategic truth
(FACT requires server-loaded authority), erase contradiction/history (no
mutation/delete paths; immutable rows), or create downstream execution
authority (no execution fields/procedures anywhere in the stream).

## FINAL VERDICT

```
STRATEGIC_MEMORY_READY
```

No deployment performed. No migrations executed. No production access. No
live provider/payment/billing systems invoked.
