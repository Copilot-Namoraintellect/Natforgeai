# OPPORTUNITY → LEAD AUTONOMY CONTRACT (WBS-R5-D → R6)

> **Producer:** R5-D (Opportunity Detection), branch `feature/r5-d-opportunity-detection`
> **Consumer:** R6 (Lead Autonomy)
> **Status:** canonical handoff contract — R6 consumes, does not redefine
> **Implements:** `HANDOFF_ENVELOPE_VERSION = "opportunity-to-lead-autonomy/v1"`
> **Source of truth:** `docs/contracts/opportunity-candidate-contract.md` (R5-D
> canonical candidate contract) + `api/lib/opportunity/detector.ts` `handoffToR6`
> **Upstream (frozen, consumed not merged):** R5-A @ `c9a930e`, R5-B @ `b939328`,
> R5-E @ `c936caa`, R5-F @ `5800626`

This contract defines the durable, exactly-once handoff from R5 opportunity
detection to R6 lead autonomy. **R5-D never creates the R6 lead.** It produces
an immutable, evidence-referenced handoff envelope that R6 may consume later,
on R6's own authority and schedule.

---

## 1. Opportunity identity

- `opportunityId` — `"opp1:" + sha256(threadCoordinates)`, server-minted only,
  deterministic, tenant-anchored (contract §1). Stable for the life of the
  thread; R6 must treat it as an opaque immutable reference.
- `opportunityKey` — 64-hex thread identity; provided for idempotency/dedupe
  correlation only.

## 2. Source signal identity

- `signalId` (R5-A `signalKey`, opaque), `signalVersion` per evidence entry in
  the envelope manifest. R6 must not re-derive or re-interpret signal identity.

## 3. Source interpretation identity

- `interpretationId` per evidence entry; bound to `signalId`/`signalVersion`
  and the R5-B `classifierVersion` list (`classifierVersions`). R6 must not
  re-run or mutate interpretations; reinterpretation is R5-B-only (new
  versioned rows).

## 4. Optional engagement evidence

- Evidence entries of kind `engagement_receipt` carry
  `engagementReceiptId` (R5-C seam, contract §13). Absent until R5-C
  convergence; basic handoff validity never depends on it.

## 5. Opportunity types

Closed set (candidate contract §3): `purchase_interest, service_enquiry,
demo_or_consultation_interest, partnership_interest, repeat_interest,
retention_risk, churn_risk, referral_or_advocacy,
unresolved_complaint_opportunity, support_to_sales_transition, unknown`.
v1 emits only: `purchase_interest, service_enquiry, partnership_interest,
retention_risk, unresolved_complaint_opportunity, referral_or_advocacy,
support_to_sales_transition`. R6 must handle the full closed set
gracefully (reserved labels may appear from future governed rule versions)
but must not treat any label as a qualification decision.

## 6. Opportunity states

Closed set (contract §4): `candidate, strengthening, weak, suppressed,
expired, escalated, handed_off_to_r6`. **There is no sales-qualified state in
R5.** Handoff requires an active status at envelope time
(`opportunityStatusAtHandoff` records which).

## 7. Confidence / evidence semantics

- `confidenceClass`, `evidenceStrength` ∈ `LOW|MEDIUM|HIGH|UNKNOWN` —
  bounded deterministic ordinals (contract §6), **not calibrated
  probabilities**. Derivation axes: explicitness, repetition, validated
  engagement response, recency, contradictions.
- **R6 must not treat R5 opportunity confidence as a sales qualification
  decision, a lead score, or outreach permission.** R6 derives its own.
- `evidenceCount`, `contradictionCount`, `firstObservedAt`, `lastObservedAt`
  are provided so R6 can weight recency/coverage with full visibility.

## 8. Aggregation rules

One logical thread → one candidate (contract §1): tenant + business +
opportunityType + actorKey + threadKey + topicKey. Evidence aggregation is
immutable append-only; strength recomputes deterministically over in-window
evidence. R6 must not merge candidates across threads or tenants; apparent
duplicates are distinct threads by construction.

## 9. Expiry rules

`evidenceWindowMs` (default 7d, server-configured). Active candidates whose
`lastObservedAt` predates `now − window` transition to `expired` via the
deterministic sweep (contract §10). R6 must check `opportunityStatusAtHandoff`
and `lastObservedAt` before acting; expired envelopes are historical context,
not actionable signals.

## 10. Suppression rules

Suppression reasons (contract §9): `SAFETY_ESCALATION, RISK_GATED,
POLICY_SUPPRESSED, NOT_OPPORTUNITY_SIGNAL, INSUFFICIENT_CLASSIFICATION,
NO_OPPORTUNITY_CLASSIFICATION, LOW_RELEVANCE, FLOOD_GUARDED`. Suppressed/
escalated candidates are not handoff-eligible (transition table rejects
them). R6 must not resurrect suppressed threads without new authoritative
evidence.

## 11. R6 handoff identity

- `handoffId = "oph1:" + sha256(canonicalJson({handoffEnvelopeVersion,
  opportunityId, opportunityKey, userId, businessId, opportunityType,
  confidenceClass, evidenceStrength, urgency, topicKey, actorKey, threadKey,
  campaignId, publicationId, evidenceCount, detectorRulesVersion,
  classifierVersions, evidenceSnapshotHash, handedOffAt }))` — deterministic,
  server-minted, immutable.
- Durable unique keys: `(userId, opportunityId)` and `handoffId` on
  `opportunity_handoffs` → **exactly-once**. Replay returns the existing
  envelope with `duplicateClassification: "idempotent_replay"`.

## 12. Immutable evidence

The envelope embeds a bounded evidence manifest: per entry
`{ interpretationId, signalId, signalVersion, occurredAt }` plus
`evidenceSnapshotHash = sha256(canonicalJson(manifest))`. Evidence rows in
`opportunity_evidence` are append-only and hash-verified; any drift fails
closed (`OPPORTUNITY_EVIDENCE_CONFLICT`). R6 must treat the manifest as
read-only provenance.

## 13. External actor reference restrictions

`externalActorReference` is **always null** in R5-D storage and envelopes.
The actor exists only as `actorKey` (sha256 of provider|platform|
actorReference). R6 must not demand, reconstruct, or enrich raw actor
identity from R5 artifacts; provider lookups happen on R6's own governed
integration authority, if at all.

## 14. Privacy / PII restrictions

- Envelopes carry references and closed-vocabulary labels only: **no social
  text, no actor handles/display names, no provider payloads, no tokens, no
  model reasoning.**
- `userId`/`businessId`/`campaignId` are internal ids, not personal data.
- R6 inherits the minimization duty: do not expand retained PII beyond this
  envelope without a governance decision (R5-E/F authority).

## 15. Fields R6 may consume

`handoffId, handoffEnvelopeVersion, opportunityId, opportunityKey,
opportunityType, opportunityStatusAtHandoff, confidenceClass,
evidenceStrength, urgency, topic (≤48-char navigation hint), topicKey,
actorKey, threadKey, campaignId, publicationId, provider, evidenceCount,
contradictionCount, firstObservedAt, lastObservedAt, detectorRulesVersion,
classifierVersions, evidence[] (manifest), evidenceSnapshotHash,
businessId, userId, handedOffAt`.

## 16. Fields R6 must derive itself

Lead identity and dedupe keys; lead score and scoring rationale;
qualification/pipeline status; CRM record creation and ownership; consent
and lawful-basis checks; outreach/nurture decisions and content; identity
resolution beyond the opaque `actorKey`; any statistical confidence.

## 17. Fields R6 must not mutate

All of them. Handoff envelopes and R5 evidence are immutable durable
records. R6 state lives in R6-owned tables keyed by `handoffId`/
`opportunityId`. Corrections are new R6 records, never edits to R5 rows
(R5 tables are not shared-writable).

## 18. Exact-once handoff semantics

1. `handoffToR6` validates tenant ownership, requires an active status,
   builds the envelope, and inserts `opportunity_handoffs` under the unique
   `(userId, opportunityId)` anchor.
2. A raced or retried call re-reads and returns the existing envelope —
   no duplicate handoff ever exists for one opportunity.
3. The candidate transitions to `handed_off_to_r6` (CAS-guarded); envelope
   durability is the exactly-once anchor, so a failed CAS can at worst leave
   the status to converge on next read — never a second envelope.
4. Post-handoff evidence remains recorded immutably but cannot reopen the
   candidate or mint another handoff.

## 19. Schema dependencies

- `opportunity_candidates`, `opportunity_evidence`,
  `opportunity_suppressions`, `opportunity_handoffs` — provisional migration
  `0030_opportunity_detection_foundation` (**artefacts only, not executed**).
  R5-X owns canonical sequencing after the A/B/E provisional `0029`
  collision; R6 must not execute or renumber migrations itself.
- R6's own tables are R6-owned; no FK constraints couple to R5 tables
  (repo convention: enforcement in query predicates).

## 20. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Handoff producer | `api/lib/opportunity/detector.ts` (`handoffToR6`), `opportunity-store.ts` | R5-D owned |
| Candidate contract | `docs/contracts/opportunity-candidate-contract.md` | R5-D owned |
| Lead/CRM (R6 territory today) | `api/lead-router.ts`, `api/lib/agents/audience-intelligence-agent.ts` | R5-D never writes; R6 evolves |
| Audience aggregation | `api/lib/audience/ingest.ts` | read-only for both streams |
| Router registry | `api/router.ts` | additive only |
| Governance bridge | `api/lib/governance/*` (R5-F) | F bridges to R5-D tables at R5-X |

## 21. Security invariants

1. Tenant isolation: `userId` anchors every identity and query; R6 consumes
   envelopes only within the owning tenant's scope.
2. No client-supplied authority: identity, confidence, status, and handoff
   envelopes are server-minted; strict schemas reject injected fields.
3. Exactly-once, replay-safe, fail-closed on hash drift or stale CAS.
4. Candidate ≠ lead: consuming an envelope authorizes nothing by itself;
   R6 actions remain governed by R5-E policy and R6's own gates.
5. Privacy minimization: hash-only actor identity; no raw PII, payloads,
   tokens, or model reasoning cross this boundary.
6. Injection resistance: closed vocabularies + strict schema at every seam;
   social text never enters the detection or handoff path.

---

**R6: consume handoff envelopes through this contract. Derive your own lead
identity, score, and qualification. Opportunity confidence is evidence
class, not sales permission.**
