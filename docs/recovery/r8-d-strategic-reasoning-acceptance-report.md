# R8-D STRATEGIC REASONING — ACCEPTANCE REPORT

> Stream: WBS-R8-D `feature/r8-d-strategic-reasoning`
> Date: 2026-11-10

## IDENTITY

| Field | Value |
|---|---|
| branch | `feature/r8-d-strategic-reasoning` |
| HEAD | `fa5e4bf` |
| remote | `origin` (`https://github.com/Copilot-Namoraintellect/Natforgeai.git`) |
| working_tree | clean |

## UPSTREAM

| Authority | HEAD | Consumption |
|---|---|---|
| r8_a_head | `23d0f22` | `strategic-memory-to-reasoning/v1` — raw-SQL seam over `strategic_memory_records` behind guarded information-schema check; frozen per-source contract versions re-validated (`strategic-reasoning-evidence-seam.ts`); CURRENT-state + contradiction semantics honoured |
| r8_b_head | `055eece` | `business-change-to-reasoning/v1` — same seam over `business_change_events`; closed change-type/direction vocabulary drives the rule engine |
| r8_c_head | `b366c5e` | `external-signal/v1` — same seam over `external_signals`; trust ceilings binding (single-source ⇒ LOW, contradicted ⇒ visible); `injectionSuspected` forwarded to R8-F as risk material; external content never loaded |
| r8_f_head | `44118e3` | `strategic-governance/v1` — single governance authority bound through a registration port (no second engine); decisions persisted verbatim incl. fingerprints; approval derivation read-only through F5 binding-hash validation |
| r7_head | `a2c084a` | `business-optimisation-to-strategic-intelligence/v1` — consumed indirectly via R8-A memory evidence refs only; never written |

contract_compatibility: PASS — all four frozen projection/contract versions bound in code
(`STRATEGIC_REASONING_BOUND_VERSIONS`) and re-validated at evidence resolution;
downstream projection key allowlist asserted exact (acceptance cases 26/39).

No merges of sibling streams were performed. All upstream consumption is by
branch-ref contract through guarded seams; R8-X owns canonical binding.

## DELIVERABLES

| Gate | Status | Evidence |
|---|---|---|
| D0 inventory | DONE | `docs/recovery/r8-d-strategic-reasoning-inventory.md` — no existing component owns strategic reasoning (strategy snapshots = campaign strategy record-keeping; agents = creative/distribution; learning = campaign-level); boundary map documented (campaign strategy vs business optimisation vs strategic reasoning vs R8-E vs R9) |
| D1 contract | DONE | `docs/contracts/strategic-reasoning-contract.md` (`strategic-reasoning/v1`, engine `strategic-reasoning-engine/v1`); closed vocabularies: hypotheses (12), implications (9, attention-verbs only), confidence (4), uncertainty (6), missing-evidence (5), risk (carried from R8-F), status (9); all D1 record fields defined |
| D2 bundle/graph | DONE | `evb1:` deterministic bundle identity (same evidence set ⇒ same bundle; case 15); raw-SQL evidence seam with tenant/business/version/hash re-validation; bounded DAG graph (SUPPORTS/CONTRADICTS/CONTEXTUALISES/LIMITS; ≤64 nodes/≤256 edges/depth ≤3; acyclic by construction); no client-created references |
| D3 synthesis | DONE | `strategic-reasoning-synthesis.ts` — deterministic rule-first engine (resource/alignment/decline/growth/external-family/composed rules + budget-underperformance guard); optional model candidates are select-among-rule-output only, closed vocabulary, never authority (cases 23–25) |
| D4 confidence | DONE | Evidence-quality caps only: external-only ⇒ LOW (case 3); single-source ⇒ LOW (case 13); assumption-memory ⇒ MODERATE cap (case 12); contradiction ⇒ MODERATE cap (case 10); corroborated + verified internal ⇒ HIGH eligible (case 14); weak evidence ⇒ INSUFFICIENT/LOW (case 6); uncertainty classes bundle-wide |
| D5 implications | DONE | MONITOR…NO_ACTION closed set; no EXECUTE/LAUNCH/SPEND/CHANGE_STRATEGY/UPDATE_DNA anywhere (static scan asserted, case 29) |
| D6 governance | DONE | R8-F engine registration port (`getStrategicGovernanceEnginePort` fails closed when unbound — security suite); proposal material = mapped F2 taxonomy + bounded summary + claimed confidence + declared impact; decision persisted verbatim incl. `governanceDecisionRecord` for approval fingerprint validation; ALLOW/REVIEW/BLOCK → SUPPORTED/REVIEW_REQUIRED/BLOCKED (cases 35–38) |
| D7 lifecycle | DONE | CANDIDATE→SUPPORTED/REVIEW_REQUIRED/BLOCKED; derived APPROVED_RECOMMENDATION from exact bound approval (case 38); re-evaluation mints superseding records (`supersedesReasoningId`), contradiction/staleness/expiry demotions as append-only `srl1:` facts; immutable history (lifecycle tests) |
| D8 projection | DONE | `docs/contracts/strategic-reasoning-to-opportunity-risk-contract.md` — 34-key frozen allowlist, verbatim causation/attribution/execution disclaimers, seam validator; active-set semantics (case 35) |
| D9 acceptance | DONE | 42/42 connected cases (`api/strategic-reasoning-acceptance.test.ts`) + 13/13 rogue-agent cases (`api/strategic-reasoning-security.test.ts`) |

## TESTING

| Suite | Result |
|---|---|
| R8-D targeted (connected acceptance) | 42/42 PASS |
| R8-D rogue-agent security | 13/13 PASS |
| R7-X connected harness (40 scenarios) | 40/40 PASS |
| R7-X security acceptance (21 cases) | 21/21 PASS |
| R7-A attribution acceptance | PASS |
| R7-A outcome acceptance | PASS |
| R7-C business-learning acceptance | PASS |
| R7-D experimentation acceptance | PASS |
| R6-X harness | PASS |
| strategy snapshot/history regression (3 suites) | PASS |
| campaign-router regression | PASS |
| full offline suite (7008 tests) | 6918+ passed; all failures triaged — see note |
| typescript (`tsc -b`) | PASS (exit 0) |
| build (`npm run build` + deployment verify) | PASS (exit 0) |
| diff_check | PASS (`git diff --check` clean at every commit) |

Full-suite triage (two full runs under load): every failure was either
(a) the audit taxonomy pin — caused by this stream's two additive event
types, **fixed** in `fa5e4bf` (taxonomy test updated, house convention for
additive stream types); (b) 10s test timeouts in heavy e2e suites
(integration-router, publishing-router, html-renderer, r4-x6 e2e) that pass
in isolation **identically at the base commit** `a2c084a` (verified in a
temporary worktree at base, then re-verified on this branch — 47/47); or
(c) `src/pages/Campaigns.test.tsx`, which requires Firebase env vars absent
in this offline shell and fails identically at base. No regression is
attributable to R8-D.

R8-A/B/C/F compatibility: their stream code is not merged here (programme
governance); compatibility is proven at contract level — the evidence seam
binds their frozen contract versions and table shapes (columns taken from
their provisional 0036 migrations), their projection semantics are honoured
in the synthesis engine, and R8-F's decision/approval shapes are validated
verbatim by the governance seam. Their own acceptance suites carry READY
verdicts at the accepted heads consumed above.

## SCHEMA

| Field | Value |
|---|---|
| schema_changed | yes — `db/schema.ts` += `strategic_reasoning_bundles`, `strategic_reasoning_records`, `strategic_reasoning_lifecycle_events`; `audit_events` += 2 material types |
| provisional_migration | `db/migrations/0036_r8_d_strategic_reasoning_foundation.sql` |
| migration_execution | **False** — artefact only; R7 `0035` untouched; 0036 collision with the four sibling R8 0036 provisionals documented in `docs/recovery/r8-d-unexecuted-migrations.md`; R8-X owns convergence |

## SECURITY

| Verdict | Value |
|---|---|
| SECURITY_VERDICT | PASS |
| STRATEGIC_REASONING_INTEGRITY_VERDICT | PASS — conclusions are insert-only, fingerprint-bound, deterministic; replay converges (case 16), conflicting replay fails closed (case 17) |
| EVIDENCE_BUNDLE_INTEGRITY_VERDICT | PASS — server-resolved refs only; cross-tenant/cross-business/unknown/stale-version/malformed/tampered all fail closed (cases 18–22, security suite bundle-conflict test) |
| CONFIDENCE_INTEGRITY_VERDICT | PASS — evidence-quality caps only; model cannot raise (case 24); no client confidence field exists (smuggling rejected) |
| CONTRADICTION_INTEGRITY_VERDICT | PASS — contradictions preserved verbatim in conclusions and projections (cases 10–11); model cannot suppress (case 25); bundle-wide visibility |
| TENANT_ISOLATION_VERDICT | PASS — every read tenant+business predicated; cross-tenant/business evidence indistinguishable from unknown (cases 18–20) |
| GOVERNANCE_BINDING_VERDICT | PASS — single R8-F authority via registration port; absence fails closed; malformed/cross-business engine decisions rejected (security suite) |
| APPROVAL_INTEGRITY_VERDICT | PASS — read-only ledger derivation via F5 binding hash; forged/cross-proposal approvals rejected (case 37 + security suite); tenant JWT alone can never self-approve (case 36) |
| AGENT_ISOLATION_VERDICT | PASS — model seam is candidate-only over closed vocabularies, no DB/tool access, no chain-of-thought persisted |
| PROMPT_INJECTION_RESISTANCE_VERDICT | PASS — external content never loaded into views (case 28); injection annotations only raise governance risk material (case 27) |
| TOOL_LEAST_PRIVILEGE_VERDICT | PASS — no exec/shell/SQL surface anywhere in the stream (static scan, case 29) |
| CROSS_AGENT_TRUST_VERDICT | PASS — engine decisions validated against the exact proposal/business binding; a rogue engine cannot mint a usable decision (security suite) |
| SELF_MODIFICATION_GUARD_VERDICT | PASS — no policy mutation endpoints; governance policy is R8-F code-level, never touched here |
| SECRET_ISOLATION_VERDICT | PASS — no env/secret access in any stream module (static scan); metadata carries ids/labels/hashes only |
| PRIVILEGE_ESCALATION_FOUND | none |
| ROGUE_AGENT_BLAST_RADIUS | contained — a rogue client/agent can only propose evidence refs + untrusted closed-vocabulary candidates; it cannot decide, approve, execute, elevate confidence, lower risk, hide contradiction, fabricate evidence, or write any upstream/execution table |
| UNRESOLVED_AGENT_SECURITY_DEBT | none known — real-MySQL concurrency execution promoted to R10/pre-production acceptance (house convention; deterministic convergence green in store convergence paths) |

## FINAL VERDICT

STRATEGIC_REASONING_READY
