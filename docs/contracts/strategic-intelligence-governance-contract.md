# Strategic Intelligence Governance Contract (WBS-R8-F)

> Canonical contract for the R8-F strategic-intelligence governance authority.
> Branch `feature/r8-f-strategic-governance`; base `a2c084a1`; frozen upstream
> R7 Business Optimisation V1 (`BUSINESS_OPTIMISATION_V1_READY`).
> Implementation: `api/lib/strategic-governance/`; router `strategicGovernance`
> (`api/strategic-governance-router.ts`); schema `strategic_governance_decisions`
> (provisional migration `0036_r8_f_strategic_governance_foundation`, NOT executed).

## 1. Purpose and authority boundary

R8-F decides **whether a strategic recommendation may be voiced** — never
*which* strategy is optimal and never *any* execution. It governs: acceptable
evidence, allowed strategic claims, required confidence, mandatory human
review, autonomous recommendation eligibility, and the containment of external
misinformation / prompt injection / manipulated signals.

R8-F does **not** own: strategic memory, market signal ingestion, business
change detection, strategic reasoning, opportunity/risk ranking, strategy
mutation, mission planning, campaign execution, budget optimisation,
experiment execution, or provider/payment/billing execution. A recommendation
— allowed or human-approved — is **advisory authority only** and can never
become execution authority (charter F7).

Core principles enforced: recommendations are advisory, not execution
authority; strategic claims preserve evidence quality and uncertainty;
external information is untrusted until provenance/trust checks pass; a
language model may synthesize evidence but cannot create source truth;
high-impact recommendations require stronger evidence/human review; no
recommendation may directly increase budget, launch a campaign, change
Business DNA, alter policy, or invoke provider execution; unknown
recommendation/action classes fail closed; governance stays independent from
reasoning.

## 2. Target flow

```
strategic evidence / recommendation proposal
+ business policy (versioned, server-side)
+ evidence provenance (server-resolved)
+ confidence (claimed, evidence-bounded)
+ risk class (server-derived)
+ external-source trust (server-derived)
+ current business state (tenant-anchored)
↓ governance evaluation
↓ ALLOW_RECOMMENDATION | REVIEW_REQUIRED | BLOCK
↓ human approval where required (OTP-bound, Approval Centre)
↓ governed strategic recommendation (immutable decision)
↓ read-only handoff to R9
```

There is **no EXECUTE outcome** in this flow. The closed decision vocabulary
is exactly:

| Decision | Meaning |
|---|---|
| `ALLOW_RECOMMENDATION` | The recommendation may be voiced as an approved recommendation until `validUntil`, under the bound policy version. Advisory only. |
| `REVIEW_REQUIRED` | A bound human approval is required before the recommendation may be voiced. |
| `BLOCK` | The recommendation must not be voiced. Durable, auditable, immutable. |

## 3. The governance decision record (F1)

| Field | Type | Notes |
|---|---|---|
| `governanceDecisionId` | `sgd1:<sha256>` | Deterministic; unique convergence anchor `(userId, governanceDecisionId)`. |
| `businessId` | number | Owning business, re-verified from the durable businesses row every call. |
| `proposalId` | string | Client-proposed logical identity (`^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$`). |
| `proposalType` | string | The closed recommendation type (§4). |
| `evidenceRefs[]` | string[] | Opaque evidence references; resolved server-side only. |
| `sourceTrustClass` | closed enum | Server-derived aggregate evidence trust (§5). |
| `confidenceClass` | closed enum | Derived confidence = `min(claimed, evidence ceiling)` (§6). |
| `strategicRiskClass` | closed enum | Server-derived strategic risk (§7). |
| `policyVersion` | string | Immutable code-level policy artefact that decided this. |
| `decision` | closed enum | `ALLOW_RECOMMENDATION` / `REVIEW_REQUIRED` / `BLOCK`. |
| `reasonCodes[]` | closed enum[] | ≤ 8 per record, deterministic order. |
| `approvalRequired` | boolean | True exactly when `decision = REVIEW_REQUIRED`. |
| `approvalReference` | binding \| null | `approvalBinding`: decision + policy + proposal fingerprint + evidence fingerprint + expiry. |
| `validUntil` | ISO 8601 \| null | Decision validity window. |
| `evidenceFingerprint` | `sha256` | Binds the ordered refs to their server-derived trust classes. |
| `proposalFingerprint` | `sha256` | Binds the material proposal fields. |
| `createdAt` / `evaluatedAt` | ISO 8601 | Persistence/evaluation timestamps (verbatim text). |

Plus `contractVersion` (`strategic-governance/v1`), `engineVersion`
(`strategic-governance-engine/v1`), `userId`, `evaluationFingerprint`, and a
bounded `thresholds` snapshot. Rows are **insert-only and immutable**;
corrections are new decisions. Exactly one `strategic_governance_decision`
audit event per inserted decision; replays/convergence emit zero.

## 4. Closed recommendation taxonomy (F2)

```
STRATEGIC_OBSERVATION
STRATEGIC_HYPOTHESIS
MARKET_RESPONSE_RECOMMENDATION
BUSINESS_PRIORITY_RECOMMENDATION
CHANNEL_STRATEGY_RECOMMENDATION
AUDIENCE_STRATEGY_RECOMMENDATION
PRODUCT_MARKETING_RECOMMENDATION
OPPORTUNITY_RESPONSE_RECOMMENDATION
RISK_RESPONSE_RECOMMENDATION
RESOURCE_PRIORITY_RECOMMENDATION
```

Unknown type → `BLOCK` (`UNKNOWN_RECOMMENDATION_TYPE`). There are deliberately
**no direct execution types**: nothing in this vocabulary launches campaigns,
mutates strategy, moves budget, edits Business DNA, or invokes providers.
Impact descriptors that *imply* execution (e.g. "budget materiality") are
declared as proposal material and only ever **raise** governance risk.

## 5. Evidence & source-trust governance (F3)

Closed trust classes (server-derived, never client-supplied):

```
AUTHORITATIVE_INTERNAL  >  VERIFIED_EXTERNAL  >  CORROBORATED_EXTERNAL
>  SINGLE_EXTERNAL_SOURCE  >  UNVERIFIED  >  CONTRADICTED  >  MALFORMED
```

Derivation (deterministic, from the canonical tenant-scoped evidence record):
`MODEL_GENERATED` → never source truth (best `UNVERIFIED` +
`MODEL_GENERATED_NOT_SOURCE_TRUTH`); active contradiction → `CONTRADICTED`;
`INTERNAL_AUTHORITATIVE` → `AUTHORITATIVE_INTERNAL`; external source on the
**server-side** registered-source registry → `VERIFIED_EXTERNAL`; ≥ 2
independent corroborating sources → `CORROBORATED_EXTERNAL`; exactly 1 →
`SINGLE_EXTERNAL_SOURCE`; no provenance → `UNVERIFIED`; absent/forged/cross-tenant
resolution → blocked (`CROSS_TENANT_EVIDENCE`).

Rules enforced: an unverified external source can never silently become a
strategic fact (confidence ceiling `LOW`); single-source claims carry bounded
confidence (`LOW` ceiling); contradictions remain visible (they cap confidence
at `NONE` and annotate the decision); stale evidence (older than the policy
freshness window) cannot justify a current recommendation — conservative
handling (review for low/medium impact, block for high impact); model-generated
content is never source evidence. **A source can never mark itself trusted** —
the registry is server-side only.

## 6. Confidence

Closed scale `NONE < LOW < MEDIUM < HIGH` (aligned with R7-B). The client may
supply a *claimed* confidence; the decision records the **derived** confidence
`= min(claimed, evidence-implied ceiling)`. Any bounding is visible
(`CONFIDENCE_BOUNDED_BY_EVIDENCE`). Policy floors: below
`minConfidenceForAutonomousRecommendation` no autonomous recommendation is
allowed; below `minConfidenceForHighImpact` a HIGH/CRITICAL claim cannot
proceed without review.

## 7. Strategic risk classification (F4)

Closed classes `LOW < MEDIUM < HIGH < CRITICAL`. Base ordinal derives from the
recommendation type (§4); declared impact descriptors (`budgetMateriality`,
`marketEntryExit`, `sensitiveAudienceChange`, `reputationalRisk`,
`brandPositioningChange`, `highUncertainty`, `externalReliance` × weak external
evidence) each only **raise** it; prompt-injection suspicion raises it further.
No client/agent can supply or lower a risk class. Dispositions under the
default policy: LOW → `ALLOW_RECOMMENDATION`; MEDIUM/HIGH → `REVIEW_REQUIRED`;
CRITICAL → `BLOCK`. HIGH/CRITICAL never autonomously become consumable, and
even when approved remain advisory only.

## 8. Human review & approval (F5)

REVIEW_REQUIRED decisions route to the existing governed approval ledger
(`approval_requests`, `approvalType = "strategic_recommendation"` — provisional
0036 enum extension). The approval binds: business, exact recommendation
(proposal fingerprint), evidence snapshot (evidence fingerprint), confidence,
risk, source trust, policy version, and expiry
(`approvalBindingHash = sha256(decisionId, policyVersion, proposalFingerprint,
evidenceFingerprint)`).

Independent human presence is proven via the governed out-of-band email OTP
primitive (purpose `review_authorization`, single-use, expiring) bound to the
exact `governanceDecisionId` — a tenant JWT alone can never authorize, because
runtime agents hold the tenant JWT and cannot observe the emailed code.

Rejected by construction: generic approval, stale approval (expired binding),
cross-business replay, cross-proposal replay, modified recommendation after
approval (fingerprint/hash mismatch), agent self-approval, client-fabricated
human approval. **Even an approved recommendation remains recommendation
authority only** — execution belongs to R9+ governed capabilities.

## 9. Client boundary

`z.strictObject` router inputs reject every client-supplied authority field:
`decision`, `riskClass`, `strategicRiskClass`, `confidenceClass`,
`sourceTrustClass`/`trustClass`, `reasonCodes`, `approvalRequired`,
`approvalStatus`, `approved`, `executable`, `policyVersion`,
`governanceDecisionId`, `evidenceFingerprint`, `evaluationFingerprint`,
`forceAllow`, `forceApprove`, `setTrusted`, `overrideRisk`, `overridePolicy`,
`promoteTrust`, `lowerRisk`, `raiseConfidence`, … Clients supply proposal
material and reference ids only. Any such field → `CLIENT_AUTHORITY_FIELD_REJECTED`.

## 10. External misinformation / prompt-injection governance (F6)

External sources are assumed able to contain false facts, SEO spam, malicious
instructions, prompt injection, fabricated competitor claims, manipulated
reviews and poisoned content. Containment by construction:

- no external content can alter system/developer instructions (no LLM in the
  governance decision path — the engine is deterministic rules);
- no external content can invoke tools (this stream exposes no execution or
  tool surface; injection-shaped content only raises risk and annotates
  `PROMPT_INJECTION_SUSPECTED`);
- no external content can change governance rules (policy is code-level
  immutable registry; no mutation endpoint);
- no external content can expose secrets (no secret access; audit metadata
  hygiene strips sensitive keys);
- no external content can change business authority (ownership re-verified
  server-side every call);
- a source cannot mark itself trustworthy (trust is server-derived; the
  registry is server-side);
- a source cannot create recommendations directly (only governed evaluation
  mints decisions);
- source content stays inert evidence — never executed, never privileged.

## 11. Authority separation (F7)

No code path in this stream performs or triggers: campaign launch, strategy
mutation, budget increase, Business DNA mutation, provider/payment/billing
execution. The downstream consumption gate
(`assertStrategicRecommendationConsumable`) returns, at most,
`authorityScope: "RECOMMENDATION_ONLY"` and carries no campaign, strategy,
budget, DNA, provider, or billing fields. R9 and later capabilities may plan or
execute only through their own separate governed authorities.

## 12. Operations & recovery (F8)

`getOperationsProjection` exposes a truthful read-only view: proposal,
recommendation type, evidence class, confidence, strategic risk, governance
decision, blockers, approval status, expiry/staleness, source trust, policy
version — derived from immutable rows (staleness/expiry computed, never
stored). Recovery is narrow, closed-vocabulary (`operator_acknowledged` /
`operator_requeued` / `operator_dismissed`), audit-only. There is deliberately
no `forceAllow`, `forceApprove`, `setTrusted`, `overrideRisk`, or
`overridePolicy` anywhere in this stream.

## 13. Audit

Every inserted decision emits exactly one `strategic_governance_decision`
audit event; every recovery emits one `strategic_governance_recovery` event;
convergence/replay paths emit zero. Metadata carries ids, closed labels,
classes, fingerprints and hashes only — never recommendation text, evidence
content, or model reasoning.

## 14. Failure modes (fail closed)

Missing/stale/unknown policy version; unknown recommendation type;
ownership/cross-tenant mismatch (proposal or evidence); absent/garbage evidence
authority; zero usable evidence; malformed proposal/evidence descriptor;
contradicted evidence on an autonomous path; stale evidence on a high-impact
claim; expired decision/approval; replay conflicts; unavailable OTP gateway.
Authority absence never widens autonomy.

## 15. Schema

`strategic_governance_decisions` (+ `approval_requests.approvalType` enum
extension `strategic_recommendation`). Provisional, stream-local migration
`0036_r8_f_strategic_governance_foundation` — artefact only, **NOT executed**;
R7's `0035` is never modified; R8-X owns convergence/collision.
