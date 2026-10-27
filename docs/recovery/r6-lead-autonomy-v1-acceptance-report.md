# R6-X — LEAD AUTONOMY V1 ACCEPTANCE REPORT

> **Date:** 2026-10-30
> **Authority:** Integration of frozen streams R6-A/B/C/D/E/F on
> `integration/r6-lead-autonomy`
> **Final verdict:** **LEAD_AUTONOMY_V1_READY** (conditional promotion:
> real-MySQL concurrency execution deferred to R10 — see X6)

---

## IDENTITY

| Item | Value |
|------|-------|
| Branch | `integration/r6-lead-autonomy` |
| Final HEAD | `e172b91` (X9 canonical-migration parity repair; report follows) |
| Remote HEAD | in sync with origin after every accepted commit |
| Working tree | clean at every commit boundary (`git diff --check` clean throughout) |
| Integration base | `a947ecba99696403679091f9ff64d0a577faf3da` (`MARKETING_OPERATIONS_V1_READY`) |

## MERGES

| Stream | Frozen head (verified = remote) | Merge commit |
|--------|--------------------------------|--------------|
| R6-A Lead Identity | `ded8f28` | `eef2faa` |
| R6-B Lead Scoring | `259dc88` | `9282bee` |
| R6-E Conversion Tracking | `d31270d` | `a9d863b` |
| R6-C Lead Qualification | `580700a` | `3de34c1` |
| R6-F Lead Governance | `c4932c6` | `b732949` |
| R6-D Nurture / Sales Handoff | `72831fe` | `a191cda` |

Sequence A→B→E→C→F→D as mandated; no deviation required (documented in the X0
audit). Integration/convergence commits: `bfbfd18` (X0 audit), X1 merges
above, `fb8bb53` (X2 convergence), `ef89fd0` (X3 binding), `f5d1448` +
`1bc6394` (X7/X4 harness), `3648ce5` (X5 + insert-shape repair), `e4fce50`
(X8), `ea48988` (R7 contract), `e172b91` (X9 parity repair). All pushed.

## MIGRATION CONVERGENCE

- **Provisional → canonical mapping:** all six stream-local provisional
  `0034_*` artefacts → one canonical `0034_r6_lead_autonomy_foundation`
  (full table in `docs/recovery/r6-migration-convergence.md`).
- **Journal:** 35 entries, idx contiguous 0–34; R5 entries byte-identical to
  base (programmatically verified).
- **Snapshot:** `0034_snapshot.json` prevId-chained from `0033`; 13/13 R6
  tables present; table/index/constraint sets identical to the provisional
  union (incl. D's accepted `approval_requests` ALTER, byte-identical).
- **Execution = FALSE.** No migration executed against any environment;
  generation was offline (`drizzle-kit generate`).

## CONTRACT CONVERGENCE

| Binding | Status |
|---------|--------|
| A → B | score-mediated identity binding; B seam converged (doc + deterministic version derivation; C allow-lists both version families) |
| A + B → C | `evaluateQualificationForLead(lid1, leadScoreId)` co-validates identity projection + score payload via derived content references + tenant/business scope — proven in the connected harness |
| A + C + F → D | D consumes the world through REAL production ports (C projection built by C's service; A rows as stored; F store; E rows; approval ledger); lid1→numeric resolved only through the accepted score-authoritative chain |
| A → E | conversion linkage via numeric leadId + identityVersion (score-compatible spine) |
| E → D | conversion stop condition proven (`NO_ACTION`/`CONVERSION_STOP`, durable `conversionStopped`) |
| A/B/C/D/E → F | `projectLeadOperations` reports truthful integrated state (suppression blocker verified) |
| R5-D → A | exact-once handoff consumption proven (replay + concurrent consumers converge; provenance `(userId, handoffId)` anchor) |
| R6 → R7 | `docs/contracts/lead-autonomy-to-business-optimisation-contract.md` |

**Integration defects found & repaired during X3/X5/X9** (all were genuine
frozen-stream drifts, fixed at the drifted seam without weakening any
accepted rule):
1. D's frozen `engineVersion` check rejected C's published
   `lead-qualification-engine/v1` → D now binds a closed allow-list to C's
   exported version constant (prefix looseness removed; rogue versions still
   fail closed).
2. D's `insertApprovalRequest` read the drizzle insert result as a bare
   object; production drizzle resolves `[ResultSetHeader, FieldPacket[]]` →
   now shape-tolerant (latent real-MySQL defect, found without production
   access).

## CONNECTED HARNESS

`api/r6-x-harness.test.ts` — full lifecycle over the REAL services (R5-D
pipeline → A intake → B scoring → C qualification via real bridge → D
nurture via real production ports + fake transport → E conversion → D stop →
F projection). **30 mandated scenarios: 30 passed** (+7 X5 review tests in
`api/r6-x-review-acceptance.test.ts`, +8 X4 identity-matrix cases, +17 X8
adversarial cases in `api/r6-x-security-acceptance.test.ts`).
**R6-X suite total: 61/61 green.**

## TESTING

| Suite | Result |
|-------|--------|
| R6-A targeted | 103 passed |
| R6-B targeted | 100 passed |
| R6-C targeted (offline config) | 302 passed |
| R6-D targeted | 185 passed |
| R6-E targeted | 62 passed |
| R6-F targeted | 159 passed |
| R6-X harness + X4 | 37 passed |
| R6-X X5 review authority | 7 passed |
| R6-X X8 security | 17 passed |
| Shared R5 regression suites | included in full suite (R5-D/R5-E/R5-F router suites all green) |
| **Full offline Vitest suite** | **6414 passed / 0 failed / 66 skipped / 14 todo (6494 total)** |
| `tsc -b` | exit 0 |
| Build (+ verify-deployment, build-only) | exit 0 |
| `git diff --check` | clean at every commit |
| Secret/PII scan of integration diff | clean (hits were negated security-test patterns; only RFC-2606 `@example.com` fixtures) |
| Migration journal/snapshot parity | verified (§Migration Convergence) |

**Full-suite failure classification:** one failure observed on the first X9
full run — `db/__tests__/lead-qualification-schema.test.ts` read the deleted
provisional `0034_lead_qualification_autonomy.sql`. Classified **R6
integration regression from X2** (the provisional artefacts X2 was mandated
to retire); repaired by repointing the parity assertions at the canonical
migration (anchors unchanged). Re-run: full suite green. No pre-existing,
environmental, or flaky failures dismissed.

## REAL MYSQL

**REAL_MYSQL_CONCURRENCY=NOT_EXECUTED_ENVIRONMENT_BLOCKED**

Inspection found no Docker, no MySQL server/binaries, no running instance,
and no already-approved disposable-MySQL tooling in the environment. Per the
mandate, the run was NOT faked. Readiness without it is justified because:
(1) every exact-once/CAS anchor is structurally verified in the canonical
migration (unique anchors + version CAS columns per table);
(2) deterministic concurrency tests are green (replay + concurrent
duplicate/conflicting cases across handoff, score, qualification, review,
nurture, handoff-dispatch, conversion, audit);
(3) the one real-MySQL semantic defect found in inspection (insert-result
shape) was repaired;
(4) execution is explicitly **promoted to R10 / pre-production acceptance**;
(5) this report does not claim real-MySQL validation.

## PROVIDER TRUTH

| Channel | Status |
|---------|--------|
| WHATSAPP | UNSUPPORTED |
| SMS | UNSUPPORTED |
| CRM | UNSUPPORTED |
| EMAIL | REQUIRES_CONFIGURATION |

No live provider/CRM/payment/billing invoked; no fake success presented as
real; only the explicitly fake/test-only transport is dispatchable, in
tests.

## SECURITY

| Field | Verdict |
|-------|---------|
| SECURITY_VERDICT | PASS |
| AGENT_ISOLATION_VERDICT | PASS |
| PROMPT_INJECTION_RESISTANCE_VERDICT | PASS |
| TOOL_LEAST_PRIVILEGE_VERDICT | PASS |
| CROSS_AGENT_TRUST_VERDICT | PASS |
| SELF_MODIFICATION_GUARD_VERDICT | PASS |
| SECRET_ISOLATION_VERDICT | PASS |
| TENANT_ISOLATION_VERDICT | PASS |
| PRIVACY_GOVERNANCE_VERDICT | PASS |
| QUALIFICATION_INTEGRITY_VERDICT | PASS |
| NURTURE_INTEGRITY_VERDICT | PASS |
| HANDOFF_INTEGRITY_VERDICT | PASS |
| CONVERSION_INTEGRITY_VERDICT | PASS |
| PRIVILEGE_ESCALATION_FOUND | NONE |
| SENSITIVE_DATA_EXPOSURE_FOUND | NONE |
| ROGUE_AGENT_BLAST_RADIUS | SINGLE-AGENT INERT — a compromised agent's output is re-validated at every boundary; no authority field is client/agent-writable; no cross-tenant effect possible (tenant inside every identity hash) |
| UNRESOLVED_AGENT_SECURITY_DEBT | NONE |

## PRODUCTION

| Field | Value |
|-------|-------|
| MIGRATION_EXECUTED | False |
| DEPLOYMENT_EXECUTED | False |
| PRODUCTION_ACCESSED | False |
| LIVE_PROVIDER_INVOKED | False |
| LIVE_BILLING_INVOKED | False |

## FINAL VERDICT

**LEAD_AUTONOMY_V1_READY**

All 22 acceptance criteria are met, with criterion-relevant evidence: (1)
R5 opportunities become deterministic canonical leads; (2) duplicate/replayed
handoffs converge safely; (3) tenant isolation holds; (4) scoring is evidence
never authority; (5) qualification is governed and cannot be self-approved;
(6) privacy overrides qualification/nurture/handoff; (7) only current
QUALIFIED leads progress; (8) nurture is cadence-bounded; (9) sales handoff
is governed and exact-once; (10) provider success cannot be fabricated; (11)
conversions are exact-once without causal claims; (12) conversion stops
future nurture per policy; (13) operations projection is truthful; (14)
cross-stream authority is singular (mirrors removed, single-schema bridge,
production ports, closed version allow-list); (15) rogue agents cannot expand
authority; (16) secrets isolated; (17) cross-tenant attacks fail closed; (18)
R7 contract delivered; (19) canonical migration chain converged, NOT
executed; (20) no production action occurred; (21) every accepted commit
pushed; (22) integration branch clean and remote-synced.
