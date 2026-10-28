# CANONICAL ATTRIBUTION INTELLIGENCE CONTRACT (WBS-R7-B)

> **Stream:** WBS-R7-B — Attribution Intelligence
> **Module authority:** `api/lib/attribution/`
> **Router:** `api/attribution-router.ts` (tRPC namespace `attribution`)
> **Schema:** `attribution_results`, `attribution_lifecycle_events`
> (stream-local provisional migration `0035_r7_b_attribution_foundation` —
> artefact only, **NOT executed**; see
> `docs/recovery/r7-b-unexecuted-migrations.md`; R7-X owns canonical R7
> sequencing and collision resolution with R7-A's provisional `0035`)
> **Upstream (frozen, consumed not merged):** R7-A Conversion Outcome
> Intelligence (`feature/r7-a-conversion-outcome-intelligence` @ `3e8aea8`) —
> `docs/contracts/conversion-outcome-intelligence-contract.md`,
> `docs/contracts/conversion-outcome-to-attribution-learning-contract.md`;
> R6 Lead Autonomy V1 (`integration/r6-lead-autonomy` @ `8030e97a…`) —
> conversion, lead-identity, scoring, qualification, nurture, governance
> contracts; R5 opportunity/engagement/signal contracts; R4 campaign/
> publication provenance
> **Downstream:** R7-C business learning via
> `docs/contracts/attribution-to-business-learning-contract.md`
> **Status:** authoritative as of the R7-B acceptance harness

This contract defines the authoritative interpretation and persistence of
**attribution results**: which prior marketing/customer-journey events are
legitimately associated with a canonical R7-A business outcome, what
contribution evidence exists, which deterministic attribution models may
allocate credit, and how confident the attribution is. R7-A establishes
truthful outcome value; R7-B derives **association and allocated credit only**.

**Required principle:** *association is not causation.* Attribution output
distinguishes strictly between observed association, eligible contribution,
allocated credit, and causal evidence. Credit allocation is never causal proof;
no attribution result ever asserts that a campaign, publication, engagement,
opportunity, nurture touch or handoff **caused** an outcome. Causal claims
require explicit experimental evidence from a later authorised capability
(R7-D) and can never be minted here.

---

## 1. What this stream owns

Owns:

- Attribution identity (deterministic, tenant-anchored, §3)
- Eligible journey reconstruction (deterministic, bounded, §5)
- Attribution windowing (policy-derived, §6)
- Touchpoint inclusion/exclusion rules with closed reason codes (§5)
- Attribution model selection from a closed allowed set (§7)
- Deterministic integer credit allocation (§8)
- Confidence / evidence classification from journey quality (§9)
- Immutable attribution results + supersession semantics (§10)
- Read-only downstream learning projection for R7-C (§12)
- Audit / provenance for every attribution decision (§13)

Does **not** own: business outcome truth or value (R7-A), conversion identity
(R6-E), lead identity (R6-A), scoring (R6-B), qualification (R6-C),
nurture/handoff authority (R6-D), privacy governance (R6-F), provider
execution (R5-C), social ingestion or direct publication binding (R5-A),
opportunity detection (R5-D), campaign execution or strategy (R4),
experimentation (R7-D), budget/portfolio optimisation (R7-E), business
learning promotion (R7-C), revenue recognition, or financial accounting.
R7-B never creates or mutates leads, scores, qualifications, nurture/handoff
records, conversions, outcomes, campaigns, publications, or billing rows.

## 2. Closed vocabularies

**ATTRIBUTION_MODEL_TYPES (5):**

```
FIRST_TOUCH, LAST_TOUCH, LINEAR, POSITION_BASED, TIME_DECAY
```

Each model is individually versioned (`modelVersion`, e.g.
`attribution-first-touch/v1`); the pair `(modelType, modelVersion)` is the
closed model identity. No other model type or version is accepted; models are
deterministic pure functions over the eligible touchpoint set (§7).

**ATTRIBUTION_EVIDENCE_CLASSES (4):**

```
DIRECT_LINKAGE, STRONG_ASSOCIATION, WEAK_ASSOCIATION, INSUFFICIENT_EVIDENCE
```

| Class | Meaning |
|---|---|
| `DIRECT_LINKAGE` | Authoritative chronology: verified outcome, stable lead lineage, complete in-window event chain with authoritative timestamps |
| `STRONG_ASSOCIATION` | Sound lineage with minor gaps (e.g. non-authoritative outcome verification, or one excluded/missing intermediate event) |
| `WEAK_ASSOCIATION` | Partial journey, ambiguous lineage, or multiple material exclusions |
| `INSUFFICIENT_EVIDENCE` | No eligible touchpoints, unverifiable chain, or too little evidence to allocate meaningful credit |

**ATTRIBUTION_CONFIDENCE_CLASSES (4):** `HIGH, MEDIUM, LOW, NONE` —
deterministically derived from the evidence class and journey quality metrics
(§9). Confidence is a summary label over evidence quality, never model opinion.

**ATTRIBUTION_TOUCHPOINT_TYPES (6):**

```
CAMPAIGN, PUBLICATION, ENGAGEMENT, OPPORTUNITY, NURTURE_TOUCH, SALES_HANDOFF
```

Only types with repository-supported linkage are in the set (see §5). Each
carries its upstream identity verbatim (`campaigns.id`,
`publishing_queue`-resolved publication identity, `engagement_receipts.engagementReceiptId`,
`opportunity_candidates.opportunityId`, `nurture_touch_records.touchIdentity`,
`sales_handoffs.handoffId`).

**ATTRIBUTION_EXCLUSION_REASON_CODES (closed):**

```
TOUCHPOINT_AFTER_OUTCOME, TOUCHPOINT_OUTSIDE_WINDOW, TOUCHPOINT_FUTURE_DATED,
TOUCHPOINT_TIMESTAMP_INVALID, TOUCHPOINT_LEAD_MISMATCH, TOUCHPOINT_BUSINESS_MISMATCH,
TOUCHPOINT_DUPLICATE, TOUCHPOINT_UNRESOLVED_LINEAGE, TOUCHPOINT_UNSUPPORTED_TYPE
```

**ATTRIBUTION_LIFECYCLE_TYPES (1):** `supersession`.

**ATTRIBUTION_DUPLICATE_CLASSIFICATION:** `none | idempotent_replay`.

## 3. Attribution identity (deterministic, server-derived, tenant-anchored)

```
journeyHash     = sha256(canonicalJson(eligibleTouchpoints.map(
                    t => ({ type, touchpointId, occurredAt, creditBps }))))
attributionKey  = sha256(canonicalJson({ v: 1, tenantUserId, businessId,
                    outcomeId, modelType, modelVersion, windowStart,
                    windowEnd, journeyHash, totalCreditBps, confidenceClass,
                    evidenceClass, outcomeStatus, policyVersion }))
attributionId   = "atr1:" + attributionKey
```

- Identity is a pure function of authoritative inputs: no wall-clock, no
  randomness. Replaying an identical request reproduces the identical result
  and converges on the durable row (§11).
- The tenant is bound **inside** the hash; identical material under a
  different tenant is a different identity, and every read/write is
  tenant-predicated anyway — cross-tenant correlation is impossible.
- `outcomeStatus` participates in the identity: an outcome lifecycle change
  (e.g. verification, reversal) yields a new attribution rather than a
  mutation (§10).
- **No client-selected attribution id exists.** Clients reference ids only;
  client-supplied `attributionId`/`attributionKey`/`recordHash` or any
  authority field is rejected (`ATTRIBUTION_CLIENT_AUTHORITY_FIELD_FORBIDDEN`).

## 4. Canonical record shape

Exactly `attribution_results` (`db/schema.ts` → `AttributionResultRow`):

```ts
AttributionResultRow {                 // attribution_results — immutable
  id: number;                          // serial PK
  attributionId: string;               // varchar(69) NOT NULL — "atr1:"+64hex (§3)
  attributionKey: string;              // varchar(64) NOT NULL — content hash (§3)
  userId: number;                      // bigint unsigned NOT NULL — tenant anchor
  businessId: number;                  // bigint unsigned NOT NULL — outcome-carried, re-verified
  outcomeId: string;                   // varchar(69) NOT NULL — canonical R7-A reference
  leadId: number | null;               // bigint unsigned NULL — outcome-carried numeric lead
  leadIdentityVersion: string | null;  // varchar(64) NULL — opaque R6-A seam reference
  conversionId: string;                // varchar(69) NOT NULL — outcome-carried R6-E reference
  outcomeStatus: string;               // varchar(16) NOT NULL — snapshot at calculation time
  outcomeAmountMinor: number | null;   // bigint NULL — read-only outcome value reference
  outcomeCurrency: string | null;      // varchar(3) NULL
  modelType: string;                   // varchar(24) NOT NULL — closed vocab §2
  modelVersion: string;                // varchar(40) NOT NULL — closed model identity
  windowStart: string;                 // varchar(32) NOT NULL — ISO 8601
  windowEnd: string;                   // varchar(32) NOT NULL — ISO 8601 (= outcome time)
  journeyHash: string;                 // varchar(64) NOT NULL — eligible set fingerprint
  touchpoints: unknown;                // json NOT NULL — eligible set w/ credit (§5)
  excludedTouchpoints: unknown;        // json NOT NULL — exclusions w/ closed reasons
  totalCreditBps: number;              // int NOT NULL — exactly TOTAL_CREDIT_BPS (§8)
  confidenceClass: string;             // varchar(16) NOT NULL — closed vocab §2
  evidenceClass: string;               // varchar(24) NOT NULL — closed vocab §2
  policyVersion: string;               // varchar(96) NOT NULL — attribution policy version
  sourceVersions: unknown;             // json NOT NULL — consumed contract versions (§13)
  supersedesAttributionId: string | null; // varchar(69) NULL — supersession lineage (§10)
  recordHash: string;                  // varchar(64) NOT NULL — immutable-core sha256 (§13)
  calculatedAt: string;                // varchar(32) NOT NULL — calculation time (provenance only)
  createdAt: Date;                     // timestamp NOT NULL DEFAULT now()
}
```

`calculatedAt` is recorded for provenance and is **never** part of any
identity or hash: replaying the same material at a different time converges to
the same durable row.

### Touchpoint representation (inside `touchpoints[]`)

```ts
AttributionTouchpoint {
  touchpointId: string;      // deterministic "tpp:<type>:<sha256(sourceIdentity)[:16]>"
  type: "CAMPAIGN" | "PUBLICATION" | "ENGAGEMENT" | "OPPORTUNITY"
      | "NURTURE_TOUCH" | "SALES_HANDOFF";
  sourceIdentity: string;    // upstream durable identity, verbatim
  businessId: number | null; // null-or-equal business scope
  occurredAt: string;        // ISO 8601 authoritative event time
  provenance: {              // how this touchpoint was legitimately reached
    path: string;            // closed lineage path label (§5)
    references: Record<string, string | number | null>; // referencing ids only
    sourceRowHash: string;   // sha256 of the canonical source-row material used
  };
  eligibility: "eligible";   // only eligible touchpoints appear in this array
  creditBps: number;         // allocated integer credit (§8)
}
```

Excluded candidates are preserved separately in `excludedTouchpoints[]` with
`eligibility: "excluded"` and exactly one closed `reason` (§2) — audit
completeness without polluting the credit-bearing set.

## 5. Eligible journey reconstruction (B2)

Reconstruction is a deterministic, pure, bounded fold over durable upstream
rows. Rules:

1. **Same tenant.** Every source query predicates `userId` from the
   authenticated session. Cross-tenant rows are unreachable; a seam that ever
   surfaces one fails closed.
2. **Same business scope.** A source row links only when its `businessId` is
   null-or-equal to the outcome's `businessId` (house convention). Otherwise
   excluded (`TOUCHPOINT_BUSINESS_MISMATCH`).
3. **Same canonical lead.** The outcome's numeric `leadId` binds to the R6-A
   `lid1` world **only** through the score-mediated chain (inventory §3 L4):
   `lead_score_snapshots` (numeric `leadId` + `leadScoreId` + seam version) →
   `lead_qualifications` (`leadScoreId` → lid1 `leadId`). Source rows keyed by
   lid1 are admitted only for validated chain lids. No fuzzy matching, no
   cross-lead stitching, no cross-business stitching, no inferred events.
4. **Bounded window.** Only events with `windowStart ≤ occurredAt ≤
   windowEnd` are eligible (§6).
5. **Authoritative ordering.** Events order by normalized epoch-ms timestamp;
   ties break deterministically by `(type, sourceIdentity)` lexicographic
   order. No model re-orders history.
6. **Supported types only.** Only §2 touchpoint types with repository-evidence
   linkage paths are reconstructed:
   - `OPPORTUNITY` — `opportunity_candidates` reached via R6-A identity
     provenance (`kind = opportunity_handoff`) or via validated R6-C/R6-D
     lineage; `occurredAt = firstObservedAt`.
   - `ENGAGEMENT` — `engagement_receipts` reached via `opportunity_evidence`
     (`kind = engagement_receipt`) or signal linkage; `occurredAt = executedAt`.
   - `NURTURE_TOUCH` — `nurture_touch_records` keyed by validated lid1;
     `occurredAt = touchedAt`.
   - `SALES_HANDOFF` — `sales_handoffs` keyed by validated lid1;
     `occurredAt = preparedAt` (lifecycle labels preserved, fake-transport
     caveat retained).
   - `CAMPAIGN` — materialised from an authoritative campaign reference
     carried by an admitted journey row (`opportunity.campaignId`,
     `signal.sourceCampaignId` with `attributionType = direct`,
     `conversion_events.sourceCampaignId` provenance); `occurredAt` = the
     campaign row's authoritative start time; the campaign row must
     re-verify for the tenant.
   - `PUBLICATION` — materialised only through the receipt-resolvable path
     (`signal.sourcePublicationReceiptId` → publication receipt →
     `publishing_queue.publishedAt`, or a `publishing_queue` row directly
     referenced with a numeric id by conversion provenance); fragmented
     varchar publication identity is **never** re-resolved (inventory §4 G2);
     unresolvable publication references are excluded
     (`TOUCHPOINT_UNRESOLVED_LINEAGE`).
7. **Duplicate handling.** Events sharing the same `(type, sourceIdentity)`
   collapse to one touchpoint (`TOUCHPOINT_DUPLICATE` recorded on the
   duplicate). Credit is never duplicated.
8. **Outcome-state handling.** Touches with `occurredAt` after the outcome are
   excluded (`TOUCHPOINT_AFTER_OUTCOME`); implausible future timestamps beyond
   a 5-minute skew bound are rejected (`TOUCHPOINT_FUTURE_DATED`); unparseable
   timestamps exclude the touchpoint (`TOUCHPOINT_TIMESTAMP_INVALID`). If the
   **outcome's own** timestamp is unparseable, the whole evaluation fails
   closed (`ATTRIBUTION_OUTCOME_TIMESTAMP_INVALID`).
9. **Malformed lineage** (a referencing row that cross-tenant, cross-business,
   or belongs to a different lead) excludes the derived touchpoint with the
   matching reason; lineage is never repaired or reinterpreted.

## 6. Attribution windowing

- `windowEnd` = outcome `occurredAt` (the authoritative outcome time).
- `windowStart` = `windowEnd` minus `windowDays` from the deterministic
  attribution policy (default 30; bounds 1–365; server-side only).
- The window is **never** client-supplied. Policy changes mint new
  attributions (new policy version participates in identity), never edits.

## 7. Attribution models (B3)

Closed set (§2). Every model is a pure deterministic function over the ordered
eligible touchpoint list, returning integer basis points per touchpoint.
Model weights are **model-version constants** — clients never supply weights,
and no model output may be overridden by any runtime agent or model.

| Model | Allocation rule (all integer bps) |
|---|---|
| `FIRST_TOUCH` | 100% to the chronologically first touchpoint |
| `LAST_TOUCH` | 100% to the chronologically last touchpoint |
| `LINEAR` | Equal split across all touchpoints |
| `POSITION_BASED` | 40% first + 40% last + 20% linear across intermediates (2-touch degenerate: 50/50; 1-touch: 100%) |
| `TIME_DECAY` | Half-life decay (7-day model constant): weight ∝ 2^(−ageDays/7), age from outcome; normalized to exactly 100000 bps |

Empty eligible set → every model returns `totalCreditBps = 0` and evidence
class `INSUFFICIENT_EVIDENCE`. Rounding is deterministic largest-remainder with
a stable tie-break on `(occurredAt, type, sourceIdentity)` (§8).

## 8. Credit allocation (B4)

- Credit is integer **basis points**; `TOTAL_CREDIT_BPS = 100000` (= 100.000%).
- Total credit is **exactly** normalised to `TOTAL_CREDIT_BPS` for every
  non-empty eligible set — no over-allocation, no negative credit, no float
  arithmetic anywhere in the allocation path.
- Rounding: largest remainder method; remainders ordered by `(fraction desc,
  occurredAt asc, type asc, sourceIdentity asc)` — fully deterministic and
  replay-stable.
- An attribution may **reference** the outcome's verified monetary amount
  (`outcomeAmountMinor`, read-only) but never mutates, re-denominates, or
  recreates value. No new revenue is created; no netting is performed.

## 9. Confidence / evidence classification (B5)

Classification is a deterministic pure function of journey quality signals —
never of model choice:

- **outcome verification state** — `VERIFIED` authoritative; `PROVISIONAL`/
  `OBSERVED` cap the class at `STRONG_ASSOCIATION` (and only when policy
  allows provisional attribution);
- **chronology completeness** — eligible touchpoints present across the
  window vs material exclusions;
- **timestamp authority** — share of touches with authoritative parseable
  timestamps vs excluded `TOUCHPOINT_TIMESTAMP_INVALID`;
- **lineage stability** — validated lead chain present vs `leadId = null`;
- **touchpoint cardinality** — zero eligible touches ⇒ `INSUFFICIENT_EVIDENCE`.

Confidence mapping (closed, deterministic): `DIRECT_LINKAGE → HIGH`,
`STRONG_ASSOCIATION → MEDIUM`, `WEAK_ASSOCIATION → LOW`,
`INSUFFICIENT_EVIDENCE → NONE`. Confidence is never translated into causal
proof; every projection and read surface carries the disclaimers (§12).

## 10. Lifecycle / revision (B6)

Attribution rows are **immutable after acceptance** — no update path.
Truthful change is new history:

- Outcome becomes verified / reverses / new authoritative touch evidence
  arrives / model or policy version changes / window changes ⇒ a **new**
  attribution result is minted, linked by `supersedesAttributionId` to the
  prior result for the same `(userId, outcomeId, modelType, modelVersion)`.
- Each supersession also mints one deterministic immutable
  `attribution_lifecycle_events` row (`lifecycleType = supersession`).
- Current attribution per outcome+model is derived: the latest result not
  superseded by a newer one. **Reversed / cancelled outcomes never retain a
  misleading active positive attribution**: evaluation against a
  reversed/cancelled/superseded outcome fails closed
  (`ATTRIBUTION_OUTCOME_NOT_ATTRIBUTABLE`), and a supersession triggered by
  an observed outcome reversal mints a zero-credit successor
  (`totalCreditBps = 0`, `evidenceClass = INSUFFICIENT_EVIDENCE`) so history
  stays truthful. Prior results remain fully readable for audit.

```ts
AttributionLifecycleEventRow {         // attribution_lifecycle_events — immutable
  id: number;                          // serial PK
  attributionLifecycleEventId: string; // varchar(70) NOT NULL — "atf1:"+64hex
  attributionId: string;               // varchar(69) NOT NULL — superseding result
  priorAttributionId: string;          // varchar(69) NOT NULL — superseded result
  userId: number;                      // bigint unsigned NOT NULL
  lifecycleType: string;               // varchar(16) NOT NULL — "supersession"
  occurredAt: string;                  // varchar(32) NOT NULL
  createdAt: Date;
}
```

## 11. Exact-once persistence and concurrency

Insert-first against durable unique anchors:

- `atr_attribution_id_uidx` — UNIQUE(`attributionId`)
- `atr_natural_key_uidx` — UNIQUE(`userId`, `outcomeId`, `modelType`,
  `modelVersion`, `windowStart`, `windowEnd`, `journeyHash`)
- `atf_event_id_uidx` — UNIQUE(`attributionLifecycleEventId`)

| Scenario | Result |
|---|---|
| Identical request replayed | `idempotent_replay`; one durable row |
| Concurrent identical evaluation | One insert wins; losers re-read via natural key → `idempotent_replay` |
| Same identity, different material (tamper) | `ATTRIBUTION_REPLAY_CONFLICT` — fail closed |
| New evidence / changed window / new model version | New `journeyHash` / versions → new durable row + supersession lineage |
| Same natural key, divergent stored content | Impossible by determinism; any occurrence is tampering → `ATTRIBUTION_EVIDENCE_CONFLICT` |
| Record hash drift on any read | `ATTRIBUTION_EVIDENCE_CONFLICT` — fail closed |

All convergence is DB-authoritative. No in-memory dedupe. No client
idempotency identity.

## 12. Downstream learning projection (B8)

`buildAttributionLearningProjection` —
`ATTRIBUTION_LEARNING_CONTRACT_VERSION = "attribution-to-learning/v1"`,
frozen key allowlist (asserted exact in acceptance). Read-only; R7-C may
consume ids, outcome reference, model/version, allocated credit, confidence /
evidence class, lineage, and calculation time — and must never mutate R7-B
authority. Full semantics:
`docs/contracts/attribution-to-business-learning-contract.md`. Every
projection carries, verbatim:

```
causationClaimed: false
causationDisclaimer: "Allocated credit is association evidence, not causal
  proof. This projection does not assert that any touchpoint caused the
  business outcome."
attributionClaimed: true
```

## 13. Provenance, audit, and source versions

- `recordHash` = sha256 over the canonical immutable core (every material
  column of §4 except `id`/`createdAt`). Drift between a retained row and its
  hash is tampering and fails closed on every read
  (`ATTRIBUTION_EVIDENCE_CONFLICT`).
- `sourceVersions` records the consumed contract versions: outcome projection
  version (`conversion-outcome/v1`), conversion projection version
  (`conversion-to-attribution/v1`), attribution contract version
  (`attribution/v1`), and the attribution policy version.
- Exactly one deterministic `attribution_calculated` audit event per inserted
  result (and one `attribution_superseded` per supersession fact);
  convergence paths emit zero events. Metadata carries ids, closed labels,
  classes, and hashes only — never social content, PII, or outcome evidence
  text.

## 14. Security invariants (asserted by the acceptance suite)

1. Tenant isolation: session `userId` anchors every identity, predicate, and
   hash; business/lead/outcome/touchpoint ownership re-verified from durable
   rows on every call.
2. Fail closed everywhere: unknown outcome, cross-business outcome, reversed
   outcome, privacy suppression, unknown model/version, malformed timestamps,
   identity conflict, record-hash drift, conflicting replay.
3. Server-derived authority only: window, policy version, model version,
   credit, confidence, evidence class, identity, hashes — no client-supplied
   authority field is accepted (`ATTRIBUTION_CLIENT_AUTHORITY_FIELD_FORBIDDEN`).
4. No causal authority: clients and runtime agents can never mark causation
   proven, supply weights, fabricate touchpoints, or alter chronology.
5. Rogue-agent containment: model/agent output is untrusted data and reaches
   persistence only through the strict boundary — never around it. Agents have
   no SQL/shell/secret access and cannot modify permissions.
6. Prompt-injection resistance: lead/social/content text never enters the
   attribution path; all inputs are durable rows with closed labels.
7. No upstream mutation: R4/R5/R6/R7-A tables are read-only for this stream.
8. Auditability: exactly one deterministic audit event per durable effect.

## 15. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Outcome authority (R7-A owned) | R7-A `api/lib/outcome/*` (frozen branch) | consumed via seam only; never imported/merged |
| Conversion / R6 authorities | `api/lib/conversion/*`, `api/lib/lead-identity/*`, `api/lib/scoring/*`, `api/lib/qualification/*`, `api/lib/nurture/*` | read-only consumption |
| Schema | `db/schema.ts` | append-only (attribution tables) |
| Migrations | `db/migrations/` | append-only provisional `0035_r7_b_attribution_foundation`; **NOT executed**; 0034 and R7-A's 0035 untouched |
| Router registry | `api/router.ts` | one additive `attribution` registration |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive attribution event types only |
| Legacy analytics | `api/analytics-router.ts` | untouched — governed attribution never routed through ungoverned `metricType` `conversions`/`revenue` |
| Billing / payments (R4) | `api/lib/billing/*` | read-only — never charged, never invoked |

---

**R7-C and all downstream consumers: consume attribution through
`docs/contracts/attribution-to-business-learning-contract.md`. Allocated credit
is association evidence, not causal proof. Do not redefine attribution
authority.**
