# LEAD AUTONOMY → BUSINESS OPTIMISATION HANDOFF CONTRACT (R6-X → R7)

> **Producer:** R6-X (Lead Autonomy integration of R6-A/B/C/D/E/F on
> `integration/r6-lead-autonomy`)
> **Consumer:** R7 (Business Optimisation)
> **Status:** canonical handoff contract — R7 consumes, does not redefine
> **Implements:** `LEAD_AUTONOMY_CONTRACT_VERSION = "lead-autonomy/v1"`
> **Source of truth:** `docs/contracts/lead-identity-contract.md`,
> `docs/contracts/lead-scoring-contract.md`,
> `docs/contracts/lead-qualification-contract.md`,
> `docs/contracts/lead-nurture-sales-handoff-contract.md`,
> `docs/contracts/conversion-event-contract.md`,
> `docs/contracts/conversion-to-attribution-contract.md`,
> `docs/contracts/lead-governance-operations-contract.md`
> **Upstream (frozen, consumed not merged):** R5 integrated base `a947ecb`
> (`MARKETING_OPERATIONS_V1_READY`) and its contract set.

This contract defines the stable, read-only projection surface through which
R7 may consume the integrated Lead Autonomy system. R6 proves the connected
lifecycle (R5 opportunity → canonical identity → scoring → governed
qualification → nurture/handoff → conversion → governance). **R7 owns
attribution, experimentation, conversion learning, budget optimisation and
portfolio optimisation. R6 does not perform, imply, or pre-empt any of
those.** All R6 statements are evidence; all R6 outcomes are observed, never
causal.

---

## 1. Canonical lead identity (R6-A)

- `leadId` — `"lid1:" + sha256(identityKey)`, deterministic, server-minted,
  tenant-bound, immutable (lead-identity contract §1). R7 treats it as an
  opaque immutable reference; joins are verbatim.
- Identity lineage: `lead_identity_provenance` (immutable, append-only;
  `kind ∈ {opportunity_handoff, identity_evidence, merge, conflict}`),
  `lead_identity_merges` (`canonicalLeadId`, `absorbedLeadId`,
  `linkingEvidenceType/Hash`). Merged identities resolve through
  `canonicalLeadId` chains; absorbed identities are terminal.
- Status vocabulary: `active, anonymous, partially_identified, resolved,
  conflicting, suppressed, merged, archived`. `suppressed`/`archived` are
  non-actionable everywhere downstream.
- Read surface: tRPC `leadIdentity.get/list` projections (14 keys,
  hash-only identity — no raw PII exists anywhere in R6-A).
- **R7 must never re-derive identity, force merges, or correlate across
  tenants.** Identity confidence (`unknown<low<medium<high`) is an evidence
  class, not intent.

## 2. Scoring history (R6-B)

- `lead_score_snapshots` — immutable, append-only; one score per
  `(userId, leadId, evidenceSnapshotHash, scoringVersion)`;
  `leadScoreId` (`lsc1:`) stable and deterministic.
- R7-consumable fields: `overallScore`, `scoreBand`, `scoreConfidence`,
  component scores, `componentWeights`, `reasonCodes` (closed vocabulary),
  `evidenceSnapshotHash/Id`, `computedAt`, `leadIdentityVersion`.
- **A score is evidence, never authority.** R7 must not read score magnitude
  as qualification, permission, or conversion probability. R6-B scores the
  legacy numeric `leads.id` representation (see §8).

## 3. Qualification decision + history (R6-C)

- `lead_qualifications` — immutable, insert-only; unique
  `(userId, qualificationId)`; `qualificationId` (`lqu1:`) deterministic
  over identity reference + score content hash + policy version.
- Decisions: `QUALIFIED, NOT_QUALIFIED, REVIEW_REQUIRED,
  INSUFFICIENT_EVIDENCE, BLOCKED`; `reasonCodes`, `confidenceScore`,
  `evaluatedAt`, `validUntil` (decisions expire; freshness is part of truth).
- `lead_qualification_reviews` — one review per decision, CAS-guarded,
  `status ∈ {pending, progress_authorized, progression_rejected}`;
  resolution requires independent human OTP proof (never self-approved).
- Handoff projection (`mayProgress`, `progressBlockedReason`) is a safe read
  view for downstream; it is not authority R7 must re-check.

## 4. Nurture / sales-handoff events (R6-D)

- `nurture_handoff_decisions` — immutable; `nurtureDecisionId` (`nd1:`),
  `decisionKey` (world-state hash); `decision ∈ {NURTURE, SALES_HANDOFF,
  BLOCKED, NO_ACTION, WAIT, REVIEW_REQUIRED}`; `reasonCodes` (closed);
  `channel`, `approvalRequired`, `conversionStopped`, `policyVersion`,
  `validUntil`.
- `sales_handoffs` — lifecycle `PREPARED → APPROVAL_REQUIRED → APPROVED →
  DISPATCH_PENDING → DISPATCHED/ACKNOWLEDGED`, `FAILED`, `BLOCKED`,
  `CANCELLED`; CAS-guarded; approval-bound (`approvalType = sales_handoff`
  on the shared `approval_requests` ledger, `context.salesHandoffBinding`).
- `handoff_dispatch_receipts` — append-only, `executionIdentity` unique,
  `outcome ∈ {ACCEPTED, REJECTED, FAILURE}`; receipts are execution
  evidence, not provider truth beyond their bounded labels.
- `nurture_touch_records` — append-only, exact-once per `(userId,
  touchIdentity)`; cadence-bounded.
- **Provider truth (preserved):** WhatsApp UNSUPPORTED; SMS UNSUPPORTED;
  CRM UNSUPPORTED; Email REQUIRES_CONFIGURATION. Only the explicitly
  fake/test-only transport is dispatchable, and only in tests. R7 must not
  treat any D execution record as evidence of a real external contact.

## 5. Conversion outcomes (R6-E)

- Consumed through the frozen R6-E→R7 projection
  (`docs/contracts/conversion-to-attribution-contract.md`,
  `conversion-to-attribution/v1`): `conversionId`, `sourceSystem`,
  trust class, outcome status, monetary value (integer minor units, signed
  for reversals), reversal lineage, provenance references.
- Exact-once per `(userId, sourceSystem, externalConversionId)`;
  reversals are separate rows bound by `reversesConversionId` with one
  lifecycle event on the target.
- **R6-E never asserts causation.** R7 derives attribution on its own
  authority from this projection only; `sourceOpportunityId /
  sourceHandoffId / sourceCampaignId / sourceSignalId /
  sourcePublicationId / sourceEngagementReceiptId` are lineage references
  for R7's models, not causal claims.

## 6. Campaign / publication / opportunity provenance

- Every R6 durable record carries tenant (`userId`) and, where applicable,
  `businessId`/`campaignId`; R5 lineage references (`opp1:`/`oph1:` ids,
  `campaignId`, `publicationId`) are opaque and verbatim.
- R5 tables (`opportunity_candidates`, `opportunity_evidence`,
  `opportunity_handoffs`) are read-only to R6; R7 reads them through the R5
  contracts, never through R6 storage assumptions.

## 7. Verified monetary conversion values

- Monetary truth lives exclusively in `conversion_events.amount` (signed
  integer minor units) + `currency`, governed by the R6-E value semantics
  (canonical contract §7): server-validated bounds, credential-leak guard,
  reversal-signed. `analytics.revenue`-style aggregates are NOT monetary
  truth.
- R6-F's operations projection reports conversion state (including reversal
  status) truthfully; R7 must reconcile through the R6-E projection, not the
  projection's summaries.

## 8. Privacy-safe operational state (R6-F)

- `lead_privacy_states` — one current state per lead (numeric key), CAS-
  guarded, provenance-stamped: `ACTIVE, SUPPRESSED, RESTRICTED,
  RETENTION_PENDING, RETENTION_EXPIRED, ARCHIVED`.
- The lid1 ↔ numeric `leads.id` mapping is **score-mediated and validated**
  (R6-C chain: identity projection ← validated score → score-authoritative
  numeric key); R7 must consume it through the qualification/operations
  surfaces, never reconstruct it from bare ids.
- R7 MUST honor `SUPPRESSED/RESTRICTED/RETENTION_EXPIRED` as stop signals
  for any optimisation action that touches a lead; privacy overrides all
  R7 authorities.
- F's `projectLeadOperations` / governance reads expose blocker truth for
  portfolio views; they are operational state, not optimisation decisions.

## 9. What R7 owns (R6 does not pre-empt)

| Authority | Owner |
|---|---|
| Attribution models & causal claims | R7 |
| Experimentation design & assignment | R7 |
| Conversion learning / model feedback | R7 |
| Budget optimisation | R7 |
| Portfolio optimisation | R7 |

R6 provides: identity stability, evidence-bound scores, governed
qualification states, bounded nurture/handoff events, exact-once verified
conversions, lineage references, privacy state. Nothing more.

## 10. Invariants R7 must preserve

1. Tenant isolation: every join predicates the tenant; cross-tenant
   correlation is impossible by construction (tenant inside every identity
   hash) and must stay so.
2. Immutability: R6 tables are append-only; R7 never writes them.
3. Provenance: any R7 output that cites a lead fact must carry the R6
   identity/evidence references it was derived from.
4. Privacy: suppression/restriction/expired retention is a hard stop.
5. No causal language for R6 evidence: scores, decisions and conversions
   are observed states; only R7 may attach modelled attribution.
6. Provider truth: no real provider activation exists in R6; R7 must not
   assume outreach happened on the basis of D decision rows alone.

---

**R7 consumes lead autonomy through this contract. Do not redefine identity,
score, qualification, nurture, conversion, or privacy authority.**
