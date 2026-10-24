# Social Intelligence Contract (Intent & Sentiment Interpretation)

> **Stream:** WBS-R5 Stream B — Intent & Sentiment Intelligence
> **Branch:** `feature/r5-b-intent-sentiment`
> **Base:** `e4493a8` (R4 FULL_AUTONOMY_V1_READY)
> **Status:** ACCEPTED — canonical interpretation authority for R5-B
> **Implements:** WBS-R5-B B1 (canonical interpretation contract)
> **Upstream (frozen, consumed not merged):** R5-A
> `docs/contracts/social-signal-contract.md` +
> `docs/contracts/social-listening-to-intelligence-contract.md`,
> branch `feature/r5-a-social-listening` @ `c9a930e` — aligned §3/§5, slice 4

---

## 1. Scope & invariants

This contract defines the single canonical interpretation model produced by the R5-B
intelligence layer. It owns **interpretation only**: intent, sentiment, relevance,
urgency, topic, risk flags, opportunity indicators and a classification-only
recommended-handling class. It does **not** own signal ingestion (R5-A), engagement
execution (R5-C), opportunity/lead actions (R5-D), or final engagement policy (R5-E).

Invariants:

1. One canonical signal version + one classifier version → exactly one accepted
   interpretation identity (see §5). Records are immutable once accepted.
2. Interpretation never executes an action. `recommendedHandling` is a classification
   for downstream governance, not a command.
3. Social text is untrusted data. It is sanitized, bounded and delimited before any
   rule/model processing, and can never alter system/model instructions.
4. Confidence is a bounded ordinal with an explicit source — never a fabricated
   probability (see §8).
5. Records are tenant-safe: `businessId`/`userId` ownership is server-authoritative;
   no client-supplied ownership or interpretation identity is accepted.
6. The rules path is deterministic, versioned, replay-safe, explainable and
   non-billable. The model path is bounded and billable at most once per logical
   interpretation version (see §13).

## 2. Authoritative source modules (consume, do not duplicate)

| Module | Consume for |
|---|---|
| `api/lib/intelligence/interpretation-contract.ts` | Canonical record types, controlled vocabularies, zod schemas, `CLASSIFIER_VERSION`, `SOCIAL_INTELLIGENCE_SCHEMA_VERSION` |
| `api/lib/intelligence/canonical-signal.ts` | R5-A-facing canonical social signal adapter types + strict input schema (isolated boundary until R5-A publishes its contract) |
| `api/lib/intelligence/input-safety.ts` | Untrusted-text sanitization, bounding, unicode normalization, rejection rules |
| `api/lib/intelligence/rules-engine.ts` | Deterministic rule-first interpretation (non-billable) |
| `api/lib/intelligence/model-boundary.ts` | Governed AI interpretation via `runAgent` (`agentType: "interpretation"`), prompt-injection-resistant construction |
| `api/lib/intelligence/confidence.ts` | Confidence semantics, combination rules, handling gates |
| `api/lib/intelligence/risk-classifier.ts` | Deterministic, evidence-linked risk flags |
| `api/lib/intelligence/relevance.ts` | Owner-scoped Business DNA relevance (deterministic when context exists) |
| `api/lib/intelligence/interpretation-identity.ts` | `interpretationId`, `signalContentHash`, `billingIdentity` derivation |
| `api/lib/intelligence/interpretation-store.ts` | Durable immutable acceptance, idempotent replay, tamper fail-closed (`db/schema.ts` → `socialInterpretations`) |
| `api/lib/intelligence/interpreter.ts` | Orchestration: route → interpret → normalize → persist → audit |

## 3. Canonical signal (consumed identity)

**Upstream authority (frozen):** R5-A Stream — `docs/contracts/social-signal-contract.md`
and `docs/contracts/social-listening-to-intelligence-contract.md`, branch
`feature/r5-a-social-listening` @ `c9a930e`. R5-B consumes `social_signals` **only**
through the R5-A §11 field list and never redefines signal authority.

Identity mapping (R5-A → R5-B consuming boundary in `canonical-signal.ts`):

| R5-A (frozen) | R5-B | Notes |
|---|---|---|
| `signalKey` = `"sigv1:" + sha256(provider\|providerAccountId\|externalEventId)` | `signalId` | consumed opaquely, server-minted only |
| `ingestionVersion` | `signalVersion` | governed ingestion change → new interpretation identity |
| `signalType` (11 values, §3 frozen) | `signalType` | same closed enum |
| `provider`, `platform`, `attributionType` | same names | frozen enums |
| `contentText` (≤1024) | `contentText` | schema bound mirrors the frozen retention bound |
| `actorReference`, `actorDisplayName`, `contentReference`, `occurredAt`, `observedAt`, `sourceCampaignId`, `parentExternalObjectId`, `providerEvidenceHash` | same names | R5-A §11 consumption fields |

```ts
CanonicalSocialSignalInput {
  signalId: string;             // = R5-A signalKey (opaque, server-minted)
  signalVersion: number;        // = R5-A ingestionVersion (>=1)
  signalType: "comment"|"reply"|"mention"|"reaction"|"direct_message"|"repost"|
              "follow"|"unfollow"|"campaign_response"|"inbound_message"|"unknown";
  provider: "meta"|"linkedin"|"twitter"|"tiktok";
  platform: "facebook"|"instagram"|"whatsapp"|"linkedin"|"twitter"|"tiktok";
  attributionType: "direct"|"business"|"unattributed";
  actorReference: string | null;     // opaque provider actor id; display only
  actorDisplayName: string | null;   // bounded display; never an authority
  contentText: string | null;        // untrusted social text (<=1024; sanitized, see §7)
  contentReference: string | null;   // provider permalink
  occurredAt: string | null;         // provider event time, ISO; display only
  observedAt: string | null;         // acceptance clock, ISO; display only
  sourceCampaignId: number | null;   // evidence lineage only
  parentExternalObjectId: string | null;  // threading reference
  providerEvidenceHash: string | null;    // R5-A integrity hash (64 hex); bound into identity
}
```

The structural convergence seam is `SocialSignalRowLike` + `adaptSocialSignal()` in
`canonical-signal.ts` — a pure, fail-closed mapper from a `social_signals` row shape to
the input above (no R5-A code imported, per "consume without merge").

The consuming router validates with the strict zod schema, derives
`signalContentHash` server-side, and resolves ownership against the authenticated
user: a non-null `businessId` must be owned by the caller (`businesses.id + userId`);
a **null** `businessId` (R5-A `unattributed` signals) is interpreted tenant-scoped with
no Business DNA context and no fabricated linkage. Clients may **not** supply
`interpretationId`, `userId`, confidence values, or any interpretation field.

`signalType: "unknown"` (R5-A's mandated never-guess bucket) is rejected fail-closed
before any rule or model processing (no record, no billing).

## 4. Canonical interpretation record

```ts
SocialInterpretation {
  interpretationId: string;                  // sha256, deterministic (§5)
  schemaVersion: "social-intelligence/v1";
  classifierVersion: "intent-sentiment-classifier/v1";
  userId: number;                            // server-resolved owner (tenant)
  businessId: number | null;                 // server-validated ownership; null = R5-A
                                             // unattributed signal (tenant-scoped, context-free)
  signalId: string;
  signalVersion: number;
  signalContentHash: string;                 // sha256 of sanitized canonical signal (§5)
  signalType: CanonicalSignalType;
  source: "RULE" | "MODEL";                  // producing authority (§12)
  intent: IntentLabel;
  intentConfidence: ConfidenceLabel;
  sentiment: SentimentLabel;
  sentimentConfidence: ConfidenceLabel;
  urgency: UrgencyLabel;
  relevance: RelevanceLabel;                 // §9
  relevanceConfidence: ConfidenceLabel;
  overallConfidence: ConfidenceLabel;        // §8
  confidenceBasis: "deterministic_rule" | "model_self_assessed" | "insufficient_evidence";
  topics: string[];                          // ≤5, each ≤48 chars, lowercase, no PII
  riskFlags: RiskFlagEntry[];                // §10 — { flag, evidence }
  opportunityIndicators: OpportunityEntry[]; // §11 — { indicator, evidence }
  recommendedHandling: HandlingClass;        // §11 — classification only
  businessDnaSnapshotId: string | null;      // immutable context reference when used (§9)
  evidenceReferences: EvidenceReference[];   // §14
  explanation: string;                       // ≤280 chars, display-only, never re-fed as authority
  billingIdentity: string | null;            // null on RULE path (§13)
  interpretationFingerprint: string;         // sha256 of the full accepted record
  createdAt: string;                         // ISO, single clock read at persistence boundary
  status: "accepted";                        // immutable; downstream replays reuse the row
}
```

## 5. Identity, versioning, replay

Pure sha256 over canonical JSON (sorted keys, trimmed, UTF-8) — no wall-clock, no
randomness (same discipline as `credit-reservation.ts` / `workflow-operation.ts`):

```
signalContentHash    = sha256(canonicalJson({ signalVersion, signalType, provider,
                                             platform, actorReference, actorDisplayName,
                                             contentText, occurredAt, observedAt,
                                             attributionType, sourceCampaignId,
                                             parentExternalObjectId,
                                             providerEvidenceHash }))
interpretationId     = sha256(canonicalJson({ schemaVersion, businessId, signalId,
                                              signalVersion, signalContentHash, classifierVersion }))
billingIdentity      = "interpretation:" + sha256(
                        "intelligence/interpretation-billing@v1:{businessId}:{signalId}:
                         {signalVersion}:{signalContentHash}:{classifierVersion}")
```

`providerEvidenceHash` binds an interpretation to R5-A's own evidence-integrity hash:
any drift in the retained upstream evidence produces a new content hash, so tampered
signals never reuse stale results (B5).

Durable unique keys on `social_interpretations`:

- `interpretationId` — one row per logical interpretation.
- `(businessId, signalId, signalVersion, classifierVersion)` — one interpretation per
  signal version per classifier.

Replay semantics (all fail-closed):

| Trigger | Result |
|---|---|
| Same identity re-presented | Idempotent replay: existing immutable row returned; no model call, no billing, no duplicate audit event |
| Same signal version, different `signalContentHash` | **Tamper/stale rejection** — throws; no record; existing row untouched |
| New `signalVersion` for same `signalId` | New interpretationId → new immutable versioned row; prior rows preserved |
| New `classifierVersion` | Same — new rows only; historical records stay bound to the version that produced them |
| Cross-business `signalId` collision | `businessId` participates in every identity → distinct rows; ownership is validated server-side, so a foreign `businessId` is rejected before evaluation |

Model timeout → runner releases the reservation (refund path, existing policy) → no
record; a retry re-enters with the same `billingIdentity`, so at most one durable
charge survives per logical interpretation version.

## 6. Controlled vocabularies

**Intent** (closed):
`information_request, purchase_interest, product_question, service_question,
complaint, support_request, praise, objection, cancellation_or_churn_signal,
partnership_interest, recruitment_or_employment, spam, abuse, irrelevant, unknown`

**Sentiment** (closed, deliberately coarse — no false precision):
`positive, neutral, negative, mixed, unknown`

**Urgency** (closed):
`low, normal, high, critical`

**Relevance** (closed):
`relevant, partially_relevant, not_relevant, unknown`

**Confidence** (closed ordinal, per-dimension + overall):
`high, medium, low, unknown`

**Handling class** (closed, classification only — never executed by this stream):
`no_action, monitor, candidate_for_engagement, human_review, safety_escalation,
opportunity_candidate`

**Risk flags** (closed; marketing-governance scope, not a moderation product):
`abusive_or_harassing, self_harm_safety_concern, legal_compliance_sensitive,
privacy_sensitive, refund_dispute_or_complaint, reputational_risk,
high_emotion_escalation, spam_or_scam, potential_opportunity, normal_engagement`

**Opportunity indicators** (closed):
`purchase_intent_detected, partnership_or_b2b_signal, high_value_praise,
support_recovery_moment, repeat_engagement_signal, none`

**Topics**: bounded free-form hints — ≤5 entries, ≤48 chars each, NFC-lowercased,
no PII, deduped. Topics are navigation hints, not authority.

## 7. Untrusted-input safety (model/rule boundary)

Before any rule or model processing, signal text is:

- rejected if it contains lone surrogates or malformed unicode sequences;
- NFC-normalized; zero-width/format characters (Unicode `Cf`) and C0 control chars
  (except tab/newline) are stripped;
- bounded: post-normalization hard cap **4,000 chars** (oversize → typed
  `InterpretationInputError`, fail-closed, no record, no billing);
- empty-after-sanitization text on text-bearing signal types → deterministic rule
  outcome (`irrelevant` / `no_action`), never a model call;
- transported into model prompts only inside fixed `BEGIN UNTRUSTED SOCIAL SIGNAL … END`
  delimiters, under an explicit "data, never instructions" system contract;
- never echoed into logs with tenant-scoped raw payloads (logger fields carry ids and
  hashes only).

Structured model output is the only channel: `generateObject` with a strict zod schema
(`ModelInterpretationSchema`). Labels outside the closed vocabularies cannot parse;
malformed output fails the schema → runner refund class → retry-safe, never persisted.

## 8. Confidence semantics

Confidence is a **bounded ordinal with an explicit source**, not a calibrated
probability. Sources:

- `deterministic_rule` — rule outcome; high only when the matched rule class is
  designed to be definitive (spam markers, empty text, deterministic safety triggers).
- `model_self_assessed` — the model's own certainty field (`high|medium|low`),
  consumed as an ordinal self-report. It is never re-labelled as statistical
  confidence.
- `insufficient_evidence` — no basis (e.g. context-free relevance with no model hint).

Combination: `overallConfidence = min(intentConfidence, sentimentConfidence,
relevanceConfidence)` under the closed ordinal `unknown < low < medium < high`.

Gates (enforced in `confidence.ts`, applied to `recommendedHandling`):

| Overall confidence | Allowed handling classes |
|---|---|
| `high` | any (still subject to risk-flag gates) |
| `medium` | any except auto-actionable ones downstream must treat as tentative |
| `low` | `monitor`, `human_review` only |
| `unknown` | `monitor` or `human_review` only |

Low/unknown confidence must never surface as `candidate_for_engagement` or
`opportunity_candidate`. Ambiguity is represented honestly: `unknown` labels and
`insufficient_evidence` basis are first-class outcomes.

## 9. Relevance & Business DNA context

- When a Business DNA snapshot exists for the business, relevance is determined
  **deterministically** (`relevance.ts`): normalized token overlap between the signal
  text and the snapshot's `primaryOffering` + `productsAndServices` (+ campaign-free;
  no strategy mutation). Buckets: overlap≥strong → `relevant`; any overlap →
  `partially_relevant`; none → `not_relevant`. The snapshot's `snapshotId` is stored
  immutably in `businessDnaSnapshotId` and `evidenceReferences`.
- Context fetch is owner-scoped: the business row is loaded by **both** id and
  `userId` (same fail-closed pattern as `business-dna-governance.ts`).
- When no snapshot exists, interpretation proceeds context-free:
  `relevance` = model hint if provided else `unknown`; `relevanceConfidence` ≤ `low`;
  `businessDnaSnapshotId` = null. Business/product linkage is never fabricated.
- Minimal context enters the model prompt: `businessName`, `primaryOffering`,
  `productsAndServices` only. Prohibited claims, pain points, and any other tenant
  internals stay out.

## 10. Risk flags (evidence-linked)

`risk-classifier.ts` is a deterministic layer over the normalized interpretation plus
bounded text markers. Every flag carries `evidence` (a short excerpt or matched marker
id ≤160 chars, sanitized). Examples of deterministic triggers: self-harm phrase markers
→ `self_harm_safety_concern`; threat/harassment markers → `abusive_or_harassing`;
refund/chargeback markers → `refund_dispute_or_complaint`; legal-threat markers →
`legal_compliance_sensitive`; negative sentiment × critical urgency →
`high_emotion_escalation`; spam rule match → `spam_or_scam`.

Any safety-critical flag forces `safety_escalation`; any other risk flag forces
`human_review` unless a safety flag already applies. Risk flags route to downstream
human/policy review — they never trigger automated action from this stream.

## 11. Opportunity indicators & handling classes

Opportunity indicators derive from intent/sentiment/relevance combinations
(e.g. `purchase_interest` + `positive`/`neutral` + relevance ≠ `not_relevant` →
`purchase_intent_detected`). They are hints for R5-D, not qualified opportunities.

Handling resolution order (first match wins):

1. safety-critical risk flag → `safety_escalation`
2. other risk flag, or overall confidence `low`/`unknown` → `human_review`
3. opportunity indicator present with overall confidence ≥ `medium` → `opportunity_candidate`
4. engagement-suitable intent (`information_request`, `product_question`,
   `service_question`, `purchase_interest`, `praise`), confidence ≥ `medium`,
   relevance ≠ `not_relevant`, no risk flags → `candidate_for_engagement`
5. definitive rule outcomes `spam`/`irrelevant`/`abuse` → `no_action`
6. otherwise → `monitor`

## 12. Rule vs model source

- `RULE`: deterministic engine only. Used for definitive classes only — empty/no-text,
  spam markers, explicit provider spam metadata, deterministic safety triggers,
  unsupported-signal rejection. Non-billable; `billingIdentity` = null.
- `MODEL`: required for everything ambiguous. Prompt is built by `model-boundary.ts`
  with labelled authority, delimited untrusted text, minimal Business DNA context, and
  a strict structured schema. Model output is re-validated and normalized before it can
  influence any field; model prose is never authoritative.
- Only one authority writes a record. Rules never "pre-classify then double-write" with
  the model; the orchestrator picks exactly one path per evaluation.

## 13. Billing

- Rules path: **non-billable** (`billingIdentity` null, no reservation, no `ai_usage`).
- Model path: one governed `runAgent` call with `billingIdempotencyKey =
  billingIdentity` (§5). Reserve → single provider call → settle/release via the
  existing reservation authority; schema/provider/quota failures follow the existing
  refund/settlement policy unchanged. Retries of the same logical interpretation
  version re-enter with the same key → at most one durable charge.
- `ai_usage.agentType` gains `interpretation`; the identity format is registered in
  `docs/contracts/financial-reliability-contract.md` §2 (one added row; frozen formats
  otherwise untouched).

## 14. Evidence references

Every record carries `evidenceReferences`: a bounded list (≤8) of
`{ kind: "signal_excerpt" | "rule" | "model" | "business_dna" | "provider_metadata",
 ref: string, excerpt?: string }` entries. `signal_excerpt` excerpts are ≤160 chars,
sanitized, and drawn from the already-sanitized signal text. Evidence is display-only
for downstream explainability; it is never re-ingested as authority input.

## 15. Auditability

Acceptance persists: (1) the immutable interpretation row; (2) one
`interpretation_recorded` audit event (added to the closed `AUDIT_EVENT_TYPES`
taxonomy) with sanitized metadata (ids, labels, hashes — no text, no secrets, per
`SENSITIVE_METADATA_KEY` hygiene). Idempotent replays return the existing row and do
not re-emit audit events. `createdAt` is a single clock read at the persistence
boundary, supplied to the pure constructors (no hidden clocks).

## 16. Known residuals

- Sentiment vocabulary here (`positive|neutral|negative|mixed|unknown`) intentionally
  differs from the legacy `conversation_messages.sentiment`
  (`positive|neutral|negative|urgent`): legacy mixes urgency into sentiment and stays
  legacy. R5-B does not mutate the legacy column.
- Model self-assessed confidence is an ordinal self-report; no statistical calibration
  is claimed.
- Business DNA relevance uses deterministic token overlap; it is explainable but not
  semantic. Where no DNA exists, relevance is honestly `unknown`.
- Migration collision (R5-X convergence item): R5-A's provisional
  `0029_social_listening_foundation` and this stream's provisional
  `0029_add_social_interpretations` coexist on separate branches. Neither was executed,
  renumbered, nor duplicated by R5-B; final numbering/journal convergence is owned by
  R5-X.
- MySQL unique indexes treat NULL `businessId` as distinct, so the natural-key unique
  index cannot alone block tamper inserts for unattributed signals; the store therefore
  performs a deterministic pre-insert natural-key lookup (null-aware) and fails closed
  on content drift before any insert.
