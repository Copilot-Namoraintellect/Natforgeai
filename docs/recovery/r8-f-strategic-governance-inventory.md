# R8-F — Strategic Intelligence Governance Inventory (F0)

> Stream: `feature/r8-f-strategic-governance` · Base `a2c084a1` · Frozen upstream: R7 Business Optimisation V1 (`BUSINESS_OPTIMISATION_V1_READY`).
> Date: 2026-11-10. Status: governance inventory — determines reusable primitives before any R8-F code.

## 0. Purpose

R8-F owns **strategic-intelligence governance only**: what evidence is acceptable, which strategic claims are allowed, what confidence is required, when human review is mandatory, what may be produced autonomously, what must never become execution authority, and how external misinformation / prompt injection / manipulated signals are contained. It does **not** own strategic reasoning, market intelligence, change detection, opportunity/risk ranking, strategy mutation, mission planning, budget execution, experiment execution, or provider/payment/billing execution.

This document inventories the existing governance primitives the stream reuses. **No competing approval/policy systems are created where existing ones suffice.**

## 1. Inventory method

Read-only inspection of: R4 governance & approval centre, R5 policy/safety/cost governance, R6 lead governance (identity/scoring/qualification/nurture/governance), R7 optimisation governance, the approval ledger, the human OTP proof primitive, the audit ledger, Business DNA authority, strategy authority, risk/confidence taxonomies, provider capability controls, and the operator/admin surfaces. Module headers and contract docs were read directly; no code was executed and no schema was changed during inventory.

## 2. Reusable primitives (determination: REUSE)

### 2.1 Versioned, code-level policy registry — R7-F (`api/lib/optimisation-governance/optimisation-policy.ts`)
- Pattern: immutable-per-version `Map` registry; same version + different content → `POLICY_VERSION_CONFLICT`; **no runtime mutation endpoint**; conservative default; unknown version → fail closed.
- R8-F reuses the pattern verbatim for `strategic-policy.ts` (strategic recommendation taxonomy, trust classes, risk classes, confidence thresholds, staleness windows, review thresholds).

### 2.2 Closed taxonomy + pure decision engine — R7-F (`optimisation-action-taxonomy.ts`, `optimisation-decision-engine.ts`)
- Closed action vocabulary; unknown type → durable `BLOCK`; authority only ever narrows (`weakest` composition); deterministic decision identity over `{userId, businessId, proposalId, proposalType, policyVersion, proposalFingerprint, evidenceHash}`; prompt-injection suspicion only raises risk, never widens.
- R8-F reuses the shape; the dimensions change from financial/experiment/portfolio to **evidence trust / confidence / strategic risk / staleness / injection containment**.

### 2.3 Durable immutable decision store + structural executor seam — R7-F (`optimisation-governance-store.ts`, `optimisation-governance-bridge.ts`)
- Table in `@db/schema` (single source of truth); insert-only rows; unique `(userId, governanceDecisionId)` convergence anchor; `ER_DUP_ENTRY` → `idempotent_replay`; structural select/insert seam bound to Drizzle in the bridge and to the in-memory fake in tests; guarded `information_schema` degradation (table absent → fail closed).
- R8-F reuses verbatim for `strategic_governance_decisions` (provisional 0036).

### 2.4 Governed approval ledger — R4/R6-D/R7-F (`db/schema.ts: approval_requests`)
- Existing `approvalType` enum: `campaign_launch`, `budget_increase`, `sensitive_reply`, `high_value_proposal`, `ad_spend`, `shutdown`, `brand_risk`, `strategy_review`, `marketing_action` (R5-E), `sales_handoff` (R6-D), `optimisation_action` (R7-F).
- R7-F binding discipline (`optimisation-approval.ts`): approval binds exact decision + policy version + proposal fingerprint via `approvalBindingHash = sha256(decisionId, policyVersion, proposalFingerprint)`; expiry; rejection permanently blocks the identity; `assertOptimisationActionExecutable` is the single downstream execution gate.
- **R8-F reuses the ledger** with a provisional enum extension `strategic_recommendation` (0036 artefact; R8-X owns convergence). Same binding hash discipline extended with `evidenceFingerprint` + confidence/risk snapshot. The downstream gate is renamed for honesty: `assertStrategicRecommendationConsumable` — its verdict is **recommendation-consumption authority only, never execution authority** (F7).

### 2.5 Independent human-presence proof — R6-C (`api/lib/qualification/qualification-review-authority.ts`, `api/lib/auth/otp.ts`)
- Email OTP challenge: out-of-band, single-use, 10-minute TTL, attempt-limited, purpose `review_authorization`, bound server-side to the exact review id. A tenant JWT alone can never resolve a review (runtime agents hold the tenant JWT and are indistinguishable from the human at the session layer).
- R8-F reuses the **same governed OTP primitive** for strategic-approval resolution (`strategic-review-authority.ts`, `ReviewChallengeGateway` seam; production wires `OtpReviewChallengeGateway`). This is the structural answer to *agent self-approval* (F5/AC22): an autonomous agent can observe the approval binding but can never observe the emailed code, so it cannot fabricate the human act.

### 2.6 Canonical audit ledger — WBS7A/B (`api/lib/audit/audit-event.ts`, `audit-store.ts`, `db/schema.ts: audit_events`)
- Immutable envelope; closed `AUDIT_EVENT_TYPES` taxonomy; deterministic fingerprint; metadata hygiene (sensitive keys stripped, JSON-like only, Error objects rejected); one event per durable effect, convergence emits zero.
- R8-F adds two types: `strategic_governance_decision`, `strategic_governance_recovery` (code-level, additive). Evaluation persists decision + audit in one transaction.

### 2.7 Business authority / tenant scoping — R7-F bridge (`getBusinessAuthority`)
- Business ownership verified by **both** id and owning user; unknown/cross-tenant business is indistinguishable from absent → `OWNERSHIP_MISMATCH` fail closed. R8-F reuses; evidence resolution additionally verifies per-ref tenant ownership (`CROSS_TENANT_EVIDENCE`).

### 2.8 Risk / confidence taxonomies
- R5-E risk tiers `low < medium < high < critical` (autonomy only narrows as risk rises).
- R7-B confidence `HIGH/MEDIUM/LOW/NONE` and evidence classes `DIRECT_LINKAGE / STRONG_ASSOCIATION / WEAK_ASSOCIATION / INSUFFICIENT_EVIDENCE` (`db/schema.ts` attribution columns).
- R8-F adapts: strategic risk `LOW/MEDIUM/HIGH/CRITICAL` (brief F4); confidence reuses the closed `HIGH/MEDIUM/LOW/NONE` scale; evidence trust classes are new (F3) but modelled on the same "server-derived, never client-supplied" discipline.

### 2.9 Blocker taxonomy + read-only operations projection — R7-F (`optimisation-blocker-taxonomy.ts`, `optimisation-operations-projection.ts`)
- Closed blocker classes each mapped to a recovery class (`AUTO_RECOVER / OPERATOR_ACTION / FAIL_CLOSED / GOVERNANCE_APPROVAL`); projection derives status from immutable rows (staleness/expiry computed, never stored); **no** `forceAllow/forceApprove/setTrusted/overrideRisk/overridePolicy` anywhere.
- R8-F reuses the shape with strategic blocker classes.

### 2.10 tRPC router + middleware conventions (`api/middleware.ts`, `api/router.ts`)
- `authedQuery` (tenant session), `adminQuery` (role), `z.strictObject` inputs rejecting every client-supplied authority field; error→tRPC-code mapping (fail closed).
- R8-F router `strategicGovernance` (`api/strategic-governance-router.ts`) registers in `appRouter` alongside the R7 routers.

### 2.11 Test harness (`api/r5-test-support.ts` `createFakeDb`)
- Table-name-keyed in-memory Drizzle-SQL evaluator with insert/audit/transaction support; raw authority modules are never mocked. R8-F acceptance suite reuses it (decisions + audit events + approval rows in the fake).

### 2.12 Business DNA authority (`api/lib/business-dna-governance.ts`, `evaluateBusinessDnaReadiness`)
- Business DNA is governed by its own authority. R8-F **references** it only as a protected boundary (F7): a strategic recommendation can never mutate Business DNA; the R8-F module tree imports nothing from it.

## 3. Explicit non-goals / non-reuse determinations

- **No new approval system.** The approval ledger (2.4) + OTP primitive (2.5) suffice; R8-F only adds the binding vocabulary and the consumable gate.
- **No new policy store.** Code-level registry (2.1) suffices; there is deliberately no policy mutation endpoint (an agent must never modify its own thresholds — AC31).
- **No execution surface of any kind.** No campaign/strategy/budget/DNA/provider/billing imports in the R8-F module tree (verified by the F9 static blast-radius test).
- **Strategic evidence stores are not created here.** Market-signal ingestion / strategic memory belong to sibling R8 streams; the R8-F bridge binds evidence resolution as a provider seam that fails closed (`EVIDENCE_AUTHORITY_UNAVAILABLE`) until R8-X wires canonical evidence stores. This mirrors R7-F's guarded degradation while 0035 was unexecuted.

## 4. Collision & sequencing notes

- **Migration numbering:** R7-X canonical `0035_r7_business_optimisation_foundation` is the highest journal entry. R8-F uses **provisional `0036_r8_f_strategic_governance_foundation`** (stream-local artefact, **NOT executed**). R8-X owns convergence; if a sibling stream claims 0036 first, R8-X renumbers. R7's 0035 is never modified.
- **Enum extension:** `approval_requests.approvalType += "strategic_recommendation"` is additive only (same pattern as the accepted-but-unexecuted `optimisation_action` extension). Audit event types are code-level additive.
- **Router namespace:** `strategicGovernance` (no collision with existing namespaces).
- **Id prefixes:** `sgd1:` (strategic governance decision), `sgprop1:` idempotency prefix for strategic approvals — no collision with `ogd1:`/`ogov1`.

## 5. Determination summary

| Primitive | Owner | R8-F disposition |
|---|---|---|
| Policy registry pattern | R7-F | REUSE (new strategic-policy module, same invariants) |
| Closed taxonomy + narrowing engine | R7-F/R5-E | REUSE |
| Durable store + structural seam + fake | R7-F/R5-F | REUSE |
| Approval ledger `approval_requests` | R4/R6-D/R7-F | REUSE + provisional enum value |
| OTP human-presence proof | R6-C (`api/lib/auth/otp`) | REUSE (review challenge gateway) |
| Audit ledger | WBS7A/B | REUSE + 2 additive event types |
| Business/tenant authority check | R7-F | REUSE |
| Risk/confidence vocabulary | R5-E/R7-B | ADAPT (strategic risk + trust classes) |
| Blocker taxonomy + operations projection | R7-F | REUSE (strategic classes) |
| Business DNA authority | R2.x | REFERENCE-ONLY protected boundary (F7) |
| Strategic evidence stores | sibling R8 streams | NOT OWNED — provider seam fails closed |

Inventory verdict: all governance primitives R8-F needs already exist; the stream adds only the strategic-specific vocabulary, derivation rules, and the read-only R9 handoff semantics.
