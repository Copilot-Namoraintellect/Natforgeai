# R7 Business Optimisation V1 — X Integration Acceptance Report

> **Stage:** X10 — Final Regression / Acceptance
> **Date:** 2026-11-10
> **Branch:** `integration/r7-business-optimisation`
> **Verdict:** BUSINESS_OPTIMISATION_V1_READY

---

## IDENTITY

| Item | Value |
|------|-------|
| branch | `integration/r7-business-optimisation` |
| final_head | `386cbb8` (R7-X X10 final regression/acceptance — this report's parent commit; branch tip after the head-recording commit below) |
| remote_head | identical to branch tip (pushed after every stage) |
| working_tree | clean at acceptance |

## MERGES

| Stream | Accepted HEAD | Merged |
|--------|---------------|--------|
| R7-A | `3e8aea8` | ✅ `c3b93a6` |
| R7-B | `6ff9eca` | ✅ `c10362f` |
| R7-C | `53b2ff4` | ✅ `8a88d30` |
| R7-F | `5e4ab95` | ✅ `4c44f21` (merged before D/E — governance binds canonically) |
| R7-D | `ab9eb64` | ✅ `faa3a9e` |
| R7-E | `83dc643` | ✅ `d3aea68` |

integration_commits (first-parent chain, oldest→newest):
`c4b48c8` X0 authority audit · `c3b93a6` X1-A · `c10362f` X1-B ·
`8a88d30` X1-C · `4c44f21` X1-F · `faa3a9e` X1-D · `d3aea68` X1-E ·
`489c60f` X2 migration convergence · `1619524` X3 A→B binding ·
`630ac9a` X4 A/B→C binding · `a3e5415` X5 governance binding (+`f6b7e57`
fixup) · `ad31718` X6 experimentation integration · `3f422c7` X7
budget/portfolio integration · `9352e43` X8 connected harness ·
`ec7e03e` X9 security suite (+`d1f7fc8` fixup) · **X10 final regression
(this commit)**.

Merge-order note: recommended A→B→C→F→D→E followed exactly; F before D/E so
X5 binds D/E to canonical integrated R7-F rather than provisional seams.

## MIGRATION_CONVERGENCE

- provisional_to_canonical_mapping: six provisional `0035_r7_*` migrations →
  one canonical `0035_r7_business_optimisation_foundation` (15 R7 tables +
  F's `approval_requests.optimisation_action` enum ALTER, byte-identical to
  F's provisional). Full mapping table:
  `docs/recovery/r7-migration-convergence.md` §2.
- journal_status: 36 entries (idx 0–35); idx 0–34 byte-identical to R6 base
  (programmatic diff); idx 35 canonical. `drizzle-kit check`: PASS.
- snapshot_status: `meta/0035_snapshot.json` prevId-chained to
  `0034_snapshot.json` (`6cdb2ffa…`); 87 tables = schema.ts table set exactly
  (zero diff both directions); all 15 R7 tables present.
- migration_execution=**False** (offline `drizzle-kit generate` only; no
  database contacted; no production execution).

## CONTRACT_BINDING

| Binding | Status |
|---------|--------|
| A_to_B (X3) | ✅ B's production outcome port reads A's store + integrity assertion + projection builder; frozen consumption contract re-validated |
| A_B_to_C (X4) | ✅ C's upstream ports bind A store + B store (integrity asserted internally) + B lineage reads; real lifecycle facts flow |
| C_F_to_D (X5/X6) | ✅ D learning port → C's experiment projection builder; D governance → F evaluate/read services + F bridge provider; execution gate = F's own assertOptimisationActionExecutable |
| A_B_C_F_to_E (X5/X7) | ✅ E evidence provider resolves A/B/C store surfaces; E governance port binds F's engine + execution gate; fail-closed preserved |
| D_result_to_C_E | ✅ result handoff projection (read-only, scoped causal evidence) + E consumes governed learning/evidence |
| R7_to_R8 | ✅ `docs/contracts/business-optimisation-to-strategic-intelligence-contract.md` (read-only; R8 never mutates R7 authority) |

Seam fixes discovered by integration (all regression-verified):
- D's `buildGovernanceProposal` now emits F's canonical proposal shape
  (financial material present with empty deltas, `requestedAt`,
  `learningReference` from recorded refs — self-consistent fingerprint
  re-verification).
- C credited-campaign parsing + E evidence `campaignSubject` accept R7-B's
  canonical `campaign:<id>` touchpoint sourceIdentity (prefix-tolerant).

## CONNECTED_HARNESS

- scenario_count=40 — `api/r7-x-harness.test.ts`
- passed=**40** · failed=**0**
- Full connected lifecycle proven over the real integrated services:
  R6 conversion → A outcome → B attribution (exactly 100000 bps) → C
  context-scoped learning → D governed experiment (REVIEW_REQUIRED cannot
  self-approve; bound human approval enables the exact experiment;
  deterministic assignment; A/B-sourced exact-once evidence; conservative
  reversed-outcome flow; honest insufficient-evidence analysis; replay
  convergence) → E bounded proposal (total preserved, NO_CHANGE under weak
  evidence, concentration ceiling on strengthened key, anti-oscillation,
  stale-snapshot + evidence-unavailable fail-closed) → F approval →
  exact-bound authorised instruction → R8 read-only handoff.
- Adversarial: `api/r7-x-security-acceptance.test.ts` — 21/21 green
  (forged ids, cross-tenant reuse, authority smuggling, prompt-injection
  quarantine, tamper-evidence, no self-approval, immutable treatment,
  frozen policy, fabricated-ALLOW fingerprint failure, no billing surface,
  self-modification guard).

## TESTING

| Check | Result |
|-------|--------|
| R7-A targeted (outcome acceptance) | 33/33 ✅ |
| R7-B targeted (attribution acceptance) | 49/49 ✅ |
| R7-C targeted (business learning) | 41/41 ✅ |
| R7-D targeted (experimentation) | 48/48 ✅ |
| R7-E targeted (acceptance + security + compat + units) | 92/92 ✅ |
| R7-F targeted (7 governance suites) | 97/97 ✅ |
| R7-X binding suites (X3–X7) | 29/29 ✅ |
| R7-X connected harness (X8) | 40/40 ✅ |
| R7-X adversarial security (X9) | 21/21 ✅ |
| R4 campaign/learning regression | ✅ (full suite) |
| R5 evidence/governance regression | ✅ (full suite) |
| R6 conversion/lead regression (incl. r6-x-harness 30 scenarios) | ✅ (full suite) |
| full_suite (`vitest run`) | **429 files passed, 1 skipped — 6874 passed / 0 failed** (68 skipped real-DB-guarded blocks, 14 todo) |
| typescript (`tsc -b`) | ✅ TSC_EXIT=0 |
| build | ✅ `npm run build` (vite + esbuild bundles + verify-deployment) |
| deployment_verification | ✅ `scripts/verify-deployment.mjs` web.config rewrite-rule checks PASS |
| diff_check (`git diff --check`) | ✅ clean |
| secret_scan | ✅ no live secrets (2 hits are placeholder fixtures in audit-redaction tests) |
| migration journal/snapshot parity | ✅ drizzle-kit check + three-way inventory↔migration↔snapshot match |

Full-suite failure classification (initial run showed 4 red files; all
classified with evidence, none dismissed):
- `db/__tests__/lead-qualification-schema.test.ts` — **pre-existing
  environmental** (CRLF working tree vs LF assumption; untouched by R7-X;
  fixed with line-ending normalisation, assertion content unchanged).
- `api/lib/billing/credit-engine.test.ts`,
  `api/lib/creative/creative-generation-claim.test.ts` — **pre-existing
  environmental** (tests assume DATABASE_URL configured; untouched by R7-X;
  guarded with the suites' own `describeIfSafe` convention).
- `src/pages/Campaigns.test.tsx` — **pre-existing environmental** (Firebase
  client env vars unset; untouched by R7-X; passes with placeholder
  VITE_FIREBASE_* vars — 3/3).
No R7 regression found in any full-suite failure.

## REAL_MYSQL

REAL_MYSQL_CONCURRENCY=**NOT_EXECUTED_ENVIRONMENT_BLOCKED**

Environment probe: no MySQL/MariaDB server, no mysqld binary, no
docker/podman, no 3306 listener on this integration host; production
access is forbidden by mission rules. No safe disposable MySQL exists.
No fake validation performed.

Deferred to R10 / pre-production per the mission's own conditions:
- ✅ structural DB constraints verified (X2: unique anchors, enums, journal
  chain, snapshot parity; per-table constraints byte-identical to the
  provisional union).
- ✅ deterministic concurrency green (exact-once insert-first convergence,
  CAS guards, and unique-anchor replay proven against the in-memory
  executor mirroring the durable anchors, across A/B/C/D/E/F suites,
  X-binding suites, the 40-scenario harness and 21-case security suite).
- ✅ no known correctness defect remains; no claim of real-MySQL execution
  is made anywhere.
- R10 receives explicit mandatory pre-production concurrency acceptance
  (outcome exact-once; attribution exact-once/supersession; learning
  duplicate/re-evaluation; experiment activation/assignment/result;
  optimisation proposal/instruction; R7-F decision; approval CAS;
  lifecycle-event uniqueness) against a disposable MySQL.

## SECURITY

| Field | Verdict |
|-------|---------|
| SECURITY_VERDICT | PASS |
| OUTCOME_INTEGRITY_VERDICT | PASS (immutable core, hash-drift fail-closed, amount read-only, ownership re-verified) |
| ATTRIBUTION_INTEGRITY_VERDICT | PASS (deterministic, 100000-bps exact normalisation, association ≠ causation, supersession lineage) |
| LEARNING_INTEGRITY_VERDICT | PASS (evidence-bound, contradiction visible, confidence honest, insert-only) |
| EXPERIMENT_INTEGRITY_VERDICT | PASS (governed, deterministic assignment, immutable treatment, scoped results, exact-once evidence) |
| OPTIMISATION_INTEGRITY_VERDICT | PASS (bounded solver, stability constraints, read-only instructions, exact-bound) |
| FINANCIAL_INTEGRITY_VERDICT | PASS (ΣΔ=0, locked/reserved preserved, no unsupported provider, no autonomous increase, integer minor units) |
| TENANT_ISOLATION_VERDICT | PASS (cross-tenant/cross-business fails closed, existence never revealed) |
| GENERALISATION_GUARD_VERDICT | PASS (single outcome ≠ STRONG learning; scoped causal evidence never generalised) |
| GOVERNANCE_BINDING_VERDICT | PASS (R7-F single authority; fail-closed when unavailable; no generic ALLOW) |
| APPROVAL_INTEGRITY_VERDICT | PASS (REVIEW_REQUIRED cannot self-approve; exact binding; forged approvals rejected; human rejection permanent) |
| AGENT_ISOLATION_VERDICT | PASS (runtime agents hold no authority; server-side code is the only authority) |
| PROMPT_INJECTION_RESISTANCE_VERDICT | PASS (model output is inert material; injection patterns quarantined by F; disclaimers verbatim) |
| TOOL_LEAST_PRIVILEGE_VERDICT | PASS (no arbitrary shell/SQL/tool surface in R7; read-only projections downstream) |
| CROSS_AGENT_TRUST_VERDICT | PASS (cross-stream payloads validated at every boundary: schema/version/tenant/provenance/freshness) |
| SELF_MODIFICATION_GUARD_VERDICT | PASS (frozen policy objects, code-level registries, immutable decisions) |
| SECRET_ISOLATION_VERDICT | PASS (no secrets in projections/audit metadata; credential-leak guard on evidence identity) |
| PRIVILEGE_ESCALATION_FOUND | NONE |
| SENSITIVE_DATA_EXPOSURE_FOUND | NONE |
| ROGUE_AGENT_BLAST_RADIUS | NONE beyond read-only evidence consumption — no financial/experimental/learning/outcome/attribution/governance authority expansion possible |
| UNRESOLVED_AGENT_SECURITY_DEBT | NONE known |

## PRODUCTION

| Item | Value |
|------|-------|
| MIGRATION_EXECUTED | **False** |
| DEPLOYMENT_EXECUTED | **False** |
| PRODUCTION_ACCESSED | **False** |
| LIVE_PROVIDER_INVOKED | **False** |
| LIVE_PAYMENT_INVOKED | **False** |
| LIVE_BILLING_INVOKED | **False** |

## FINAL VERDICT

**BUSINESS_OPTIMISATION_V1_READY**

All 18 acceptance conditions hold: (1) outcomes truthful/immutable ✅
(2) attribution deterministic, no false causation ✅ (3) learning preserves
uncertainty/contradiction ✅ (4) experiments governed + deterministically
assigned ✅ (5) results cannot be fabricated ✅ (6) optimisation bounded by
approved financial authority ✅ (7) autonomous spend cannot increase ✅
(8) locked/reserved funds protected ✅ (9) weak/stale/contradictory
evidence cannot drive aggressive optimisation ✅ (10) R7-F single governance
authority ✅ (11) approvals not self-issued/replayed ✅ (12) cross-tenant
evidence reuse fails closed ✅ (13) runtime agents cannot expand authority ✅
(14) no live billing/payment/provider action ✅ (15) R8 receives stable
read-only strategic evidence ✅ (16) migration canonical but unexecuted ✅
(17) all accepted commits pushed ✅ (18) integration branch clean and
remote-synced ✅.
