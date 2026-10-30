# R8-E Strategic Opportunity & Risk Intelligence — Acceptance Report

> **Date:** 2026-11-10
> **Stream verdict:** `STRATEGIC_OPPORTUNITY_RISK_READY`

---

## IDENTITY

```
branch=feature/r8-e-strategic-opportunity-risk
HEAD=905bebbaaca7eabc37f98026ccc579517f51a141
remote=https://github.com/Copilot-Namoraintellect/Natforgeai.git
working_tree=clean (report commit follows)
programme_base=a2c084a1f0bca110a00e51f83632733789cec5f7
```

## UPSTREAM

```
r8_a_head=23d0f22  ✓ (consumed by branch ref only — never merged)
r8_b_head=055eece  ✓
r8_c_head=b366c5e  ✓
r8_d_head=00f9adf  ✓ (frozen 34-key projection contract bound + validated)
r8_f_head=44118e3  ✓ (frozen decision/policy/binding formulas mirrored)
contract_compatibility=strategic-reasoning-to-opportunity-risk/v1 (exact 34-key
  allowlist + verbatim disclaimers asserted at the seam boundary, both
  directions) + strategic-governance/v1 (decision vocabulary, default-policy
  dispositions, F5 approval binding hash) + strategic-intelligence-to-mission-control/v1
  (37-key exact R9 allowlist, verbatim mission/execution disclaimers)
```

## E0–E10

```
E0=docs/recovery/r8-e-strategic-opportunity-risk-inventory.md — R8-D projection,
   R5/R6/R7 terminology boundaries locked, scoring frameworks, audit/approval,
   schema/migration state (5 stream-local 0036 provisionals, none converged).
E1=docs/contracts/strategic-opportunity-risk-contract.md — versioned authority
   (strategic-opportunity-risk/v1); closed vocabularies (2 kinds, 15 types,
   impact/urgency/horizon/confidence/priority/risk/status/relation classes);
   sor1: identity formula; client-authority rejection; error taxonomy.
E2=api/lib/strategic-opportunity-risk/{contract,identity,reasoning-seam}.ts —
   deterministic sor1: identity (tenant+business+kind/type+reasoning+subjectKey+
   evidenceBundleFingerprint); exact-once convergence anchor (userId,candidateId);
   conflicting replay fails closed; R8-D payload re-validation (version, 34-key
   allowlist, identity patterns, verbatim disclaimers); raw-SQL production
   binding behind guarded information-schema check; unregistered ⇒ fail closed.
E3=classification.ts deriveCandidateVerdict — deterministic rule-first
   (hypothesis×implication×risk×contradiction) mapping; NO_ACTIONABLE/NO_ACTION/
   non-active/stale/insufficient+no-risk ⇒ NO_CANDIDATE; model candidate-type
   proposals advisory-only (disagreement ignored, never authority).
E4=classification.ts computeImpactScore/computeUrgencyScore/deriveTimeHorizon —
   independent integer dimensions, fixed documented weights; no model input.
E5=classification.ts computeEvidenceQualityScore/computePriorityScore/priorityClassOf —
   integer fixed-point ranking with 4 binding caps (INSUFFICIENT⇒MONITOR;
   LOW≤MEDIUM; weak-confidence+major-impact⇒MONITOR; CRITICAL_REVIEW needs
   MODERATE+ and MAJOR+); contradiction lowers priority and stays visible.
E6=overlap.ts computePortfolioRelation — deterministic NEW/REINFORCING/
   OVERLAPPING/CONFLICTING/SUPERSEDING via exact subjectKey / shared reasoning /
   anchor refs / R8-D supersedesReasoningId chains; relations persisted as
   lineage rows — never score inputs.
E7=governance-seam.ts + service — R8-F mandatory; proposal material only
   (proposalId=candidateId, implication→recommendation-type mapping, claimed
   confidence scale-mapped, structured declaredImpact); decision validated and
   bound verbatim (id, decision, policyVersion, risk, full payload); status map
   ALLOW⇒GOVERNED_RECOMMENDATION/MONITOR, REVIEW_REQUIRED⇒REVIEW_REQUIRED,
   BLOCK⇒BLOCKED(terminal); assertCandidateConsumable = only eligibility gate,
   authorityScope RECOMMENDATION_ONLY; approval ledger read via F5 binding hash
   (forged/edited/cross-decision/expired fail closed); no approval write path.
E8=projection.ts + docs/contracts/strategic-intelligence-to-mission-control-contract.md —
   37-key frozen read-only R9 projection, verbatim causation/attribution/
   execution/mission disclaimers; candidate≠mission; recommendation≠execution
   authorization; deterministic rank order (priorityScore desc, candidateId
   tie-break); governance+freshness eligibility.
E9=service.reevaluateStrategicCandidate + store — D lifecycle drives candidate
   lifecycle (supersession mints successor bound by supersedesCandidateId;
   contradiction/staleness/invalidation transitions); governance revalidation
   re-binds on material change; CAS versioned transitions; append-only sorl1:
   facts; terminal-state replay converges with zero events; history preserved.
E10=57 targeted cases (46 connected acceptance + 11 adversarial security) —
   all 48 required proofs covered, incl. cross-tenant/business rejection,
   stale/unsupported/malformed boundary rejection, deterministic identity,
   duplicate convergence, conflicting replay, distinct OPP/RISK, deterministic
   impact/urgency/horizon, weak-confidence caps, contradiction penalty, model
   cannot raise impact/urgency/confidence or hide contradiction, overlap never
   inflates score, reinforcing lineage, conflicting visibility, supersession
   history, stale-triggered re-evaluation, BLOCK/review/approval handoff gates,
   forged approval rejection, client authority smuggling rejection, non-mutation
   of strategy/DNA/budget/campaigns, projection read-only integrity,
   injection/SQL inertness, no self-approval, audit provenance, no production action.
```

## TESTING

```
targeted=PASS 57/57 (api/strategic-opportunity-risk-acceptance.test.ts 46/46;
  api/strategic-opportunity-risk-security.test.ts 11/11)
affected_regressions=PASS — R7 strategic handoff + business-learning (81/81:
  r7-x-harness, business-learning-acceptance); approval suites (30/30:
  approval-router, approval-decision-audit); audit taxonomy (20/20 after
  extending the canonical list with the two R8-E material types)
full_suite=PASS (vitest run exit 0; 432 files, ~7010 tests)
typescript=PASS (tsc -b clean, exit 0)
build=PASS (vite build + api bundle + deployment verification)
diff_check=PASS (git diff --check clean)
secret_pii_scan=PASS (no secrets/PII patterns in new files)
```

## SCHEMA

```
schema_changed=true (db/schema.ts: 3 new R8-E tables appended after R7 set;
  R7 0035 definitions untouched)
provisional_migration=0036_r8_e_strategic_opportunity_risk_foundation.sql
  (stream-local artefact; collision with sibling R8 0036 provisionals
  documented in docs/recovery/r8-e-unexecuted-migrations.md; R8-X owns convergence)
migration_execution=False
```

## SECURITY

```
SECURITY_VERDICT=PASS
OPPORTUNITY_RISK_INTEGRITY_VERDICT=PASS — candidates derive only from validated
  R8-D projections via the frozen contract; no fabrication path exists.
PRIORITISATION_INTEGRITY_VERDICT=PASS — deterministic integer formulas + 4
  binding caps; no model/client/agent can raise impact/urgency/confidence or
  inflate priority (cases 16–21, 33).
EVIDENCE_INTEGRITY_VERDICT=PASS — support/contradiction preserved verbatim;
  contradiction penalises priority and stays visible (18, 22); tampered
  fingerprints/replay fail closed (11 + boundary suites).
TENANT_ISOLATION_VERDICT=PASS — session userId anchors all reads/writes;
  business ownership re-verified per call; cross-tenant/cross-business
  reasoning never resolves (6, 7).
GOVERNANCE_BINDING_VERDICT=PASS — R8-F mandatory; decisions bound verbatim;
  BLOCK terminal; consumption gate RECOMMENDATION_ONLY; unregistered engine
  fails closed (29, 30, 34 + authority-absence cases).
APPROVAL_INTEGRITY_VERDICT=PASS — F5 binding-hash verification; forged,
  edited, cross-decision, expired and human-rejected approvals fail closed;
  no approval write path in this stream (31, 32, 46 + security suite).
AGENT_ISOLATION_VERDICT=PASS — no policy mutation, no execution calls, no
  shell/SQL/tool invocation anywhere in the stream.
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS — no free-text channel into proposal
  material (summary is deterministic from bounded space); governance layer
  blocks injection probes with CRITICAL risk (43, 44).
TOOL_LEAST_PRIVILEGE_VERDICT=PASS — read-only upstream seams + own tables only.
CROSS_AGENT_TRUST_VERDICT=PASS — untrusted-until-validated at every boundary
  (projection, governance payload, approval bindings).
SELF_MODIFICATION_GUARD_VERDICT=PASS — no runtime policy/threshold mutation
  surface; immutable versioned contracts.
SECRET_ISOLATION_VERDICT=PASS — no secret access; secret/PII scan clean.
PRIVILEGE_ESCALATION_FOUND=False
ROGUE_AGENT_BLAST_RADIUS=ZERO — a compromised opportunity/risk agent can
  neither fabricate authority, alter rankings, self-approve, nor touch
  strategy/DNA/budget/campaigns/experiments/providers; every authority
  absence fails closed.
UNRESOLVED_AGENT_SECURITY_DEBT=None known. Deferred (programme-level, not
  stream-level): real-MySQL concurrency execution promoted to R10/pre-production
  acceptance per house convention (deterministic concurrency verified in-suite).
```

## FINAL VERDICT

```
STRATEGIC_OPPORTUNITY_RISK_READY
```

Consumed by branch ref only; no sibling R8 stream merged; no migrations
executed; no deployment; no production access; no live CRM/provider/payment/
billing invocation.
