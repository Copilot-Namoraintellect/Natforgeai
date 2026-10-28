# R7-B Attribution Intelligence — Acceptance Report

> **Stream:** WBS-R7-B (Attribution Intelligence)
> **Verdict target:** `ATTRIBUTION_INTELLIGENCE_READY`
> **Required principle:** *association is not causation.* Every attribution
> surface distinguishes observed association, eligible contribution,
> allocated credit, and causal evidence. Credit is never causal proof.

## IDENTITY

```
branch=feature/r7-b-attribution-intelligence
HEAD=<final-commit-after-report>
remote=origin (https://github.com/Copilot-Namoraintellect/Natforgeai.git)
working_tree=clean (only this report + AGENTS.md §21 doc change at report time)
programme_base=8030e97adc9fe8e6bf1cc3a93a8a66da56025a46 (verified: HEAD == base at start; merge-base == base)
```

## UPSTREAM

```
r6_head=8030e97adc9fe8e6bf1cc3a93a8a66da56025a46
r7_a_head=3e8aea8b4367da599bb8a28887c156c7241eae9c (consumed by branch ref only — NOT merged, NOT imported)
r7_a_contract_compatibility=PASS (49-case acceptance suite block: exact frozen
  conversion-outcome/v1 28-key allowlist, verbatim disclaimers, canonical shape
  accepted; version drift / extra / missing / causal-claim / paraphrased /
  malformed identities / bad hashes / bad timestamps all fail closed with
  ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH)
```

R7-A tables (`business_outcomes`) are not materialised on this branch; the
outcome consumption seam reads behind a guarded information-schema existence
check and fail-closed degrades to "no outcome" when absent. R7-B never
imports or merges R7-A code.

## B0 — AUTHORITY / JOURNEY INVENTORY

`docs/recovery/r7-b-attribution-inventory.md` — full inventory of R7-A
(frozen), R6-E/A/B/C/D/F, R5-D/C/A, R4 campaign/publication authorities,
timestamps, ids, audit/event infrastructure, schema/migrations. Deterministic
linkage map (12 link classes L1–L12), gap register (8 gaps G1–G8), and a
fail-closed vs lower-confidence ambiguity table.

```
B0=PASS
```

## B1 — ATTRIBUTION CONTRACT

`docs/contracts/attribution-intelligence-contract.md` — versioned
(`attribution/v1`): attributionId/businessId/outcomeId/leadId/modelType/
modelVersion/windowStart/windowEnd/touchpoints[]/totalCredit/confidenceClass/
evidenceClass/calculatedAt/sourceVersions/supersedesAttributionId; touchpoint
representation with stable identity + type (CAMPAIGN, PUBLICATION, ENGAGEMENT,
OPPORTUNITY, NURTURE_TOUCH, SALES_HANDOFF — all repository-evidence-backed),
each carrying business/tenant scope, occurredAt, provenance, eligibility,
credit; closed vocabularies, deterministic identity, exact-once anchors,
lifecycle/supersession, security invariants.

```
B1=PASS
```

## B2 — ELIGIBLE JOURNEY RECONSTRUCTION

`api/lib/attribution/attribution-journey.ts` (pure) +
`attribution-journey-store.ts` (tenant-scoped gathering). Same canonical lead
via the score-mediated chain only (lead_score_snapshots → lead_qualifications),
same tenant (every query userId-predicated), same business scope
(null-or-equal house convention), bounded window, authoritative epoch-ms
ordering with deterministic tie-breaks, closed event types, no fuzzy person
matching, no cross-lead/cross-business stitching, no inferred events.
Duplicates collapse (TOUCHPOINT_DUPLICATE), stale/outside-window/
after-outcome/future-dated/malformed-timestamp candidates excluded with
closed reason codes, malformed lineage excluded (never repaired); a malformed
outcome timestamp fails the whole evaluation closed.

```
B2=PASS
```

## B3 — ATTRIBUTION MODELS

Closed, versioned, deterministic, reproducible, bounded, tested, explicit
about assumptions; no LLM in the path; weights are model-version constants.

```
MODELS_IMPLEMENTED=FIRST_TOUCH, LAST_TOUCH, LINEAR, POSITION_BASED, TIME_DECAY
B3=PASS
```

## B4 — CREDIT ALLOCATION

Integer basis points only; total normalised exactly to 100000 (100.000%) via
deterministic largest-remainder with stable (occurredAt, type,
sourceIdentity) tie-breaks; no over-allocation, no negative credit, no float
drift. Outcome monetary value is a read-only reference; no new revenue, no
netting, no mutation of outcome amount/currency.

```
B4=PASS
```

## B5 — CONFIDENCE / EVIDENCE CLASSIFICATION

Closed taxonomy: DIRECT_LINKAGE, STRONG_ASSOCIATION, WEAK_ASSOCIATION,
INSUFFICIENT_EVIDENCE; confidence HIGH/MEDIUM/LOW/NONE is a deterministic
mapping from evidence quality (outcome verification state, chronology
completeness, timestamp authority, lineage stability, touchpoint
cardinality) — never model opinion, never translated into causal proof.

```
B5=PASS
```

## B6 — ATTRIBUTION LIFECYCLE / REVISION

Results immutable (record-hash tamper detection fails closed on read).
Outcome verification/reversal, new authoritative evidence, model/policy/
window change ⇒ new supersession-linked result + immutable
`attribution_lifecycle_events` fact; prior results preserved for audit.
Reversed/cancelled/superseded outcomes fail closed for new evaluations and
`synchronize` retires active credit with a zero-credit successor — a reversed
outcome never retains misleading active positive attribution.

```
B6=PASS
```

## B7 — SECURITY / TENANT / AGENT BOUNDARIES

Server-derived/revalidated business context; outcome ownership through the
frozen R7-A seam; canonical lead ownership through the score-mediated chain;
touchpoint ownership re-verified; contract versions enforced
(ATTRIBUTION_UPSTREAM_CONTRACT_MISMATCH); no cross-tenant reconstruction;
strict zod boundary + explicit client-authority guard reject every
client-supplied authority/causal/weight field
(ATTRIBUTION_CLIENT_AUTHORITY_FIELD_FORBIDDEN); runtime agents cannot
fabricate touchpoints/credit, alter outcomes/identities/timestamps/policy,
mark causation proven, or reach persistence around the boundary. Prompt
injection cannot alter model or weights (closed enums, strict objects).
R6-F privacy stop states (SUPPRESSED/RESTRICTED/RETENTION_EXPIRED) hard-stop
evaluation (ATTRIBUTION_PRIVACY_BLOCKED).

```
B7=PASS
```

## B8 — DOWNSTREAM LEARNING PROJECTION

`docs/contracts/attribution-to-business-learning-contract.md` +
`api/lib/attribution/attribution-projection.ts` — frozen
`attribution-to-learning/v1` projection (25-key allowlist asserted exact in
acceptance): attribution/outcome ids, outcome type/status snapshot,
touchpoint set + allocated credit, model/version, confidence/evidence class,
lineage/provenance, calculation time, verbatim causation disclaimer
(`causationClaimed: false`, `attributionClaimed: true`). R7-C must not mutate
attribution; attribution credit is not causal proof; confidence and model
assumptions must be preserved.

```
B8=PASS
```

## B9 — CONNECTED ACCEPTANCE

`api/attribution-acceptance.test.ts` — 49 connected cases (34 required +
frozen R7-A compatibility block) over the REAL service/stores/pure modules
against an in-memory fake DB replicating the durable unique anchors, with a
fake R7-A authority serving canonical frozen-shape projections. All 34
required cases proven: (1) verified outcome attributed; (2) provisional
outcome policy-capped; (3) reversed outcome fail-closed + zero-credit
supersession; (4) unknown outcome rejected; (5) cross-business rejected;
(6/7) wrong-lead excluded/never stitched; (8) cross-tenant rejected; (9)
after-outcome excluded; (10) future-dated excluded; (11) outside-window
excluded; (12) duplicate dedup; (13) malformed timestamps safe; (14–18) all
five models deterministic; (19/20) exact normalisation / no over-allocation;
(21/22) replay determinism + convergence; (23) conflicting replay fails
closed; (24) model change ⇒ new attribution; (25) new evidence supersedes
without mutation; (26) low-quality journey lower/insufficient class; (27/28)
agent cannot fabricate touchpoint/credit; (29/30) client cannot mark
causation / injection cannot alter model-weights; (31) outcome value
read-only; (32) R7-C projection immutable + exact; (33) no upstream mutation;
(34) no provider/payment/billing action.

```
B9=PASS (49/49)
```

## TESTING

```
targeted=PASS (api/attribution-acceptance.test.ts 49/49)
affected_regressions=PASS (audit 32/32 incl. extended taxonomy; conversion
  suite 135/135; opportunity 626/626 across R5-D/C/A + publish; R6
  lead-identity/scoring/qualification/nurture/governance/harness 539/539)
full_suite=6456 passed / 4 failed / 66 skipped / 14 todo (6540 total, 407
  files). All 4 failures classified PRE-EXISTING with evidence — each
  reproduces identically on the untouched programme base 8030e97 in an
  isolated worktree:
  1. db/__tests__/lead-qualification-schema.test.ts — source-format assertion
     (expects multi-line mysqlTable formatting; R6-X file is single-line).
     Fails on base identically. Untouched by R7-B.
  2. src/pages/Campaigns.test.tsx — FirebaseError auth/invalid-api-key
     (test-env Firebase config absent). Fails on base identically.
  3. api/lib/billing/credit-engine.test.ts — env-dependent dbName assertion
     (env.databaseUrl unset in the offline test env). Fails on base.
  4. api/lib/creative/creative-generation-claim.test.ts — same env-dependent
     dbName assertion. Fails on base.
  Zero regressions attributable to R7-B; no R7-B or upstream-authority test
  weakened or skipped.
typescript=PASS (tsc -b clean)
build=PASS (vite + esbuild api bundle + deployment verification)
diff_check=PASS (git diff --check clean across the branch)
secret_scan=PASS (no credentials/secrets in branch diff; grep hits were
  pre-existing schema column names in the migration snapshot JSON only)
```

## SCHEMA

```
schema_changed=true
provisional_migration=0035_r7_b_attribution_foundation (attribution_results,
  attribution_lifecycle_events; journal idx 35 + 0035_snapshot.json generated
  offline with a dummy DATABASE_URL — no database connection opened)
migration_execution=False
collision_note=R7-A's branch carries its own provisional 0035 (business_
  outcomes). Both derive from the R6 base 0034; R7-X owns canonical R7
  sequencing/convergence. R7-B did not merge, renumber, or duplicate R7-A's
  artefact. Documented in docs/recovery/r7-b-unexecuted-migrations.md.
```

## SECURITY VERDICTS

```
SECURITY_VERDICT=PASS
ATTRIBUTION_INTEGRITY_VERDICT=PASS (deterministic identity + record-hash
  tamper detection + exact-once anchors; conflicting replay fails closed)
TENANT_ISOLATION_VERDICT=PASS (tenant inside every identity hash; every read
  userId-predicated; cross-tenant touchpoints unreachable — acceptance-proven)
JOURNEY_INTEGRITY_VERDICT=PASS (chronology from authoritative timestamps only;
  no fabricated/inferred/stitched events; malformed lineage excluded)
CREDIT_INTEGRITY_VERDICT=PASS (integer bps, exact 100000 normalisation,
  deterministic rounding; no client/agent weights; no over-allocation)
AGENT_ISOLATION_VERDICT=PASS (model/agent output reaches persistence only
  through the strict boundary; no SQL/shell/tool access from the attribution
  path; no self-permission change possible)
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS (no free text enters the authority
  path; closed enums + strict objects reject injection-shaped input —
  acceptance-proven)
TOOL_LEAST_PRIVILEGE_VERDICT=PASS (attribution code performs DB reads on
  upstream tables and writes only R7-B tables + fingerprint-deduped audit)
CROSS_AGENT_TRUST_VERDICT=PASS (no cross-agent trust surface; every authority
  is server-derived and independently revalidated)
SELF_MODIFICATION_GUARD_VERDICT=PASS (no permission/persistence-path mutation
  primitives exposed)
SECRET_ISOLATION_VERDICT=PASS (no secrets read, logged, or persisted; safe
  audit metadata — ids/closed labels/classes/hashes only)
PRIVILEGE_ESCALATION_FOUND=NONE
ROGUE_AGENT_BLAST_RADIUS=CONTAINED (a compromised runtime agent can at most
  submit well-formed evaluate/synchronize requests; it cannot fabricate
  journey history, allocate arbitrary credit, or convert association into
  causal authority — READY-blocking powers are absent by construction)
UNRESOLVED_AGENT_SECURITY_DEBT=NONE known within R7-B scope (real-MySQL
  concurrency execution remains a programme-level deferral owned by R7-X/R10,
  same as R6)
```

## EXTERNAL LIMITATIONS

- R7-A tables are not materialised on this branch (stream-local provisional
  artefacts by design); attribution evaluation requires a readable outcome —
  without R7-X convergence the runtime fail-closed degrades to "unavailable",
  never fabricated. Exercised in tests via injected frozen-shape fakes.
- Publication touchpoints are admitted only via receipt-resolvable numeric
  queue identity; fragmented varchar publication identity across streams is
  documented as gap G2 and never re-resolved (lower confidence by design).
- TIME_DECAY discretizes at whole-day granularity (documented model-version
  assumption; deterministic, monotone, integer-exact).
- Real-MySQL concurrency execution is deferred to R7-X/R10 pre-production
  acceptance (durable anchors structurally verified; deterministic
  convergence proven in harness).

## FINAL VERDICT

```
ATTRIBUTION_INTELLIGENCE_READY
```

Ready conditions verified: no untrusted client/model/agent can fabricate
journey history (B2 + acceptance 6–8, 27), allocate arbitrary credit (B3/B4 +
acceptance 19/20/28), or turn association into causal authority (B1/B5/B8 +
acceptance 29/30/32). No upstream authority mutates (acceptance 33). No
production/provider/payment/billing action occurs (acceptance 34).
MIGRATION_EXECUTION=False. No deployment performed.
