# CANONICAL OPPORTUNITY CANDIDATE CONTRACT (WBS-R5-D D1)

> **Stream:** WBS-R5 Stream D — Opportunity Detection
> **Module authority:** `api/lib/opportunity/`
> **Schema:** `opportunity_candidates`, `opportunity_evidence`,
> `opportunity_suppressions`, `opportunity_handoffs`
> (provisional migration `0030_opportunity_detection_foundation` — artefacts
> only, **not executed**; R5-X owns canonical sequencing)
> **Upstream (frozen, consumed not merged):**
> R5-A signal contracts @ `c9a930e`; R5-B intelligence contracts @ `b939328`
> (`docs/contracts/social-intelligence-contract.md`,
> `docs/contracts/intelligence-to-engagement-opportunity-contract.md`);
> R5-E policy contract @ `c936caa`; R5-F governance contract @ `5800626`
> **Audience:** R5-X integration, R5-C (engagement evidence producer), R6
> (lead autonomy — consume via `opportunity-to-lead-autonomy-contract.md`)
> **Status:** authoritative as of the R5-D acceptance harness

This contract defines the single canonical opportunity-candidate model. R5-D
owns **opportunity-candidate detection only**: rule-first evaluation of R5-B
interpretations, governed evidence aggregation, deterministic confidence,
deduplication, lifecycle, and durable exact-once handoff to R6. It does **not**
own social listening (R5-A), interpretation (R5-B), engagement execution
(R5-C), policy semantics (R5-E), lead identity, lead scoring, CRM records,
outreach, nurture, conversion, or sales pipeline management (R6).

**Required principle:** an opportunity candidate is an evidence-backed
marketing/business signal, **not yet a lead**. R6 decides identity, scoring,
qualification, and downstream sales action.

---

## 1. Candidate identity (deterministic, server-derived, tenant-anchored)

One logical opportunity thread → one durable opportunity candidate.

```
threadCoordinates = {
  tenantUserId,        // users.id — tenant anchor, NEVER null, NEVER client-supplied
  businessId,          // businesses.id | null (mirrors R5-B §3; null = unattributed, tenant-scoped)
  opportunityType,     // closed vocabulary §3
  actorKey,            // sha256(provider | platform | actorReference) | "no-actor"
  threadKey,           // sha256(parentExternalObjectId | externalObjectId) | "no-thread"
  topicKey             // sha256(topics sorted, joined) | "no-topic"
}
opportunityKey = sha256(canonicalJson(threadCoordinates))     // 64 hex, no wall-clock
opportunityId  = "opp1:" + opportunityKey                     // opaque, server-minted only
```

- Coordinates are derived **server-side** from the accepted interpretation
  record only. Clients can never supply or influence identity; there is no
  client-controlled idempotency key.
- `actorKey` binds provider+platform+actorReference as one opaque hash; the raw
  actor reference is **never** persisted in R5-D tables (privacy §12).
  `threadKey` binds the R5-A threading reference (`parentExternalObjectId`,
  falling back to `externalObjectId`) — authoritative thread linkage only;
  no probabilistic identity resolution across unrelated users is ever
  performed.
- `topicKey` binds R5-B `topics` (sorted, joined); the same actor with an
  unrelated topic produces a **distinct** candidate (D4 case 6). One display
  `topic` (first topic, ≤48 chars) is denormalized onto the candidate for
  operator readability; it is a navigation hint, never authority.
- `userId` participates in every natural key and every query predicate. The
  same external actor under two tenants produces unrelated identities — no
  cross-tenant correlation is possible (adversarial case 13).
- The DB enforces uniqueness of `(userId, opportunityKey)`
  (`oc_user_opportunity_uidx`). Duplicate delivery, concurrent delivery, and
  repeated evaluation converge to **one durable row** (§7).

## 2. Candidate record

```ts
OpportunityCandidate {
  opportunityId: string;               // "opp1:" + 64 hex — canonical identity
  opportunityKey: string;              // 64 hex thread identity (§1)
  contractVersion: "opportunity-candidate/v1";
  userId: number;                      // server-resolved tenant owner
  businessId: number | null;           // server-validated ownership; never fabricated
  opportunityType: OpportunityType;    // §3
  opportunityStatus: OpportunityStatus;// §4
  confidenceClass: ConfidenceClass;    // §6 (bounded, deterministic)
  evidenceStrength: EvidenceStrength;  // §6 (bounded, deterministic)
  urgency: "low" | "normal" | "high" | "critical";  // max over evidence
  topic: string | null;                // display hint ≤48 chars; not authority
  topicKey: string;                    // identity coordinate
  actorKey: string;                    // identity coordinate (hash only)
  threadKey: string;                   // identity coordinate (hash only)
  campaignId: number | null;           // evidence lineage, ownership-validated
  publicationId: string | null;        // evidence lineage where authoritative (else null)
  provider: "meta" | "linkedin" | "twitter" | "tiktok" | null;  // evidence lineage
  externalActorReference: null;        // ALWAYS null in R5-D — see §12
  firstEvidence: EvidenceRef;          // first accepted evidence (§5)
  latestEvidence: EvidenceRef;         // most recent accepted evidence (§5)
  firstObservedAt: string;             // min evidence occurredAt (ISO, provider time)
  lastObservedAt: string;              // max evidence occurredAt (ISO, provider time)
  evidenceCount: number;               // distinct accepted evidence rows
  contradictionCount: number;          // evidence entries contradicting the type
  detectorRulesVersion: "opportunity-detector/v1";
  classifierVersions: string[];        // immutable record of B classifier versions seen
  version: number;                     // optimistic CAS guard (starts 1)
  createdAt: string;                   // single clock read at persistence boundary
  updatedAt: string;                   // single clock read at the updating boundary
  statusChangedAt: string;             // single clock read at the last status change
  handedOffAt: string | null;
}
```

`EvidenceRef = { interpretationId, signalId, signalVersion, occurredAt }` —
references only; no social text, ever.

## 3. Opportunity types (closed)

```
purchase_interest, service_enquiry, demo_or_consultation_interest,
partnership_interest, repeat_interest, retention_risk, churn_risk,
referral_or_advocacy, unresolved_complaint_opportunity,
support_to_sales_transition, unknown
```

Emitted only by the versioned rule table (§8). Labels unsupported by actual
evidence are never minted: in `opportunity-detector/v1` the emitted set is
`purchase_interest, service_enquiry, partnership_interest, retention_risk,
unresolved_complaint_opportunity, referral_or_advocacy,
support_to_sales_transition` (+ `unknown` reserved for aggregation ambiguity).
`demo_or_consultation_interest`, `repeat_interest`, `churn_risk` are reserved
for a future governed rule version — v1 never fabricates them from keyword
matching. A client attempting to supply any type is rejected by the strict
schema before processing (adversarial case 18).

## 4. Opportunity status (closed — pre-lead lifecycle)

```
candidate, strengthening, weak, suppressed, expired, escalated,
handed_off_to_r6
```

There is **no sales-qualified status in R5**. Semantics:

| Status | Meaning |
|---|---|
| `candidate` | Active; evidence strength MEDIUM or HIGH, in window, no gating contradiction. |
| `weak` | Active; evidence strength LOW or UNKNOWN (single/weak/low-confidence evidence). Never auto-actionable. |
| `strengthening` | Confidence class increased due to new evidence (last transition was upward). |
| `suppressed` | Explicitly suppressed (operator, policy, spam reclassification). Terminal until explicit unsuppress (restores `weak`) or expiry. |
| `expired` | Evidence window lapsed (§10). Revivable by new in-window evidence. |
| `escalated` | Safety escalation (§9). Not machine-actionable; not R6-handoff eligible. |
| `handed_off_to_r6` | Exactly-once handoff envelope recorded (§11). Terminal for R5. |

## 5. Evidence (immutable, append-only)

```ts
OpportunityEvidence {
  id: serial;                          // row pointer only
  candidateId: number;                 // FK-by-convention to opportunity_candidates.id
  userId: number;                      // tenant anchor
  interpretationId: string;            // R5-B identity — UNIQUE (one interpretation →
                                       //   at most one candidate contribution)
  signalId: string;                    // R5-A signalKey (opaque)
  signalVersion: number;
  kind: "signal_interpretation" | "engagement_receipt";
  engagementReceiptId: string | null;  // set iff kind = engagement_receipt (R5-C seam §13)
  opportunityTypeAtEvaluation: OpportunityType;  // rule output for this evidence
  intent: IntentLabel;                 // R5-B label as evaluated (immutable copy)
  overallConfidence: ConfidenceLabel;  // R5-B label as evaluated (immutable copy)
  relevance: RelevanceLabel;           // R5-B label as evaluated (immutable copy)
  sentiment: SentimentLabel;           // R5-B label as evaluated (immutable copy)
  urgency: UrgencyLabel;               // R5-B label as evaluated (immutable copy)
  sourceCampaignId: number | null;
  occurredAt: string;                  // provider event time from the interpretation
  contributesToStrength: boolean;      // false for contradiction/backfill entries
  evidenceHash: string;                // sha256 over the canonical evidence fragment
  createdAt: string;
}
```

- Evidence rows have **no update path** (R5-A §5 discipline). `evidenceHash`
  proves byte-stability; drift between retained evidence and its hash is
  tampering evidence and fails closed.
- Replay of an already-accepted `interpretationId` returns the existing
  outcome (`idempotent_replay`) — no second candidate, no second suppression,
  no second audit event (§7).
- Engagement-receipt evidence is **optional enrichment** (D7): it can raise
  confidence, never creates a candidate by itself, and must pass the R5-C seam
  validation (§13) — forged receipts fail closed (`FORGED_EVIDENCE`).

## 6. Confidence / evidence strength (bounded, deterministic — never a probability)

Closed ordinals with explicit derivation: `LOW < MEDIUM < HIGH`; `UNKNOWN` =
no usable basis. `confidenceClass` and `evidenceStrength` are **bounded honest
classes**, not calibrated probabilities; no arithmetic is performed on them and
neither a client nor an external model can set them (adversarial case 17).

`evidenceStrength` (pure function over in-window evidence, §8 rules):

| Class | Exact rule (in-window evidence set E) |
|---|---|
| `HIGH` | `contradictionCount = 0` AND `repeatSignal` (≥2 distinct interpretations) AND (`explicitHigh` present OR (`explicitMedium` present AND `engagementBoost` present)) |
| `MEDIUM` | `contradictionCount = 0` AND (`explicitHigh` present OR (`explicitMedium` present AND `repeatSignal`) OR (`explicitMedium` AND `engagementBoost`) OR (`repeatSignal` AND ≥1 engagement-receipt evidence)) |
| `LOW` | Any qualifying evidence not reaching MEDIUM (e.g. a single weak/low-confidence signal), or any evidence with `contradictionCount > 0` (capped) |
| `UNKNOWN` | No qualifying evidence basis |

where, over R5-B labels copied onto the evidence rows:
- `explicitHigh` = evidence with mapped type ∈ {purchase_interest,
  service_enquiry, partnership_interest, support_to_sales_transition,
  unresolved_complaint_opportunity, referral_or_advocacy} AND
  `overallConfidence = high` AND `relevance = relevant`.
- `explicitMedium` = same type set AND `overallConfidence = medium` AND
  `relevance ∈ {relevant, partially_relevant}`.
- `engagementBoost` = ≥1 engagement-receipt evidence (validated §13).
- `repeatSignal` = ≥2 distinct in-window interpretations.
- Contradiction = evidence whose R5-B labels undermine the candidate type:
  `sentiment = negative` OR `intent ∈ {objection, complaint,
  cancellation_or_churn_signal}` (for non-retention types), counted
  deterministically at append time.

`confidenceClass = min(evidenceStrength, recencyCap)` where `recencyCap`
degrades with age of `lastObservedAt` relative to the configured evidence
window (§10): age < ½ window → no cap; ½–1 window → capped at MEDIUM; beyond
window → candidate is `expired`. Confidence **increases only via new accepted
evidence** and **decreases/expiry only via deterministic lifecycle rules** —
never via client input.

## 7. Replay / idempotency / concurrency semantics

| Scenario | Behavior |
|---|---|
| Same interpretation re-evaluated | Idempotent replay of the recorded outcome (candidate evidence or suppression); no new rows, no audit re-emit. |
| Concurrent evaluation of same interpretation | Unique `interpretationId` on evidence + suppressions serializes; one winner, loser re-reads. |
| Concurrent candidate creation (same thread) | Unique `(userId, opportunityKey)` serializes; loser re-reads and appends evidence. |
| New evidence on existing candidate | Strengthens in place (CAS `version` guard); never a duplicate candidate. |
| Same actor, different tenant | Distinct identities (§1); never correlated. |
| Same actor, unrelated topic | Distinct `topicKey` → distinct candidate (D4 case 6). |
| Detector rules version change | New evaluations use the new version; historical rows keep the version that produced them; identity is version-independent (history preserved). |
| Stale/out-of-order evidence | Appended immutably with its own `occurredAt`; state recomputed monotonically; guarded updates reject stale writes (`STALE_STATE` conflict). |
| Evidence/audit hash drift | `OPPORTUNITY_EVIDENCE_CONFLICT` / `AUDIT_FINGERPRINT_CONFLICT` fail closed. |

All convergence is **DB-authoritative** (unique keys + CAS guards). No in-memory
dedupe. No client idempotency identity.

## 8. Rule-first detection (D2) — deterministic, versioned, non-billable

`DETECTOR_RULES_VERSION = "opportunity-detector/v1"`. Rules consume **R5-B
controlled labels only** — never raw social text, never broad keyword matching
for sales intent. Rules are pure, explainable, and non-billable (no model, no
`runAgent`, no reservation, no `ai_usage` row).

Evaluation order (first match wins) after §9 gates:

| # | Condition (R5-B labels) | Outcome |
|---|---|---|
| R1 | `intent = purchase_interest` AND `relevance ∈ {relevant, partially_relevant}` | `purchase_interest` candidate |
| R2 | `intent = purchase_interest` AND `relevance = not_relevant` | suppression `LOW_RELEVANCE` |
| R3 | `intent = purchase_interest` AND `relevance = unknown` | `purchase_interest` candidate (weak by §6) |
| R4 | `intent ∈ {service_question}` OR (`product_question`) | `service_enquiry` candidate |
| R5 | `intent = information_request` AND indicator `purchase_intent_detected` | `purchase_interest` candidate (weak by §6) |
| R6 | `intent = partnership_interest` AND `relevance ≠ not_relevant` | `partnership_interest` candidate |
| R7 | `intent = partnership_interest` AND `relevance = not_relevant` | suppression `LOW_RELEVANCE` |
| R8 | `intent = cancellation_or_churn_signal` | `retention_risk` candidate |
| R9 | indicator `support_recovery_moment` AND a `complaint`/`support_request` suppression exists on the same thread coordinates within the window | `unresolved_complaint_opportunity` candidate (recovery-of-relationship signal; still pre-lead) |
| R10 | indicator `high_value_praise` AND a prior praise-class suppression on the same thread coordinates within the window | `referral_or_advocacy` candidate |
| R11 | `intent = support_request` AND indicator `purchase_intent_detected` | `support_to_sales_transition` candidate |
| R12 | `intent ∈ {praise, complaint, support_request, information_request, recruitment_or_employment, objection}` | suppression `NO_OPPORTUNITY_CLASSIFICATION` |
| R13 | `intent = unknown` | suppression `INSUFFICIENT_CLASSIFICATION` |
| R14 | `intent ∈ {spam, abuse, irrelevant}` | suppression `NOT_OPPORTUNITY_SIGNAL` |

Complaint alone never becomes a sales opportunity (R12); it becomes one only
when later authoritative evidence shows recovery (R9). Praise alone never
becomes a sales opportunity (R12); repeated evidenced praise may become
advocacy (R10).

## 9. Policy / suppression boundaries (D6)

Opportunity detection is **observational**: candidate existence is never an
authorization to contact anyone, and R5-D never initiates governed marketing
actions (R5-E §17 read-only consumption). Gates, applied before any rule:

1. `recommendedHandling = safety_escalation` OR any safety-critical risk flag
   (`self_harm_safety_concern`, `abusive_or_harassing`) → suppression
   `SAFETY_ESCALATION`; an existing candidate receiving such evidence
   transitions to `escalated`.
2. Any other gating R5-B risk flag (`legal_compliance_sensitive`,
   `privacy_sensitive`, `refund_dispute_or_complaint`, `reputational_risk`,
   `high_emotion_escalation`, `spam_or_scam`) → suppression `RISK_GATED`.
3. Explicit policy suppression supplied through the R5-E seam (a recorded
   `NO_ACTION`/suppression decision bound to the interpretation) → suppression
   `POLICY_SUPPRESSED`.
4. Volume guard: more than `maxNewCandidatesPerActorWindow` (default 10) new
   candidates for one `actorKey` within the window → suppression
   `FLOOD_GUARDED` (adversarial case 15).

An R5-E `DENY`/`ESCALATE` engagement decision on related evidence is **never**
treated as permission for outreach; `ALLOW_AUTONOMOUS` on an engagement action
is likewise never derived from a candidate. Any active downstream action
remains governed by R5-E.

## 10. Expiry / lifecycle (D8)

- Evidence window: `evidenceWindowHours` (default **168h / 7 days**),
  configured server-side; the sweep is deterministic
  (`sweepExpiredOpportunities(now)`).
- `lastObservedAt + window < now` AND status active → `expired`
  (`opportunity_state_changed` audit; CAS-guarded).
- New in-window evidence on an `expired` candidate revives it (status
  recomputed from the fresh evidence set). Expired candidates are not R6-handoff
  eligible.
- Active-window evidence strength uses only in-window evidence; out-of-window
  evidence stays immutable on the record.

## 11. R6 handoff (D8) — durable, exact-once

`handoff` is an explicit governed transition from an active
(`candidate`/`strengthening`/`weak`) status. Envelope
(`HANDOFF_ENVELOPE_VERSION = "opportunity-to-lead-autonomy/v1"`):

```
handoffId = "oph1:" + sha256(canonicalJson({ handoffEnvelopeVersion,
  opportunityId, opportunityKey, userId, businessId, opportunityType,
  confidenceClass, evidenceStrength, urgency, topicKey, actorKey, threadKey,
  campaignId, publicationId, evidenceCount, detectorRulesVersion,
  classifierVersions, evidenceSnapshotHash, createdAt }))
```

- Unique `(userId, opportunityId)` on `opportunity_handoffs` → exactly-once;
  replay returns the existing envelope (`idempotent_replay`).
- The envelope stores **references and bounded labels only** (no social text,
  no raw actor references, no model reasoning).
- R5-D never creates the R6 lead, never assigns a lead score, never creates CRM
  rows. Once handed off, R5-D treats the candidate as terminal; replays do not
  duplicate handoffs.

## 12. Privacy / sensitive-data restrictions

- Strict server-side tenant isolation: `userId` from the authenticated session
  only; `businessId`/`campaignId` ownership re-verified against durable rows
  (`businesses.id + userId`, `campaigns.id + userId`) on every reference; forged
  ids fail closed (`OWNERSHIP_MISMATCH`) — no client-supplied ownership
  authority exists.
- `externalActorReference` is **always null** in R5-D storage: the actor is
  represented only by `actorKey` (sha256). Raw actor references, handles, and
  display names are never persisted by this stream.
- No provider credentials/tokens, no raw webhook payloads, no full social text
  (bounded R5-B excerpts only, inside immutable evidence references), no hidden
  model reasoning (no model runs in this stream at all).
- No prompt-injection path: R5-D never feeds social content into any model or
  rule beyond R5-B's already-sanitized labels; injection content can at most
  produce R5-B labels and can never mint an unsupported opportunity type.
- Personal data is minimized to opaque references and hashes; evidence rows
  store R5-B label copies (closed enums) plus ids/hashes only.
- Cross-business evidence reuse never occurs: evidence binds exactly one
  `(userId, candidateId)`; foreign interpretations fail ownership validation
  before evaluation.

## 13. R5-C engagement-evidence seam (D7)

R5-C's durable engagement receipt was not available at implementation time
(its branch ref equals the base). R5-D therefore defines a narrow structural
seam — `api/lib/opportunity/engagement-evidence-seam.ts` — and consumes receipts
only through it:

```ts
EngagementReceiptLike {
  engagementReceiptId: string;        // server-minted by R5-C, opaque ≤128
  sourceInterpretationId: string;     // must reference an evidence/suppression row
  sourceSignalId: string;             // R5-A signalKey
  businessId: number | null;          // must match the candidate tenant scope
  outcome: "positive_response" | "provider_confirmed_follow_up" | "thread_remained_active";
  providerReceiptRef: string | null;  // provider confirmation reference (opaque)
  occurredAt: string;                 // ISO 8601
  receiptHash: string;                // sha256 over the canonical receipt fragment
  recordedAt: string;                 // acceptance clock
}
```

R5-X convergence requirements: R5-C must (a) mint immutable receipt rows with
a verifiable `receiptHash` over canonical receipt coordinates; (b) bind each
receipt to exactly one interpretation/signal identity; (c) expose a read-only
lookup by `engagementReceiptId` for the seam adapter. Basic opportunity
detection works from R5-A + R5-B alone; engagement evidence only enriches
(strengthens) valid candidates and is never required.

## 14. Structural convergence seams (consume, do not merge)

| Seam | Mirrors |
|---|---|
| `api/lib/opportunity/canonical-intelligence.ts` — strict input schema + pure `adaptSocialInterpretation()` from a `social_interpretations` row shape | R5-B `canonical-signal.ts` pattern (A-facing seam). No R5-B code imported. |
| `api/lib/opportunity/engagement-evidence-seam.ts` — §13 | Future R5-C receipt table. |
| Policy suppression input (optional, §9.3) | R5-E decision records, read-only. |

Identity/vocabulary mapping (R5-B → R5-D, preserved verbatim):
`interpretationId`, `signalId` (= R5-A `signalKey`), `signalVersion`,
`signalType`, `provider`, `platform`, `businessId` (null = unattributed
tenant-scoped), `sourceCampaignId`, `parentExternalObjectId` (threading),
`intent`, `sentiment`, `urgency`, `relevance`, `overallConfidence`,
`opportunityIndicators`, `topics`, `riskFlags`, `recommendedHandling`,
`classifierVersion`, `createdAt`. R5-D never re-derives or mutates upstream
identities; downstream metadata lives in R5-D tables keyed by them.

## 15. Schema / migration dependencies

- Provisional migration `0030_opportunity_detection_foundation` creates the
  four tables (§"Schema" in `docs/recovery/r5-d-opportunity-detection-inventory.md` §4).
  **Created, not executed.** R5-X convergence item: R5-A (`0029_social_listening_foundation`),
  R5-B (`0029_add_social_interpretations`), and R5-E (`0029_sad_donald_blake`)
  collide at journal idx 29 on three branches; R5-D deliberately skipped to
  provisional idx 30 and did not renumber, execute, or duplicate any upstream
  artefact. Final numbering/journal convergence is owned by R5-X.
- Downstream tables reference `interpretationId` (varchar 64) and signal ids
  opaquely; **no FK constraints** coupling migrations (R5-A §15 discipline).
- `AUDIT_EVENT_TYPES` gains `opportunity_detected`, `opportunity_suppressed`,
  `opportunity_state_changed`, `opportunity_handed_off` (code-level additive).

## 16. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Router registry | `api/router.ts` | one additive `opportunity` registration |
| Schema / migrations | `db/schema.ts`, `db/migrations/` | append-only; provisional 0030 |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive `opportunity_*` values only |
| Financial contract | `docs/contracts/financial-reliability-contract.md` | untouched (non-billable) |
| Audience / engagement | `api/lib/audience/*`, `api/lib/engagement/*` | read-only shapes; never written |
| Boot / schedulers | `api/boot.ts` | default-off expiry sweep seam only |
| Governance | `api/lib/governance/*` | untouched; F bridges at R5-X |

## 17. Security invariants (asserted by the D9 acceptance suite)

1. Server-side authorization on every surface; tenant scoping from
   `ctx.user.id` only; ownership re-verified from durable rows on every
   reference.
2. Deterministic server-minted identity; no client-supplied identity,
   ownership, score, confidence, or status.
3. Exact-once convergence is DB-authoritative (unique keys + CAS); no in-memory
   dedupe; replay-safe; conflicting material fails closed.
4. Immutable evidence after acceptance; hash-drift is tampering and fails
   closed; stale writes rejected by version guards.
5. Candidate ≠ lead: no `leads`/`lead_activities`/`lead_scores`/
   `outreach_recommendations` rows are ever created by R5-D.
6. Policy boundary honored (§9); DENY/ESCALATE never becomes outreach
   permission; detection never initiates governed marketing actions.
7. Privacy minimization (§12): hash-only actor identity; no raw PII, tokens,
   payloads, or model reasoning retained.
8. Bounded honest confidence (§6); low/unknown evidence never surfaces as
   high-confidence.
9. Prompt-injection resistance: closed enums + strict schema; social text
   never enters R5-D processing.
10. Expiry and exact-once handoff are deterministic and durable (§10–11).

---

**R5-C/R5-E/R5-F/R6: consume opportunity candidates through this contract and
`docs/contracts/opportunity-to-lead-autonomy-contract.md`. Do not redefine
opportunity authority.**
