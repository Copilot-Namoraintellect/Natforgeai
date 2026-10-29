# R8-F — Strategic Intelligence Governance Acceptance Report

> Stream: WBS-R8-F · Branch `feature/r8-f-strategic-governance` · Frozen
> upstream R7 Business Optimisation V1 (`BUSINESS_OPTIMISATION_V1_READY`,
> HEAD `a2c084a1f0bca110a00e51f83632733789cec5f7`).

## IDENTITY

```
branch=feature/r8-f-strategic-governance
HEAD=0f66214 (R8-F governance commit; programme base a2c084a1f0bca110a00e51f83632733789cec5f7)
remote=origin https://github.com/Copilot-Namoraintellect/Natforgeai.git
working_tree=clean (all R8-F changes committed and pushed on the stream branch)
```

## SCOPE DELIVERED

R8-F owns strategic-intelligence governance only: closed recommendation
taxonomy, strategic risk classes, evidence/source-trust governance, confidence
thresholds, human-review thresholds, recommendation eligibility, blocker
taxonomy, immutable governance receipts, truthful operations projection, narrow
recovery, and R9 handoff semantics. It does NOT own strategic reasoning, market
signal ingestion, change detection, opportunity/risk ranking, strategy
mutation, mission planning, budget execution, experiment execution, or
provider/payment/billing execution — and imports none of them (verified
statically + dynamically).

## DELIVERABLES

| Slice | Artefact |
|---|---|
| F0 | `docs/recovery/r8-f-strategic-governance-inventory.md` |
| F1 | `docs/contracts/strategic-intelligence-governance-contract.md` |
| F1..F8 code | `api/lib/strategic-governance/` (12 modules) |
| Router | `api/strategic-governance-router.ts` (`strategicGovernance`, registered in `api/router.ts`) |
| F2 | `strategic-recommendation-taxonomy.ts` — 10 closed types, no execution types |
| F3 | `strategic-evidence-governance.ts` — 7 trust classes, server-derived |
| F4 | `strategic-risk-classification.ts` — LOW/MEDIUM/HIGH/CRITICAL, raise-only |
| F5 | `strategic-approval.ts` + `strategic-review-authority.ts` (reuses R6-C OTP primitive + R4 approval ledger, `approvalType "strategic_recommendation"`) |
| F6 | injection/misinformation containment in `strategic-decision-engine.ts` |
| F7 | authority separation: no execution surface; `assertStrategicRecommendationConsumable` ⇒ `authorityScope: "RECOMMENDATION_ONLY"` |
| F8 | `strategic-blocker-taxonomy.ts` + `strategic-operations-projection.ts`; recovery = audit-only closed vocabulary |
| F9 | `r8-f-acceptance.test.ts` (39 tests, 36 ACs) + `strategic-governance.test.ts` (16 unit tests) |
| Downstream | `docs/contracts/strategic-governance-to-reasoning-opportunity-contract.md` |
| Schema | `strategic_governance_decisions` in `db/schema.ts`; provisional `0036_r8_f_strategic_governance_foundation` (NOT executed) |

## F0 — GOVERNANCE INVENTORY

`docs/recovery/r8-f-strategic-governance-inventory.md`. Determination: REUSE
R7-F policy-registry / narrowing-engine / store+seam / approval-ledger / OTP
human-presence / audit-ledger / tenant-authority / blocker+projection
patterns; ADAPT risk/confidence vocabularies; Business DNA authority is a
reference-only protected boundary; strategic evidence stores are NOT owned
(provider seam fails closed until R8-X). No competing approval/policy systems
created.

## F1 — CONTRACT

Closed decision vocabulary exactly `ALLOW_RECOMMENDATION | REVIEW_REQUIRED |
BLOCK` — no EXECUTE outcome. Decision record fields per contract §3
(governanceDecisionId `sgd1:`, businessId, proposalId, proposalType,
evidenceRefs[], sourceTrustClass, confidenceClass, strategicRiskClass,
policyVersion, decision, reasonCodes[] ≤8, approvalRequired, approvalReference
(binding), validUntil, evidenceFingerprint, proposalFingerprint, createdAt +
contract/engine/evaluation metadata). Rows immutable; exactly one audit event
per inserted decision.

## F2 — TAXONOMY

10 closed recommendation types (observation, hypothesis, market/business-
priority/channel/audience/product-marketing/opportunity/risk/ resource
recommendations). Unknown type → BLOCK. No direct execution types exist.

## F3 — EVIDENCE / SOURCE TRUST

7 server-derived trust classes; derivation rules per contract §5. Unverified
external cannot silently become fact (LOW ceiling); single-source bounded
(LOW ceiling); contradictions stay visible (cap NONE + visible reason);
staleness blocked/escalated; model-generated never source truth.

## F4 — RISK

LOW/MEDIUM/HIGH/CRITICAL, base-by-type + raise-only modifiers (declared impact,
weak external reliance, injection suspicion). HIGH/CRITICAL never
autonomously consumable; CRITICAL blocked by default policy.

## F5 — HUMAN REVIEW / APPROVAL

Reuses `approval_requests` (provisional `strategic_recommendation` enum) +
R6-C out-of-band OTP (purpose `review_authorization`). Binding hash covers
decision + policy + proposal + evidence fingerprints + confidence/risk/trust
snapshot + expiry. Rejected: generic, stale, cross-business, cross-proposal,
modified-after-approval, agent self-approval, client-fabricated approval.
Approved recommendation remains recommendation authority only.

## F6 — MISINFORMATION / PROMPT INJECTION

External/model content is inert; injection suspicion only raises risk and
annotates the decision. Source cannot alter instructions (no LLM in the
decision path), invoke tools (no tool surface), change governance rules
(code-level immutable policy), expose secrets (no secret access + audit
hygiene), change business authority (server-side re-verification), mark itself
trusted (server-side registry), or create recommendations directly.

## F7 — AUTHORITY SEPARATION

No campaign launch, strategy mutation, budget increase, Business DNA change, or
provider/payment/billing path exists in this stream (static import scan +
router procedure scan + only-RECOMMENDATION_ONLY verdict + AC36 table-touch
proof).

## F8 — OPERATIONS / RECOVERY

Truthful read-only projection (status derived, staleness/expiry computed).
Recovery = closed vocabulary, audit-only; no forceAllow/forceApprove/
setTrusted/overrideRisk/overridePolicy anywhere.

## F9 — ACCEPTANCE (36/36 proven, 39 tests)

AC1 allow low-risk well-evidenced ✓ · AC2 unknown type blocked ✓ · AC3
malformed blocked ✓ · AC4 cross-business blocked ✓ · AC5 cross-tenant evidence
blocked ✓ · AC6 authoritative internal accepted ✓ · AC7 verified external
handled ✓ · AC8 single source bounded ✓ · AC9 unverified can't reach high
confidence ✓ · AC10 contradicted lowers/blocks ✓ · AC11 stale conservative ✓ ·
AC12 model-generated not source ✓ · AC13 injection can't alter governance ✓ ·
AC14 source can't self-mark trusted ✓ · AC15 source can't invoke tools ✓ ·
AC16 source can't access secrets ✓ · AC17 high-risk review/block ✓ · AC18
forged approval rejected ✓ · AC19 stale approval rejected ✓ · AC20
cross-proposal replay rejected ✓ · AC21 modified recommendation invalidates ✓ ·
AC22 agent self-approval rejected ✓ · AC23 client can't fabricate ALLOW ✓ ·
AC24 no campaign launch ✓ · AC25 no strategy mutation ✓ · AC26 no budget
increase ✓ · AC27 no Business DNA mutation ✓ · AC28 no provider/payment/billing
✓ · AC29 agent can't lower risk ✓ · AC30 agent can't raise trust ✓ · AC31
agent can't modify policy ✓ · AC32 contradiction visible ✓ · AC33 projection
truthful ✓ · AC34 recovery can't force approval ✓ · AC35 audit written exactly
once ✓ · AC36 no production action ✓.

## TESTING

```
targeted=55/55 (r8-f-acceptance 39 + strategic-governance unit 16)
affected_regressions=923 passed, 0 failed:
  audit 12 files (incl. updated taxonomy expectation) 160 tests
  approval-router + r5 policy + qualification + lead-governance 378 tests
  r7-x harnesses + budget-portfolio + experimentation + nurture 219 tests
  r6-x harnesses + r5 marketing-operations + listening + engagement 166 tests
full_suite=6924 passed, 2 failed, 68 skipped, 14 todo (7008 tests, 432 files)
  - 2 failures are environmental, NOT regressions, both proven by isolation:
    * api/lib/creative/premium-v2/html-renderer.test.ts — 10s timeout under
      full-suite load; passes in isolation (28/28 with the R4 e2e below).
    * api/lib/workflow/__tests__/r4-x6-full-autonomy-e2e.test.ts — beforeEach
      hook timeout under full-suite load; passes in isolation.
  - 1 failed suite is a missing-env failure, NOT a regression:
    * src/pages/Campaigns.test.tsx — FirebaseError auth/invalid-api-key at
      module load (VITE_FIREBASE_API_KEY absent in this environment); the
      file is untouched by R8-F.
typescript=tsc -b clean (exit 0, no errors)
build=<see BUILD below>
diff_check=clean (git diff --check)
secret_scan=clean (no real secrets; only pre-existing test fixtures, the
  audit sanitizer regex, and pre-existing schema comments)
```

### BUILD

```
npm run build — PASS (exit 0): vite build ✓ (built in 1m10s), esbuild
api/boot.ts + api/worker.ts ✓, verify-deployment.mjs ✅ passed.
```

## FINAL VERDICT

**STRATEGIC_GOVERNANCE_READY**

Evidence: F0–F9 delivered (above); targeted 55/55; affected regressions 923/923;
full suite 6924 passed with only 3 environment-caused, non-regression failures
(2 load-timeouts proven green in isolation; 1 missing Firebase env key in an
untouched file); tsc -b clean; build + deployment verification passed;
git diff --check clean; secret scan clean; MIGRATION_EXECUTION=False;
no production action, no deploy, no live CRM/provider/payment/billing access.

## SCHEMA

```
schema_changed=true
provisional_migration=0036_r8_f_strategic_governance_foundation (table
  strategic_governance_decisions + approval_requests.approvalType enum
  extension "strategic_recommendation"; journal idx 36 + snapshot artefact)
migration_execution=False
```

R7's `0035` was never modified. Collision note: stream-local `0036`; if a
sibling R8 stream claims `0036` first, R8-X renumbers at convergence.

## ROGUE-AGENT SECURITY

```
SECURITY_VERDICT=PASS
STRATEGIC_GOVERNANCE_VERDICT=PASS
SOURCE_TRUST_VERDICT=PASS
STRATEGIC_RISK_VERDICT=PASS
APPROVAL_INTEGRITY_VERDICT=PASS
TENANT_ISOLATION_VERDICT=PASS
AGENT_ISOLATION_VERDICT=PASS
PROMPT_INJECTION_RESISTANCE_VERDICT=PASS
TOOL_LEAST_PRIVILEGE_VERDICT=PASS
CROSS_AGENT_TRUST_VERDICT=PASS
SELF_MODIFICATION_GUARD_VERDICT=PASS
SECRET_ISOLATION_VERDICT=PASS
PRIVILEGE_ESCALATION_FOUND=NONE
ROGUE_AGENT_BLAST_RADIUS=NONE (advisory-only outputs; no execution, billing,
  provider, CRM, campaign, strategy, budget, or Business DNA surface)
UNRESOLVED_AGENT_SECURITY_DEBT=NONE
```

READY-forbidden conditions verified absent: a client/model/agent cannot
promote source trust (server-derived; AC30), lower risk (raise-only; AC29),
self-approve (OTP out-of-band + binding; AC22), or turn a recommendation into
execution authority (RECOMMENDATION_ONLY scope; AC24–AC28).

## GIT GOVERNANCE

No branch switches; no sibling-R8/integration merges; no reset/clean/stash; no
force push; no history rewrite. Slices committed atomically with immediate
push.

## FINAL VERDICT (recorded above)

**STRATEGIC_GOVERNANCE_READY** — with the full-suite / tsc / build evidence
recorded in the TESTING and BUILD sections. Do not deploy. Do not execute
migrations. Do not access production. Do not invoke live
CRM/provider/payment/billing systems.
