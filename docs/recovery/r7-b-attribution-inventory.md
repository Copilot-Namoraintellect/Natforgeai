# R7-B Attribution Intelligence — Authority / Journey Inventory (B0)

> **Stream:** WBS-R7-B (Attribution Intelligence)
> **Branch:** `feature/r7-b-attribution-intelligence`
> **Programme base:** `8030e97adc9fe8e6bf1cc3a93a8a66da56025a46` (R6 Lead Autonomy V1 accepted HEAD)
> **R7-A frozen authority (consumed by branch ref only, NOT merged):**
> `feature/r7-a-conversion-outcome-intelligence` @ `3e8aea8`
> **Rule:** Inspect before editing. R7-B consumes upstream contracts; it never
> redefines, merges, or mutates them.

This document is the B0 authority/journey inventory. It records exactly which
prior marketing/customer-journey events can be **deterministically** associated
with an R7-A canonical business outcome, which cannot, and where ambiguity must
fail closed or lower confidence. It is the design input for
`docs/contracts/attribution-intelligence-contract.md` and the
`api/lib/attribution/` module set.

---

## 1. Identity established

| Item | Value |
|---|---|
| Worktree | `C:\Users\27768\NatForgeAI-R7-B` |
| Branch | `feature/r7-b-attribution-intelligence` |
| HEAD | `8030e97adc9fe8e6bf1cc3a93a8a66da56025a46` (exactly the programme base) |
| Remote | `origin` (`https://github.com/Copilot-Namoraintellect/Natforgeai.git`) |
| Working tree | clean at inventory time |
| R6 accepted HEAD | `8030e97a…` (merge-base verified = HEAD) |
| R7-A frozen ref | `3e8aea8b4367da599bb8a28887c156c7241eae9c` (verified present locally) |
| Base migration on this branch | `0034_r6_lead_autonomy_foundation` (journal idx 34) |
| R7-A provisional migration (its branch, not merged) | `0035_r7_a_conversion_outcome_foundation` (CREATED, NOT EXECUTED) |

## 2. Authorities inventoried

### 2.1 R7-A Conversion Outcome Intelligence (frozen, consumed not merged)

Consumed via `git show 3e8aea8:…` only. Canonical documents:

- `docs/contracts/conversion-outcome-intelligence-contract.md`
- `docs/contracts/conversion-outcome-to-attribution-learning-contract.md`
- Module authority (its branch): `api/lib/outcome/` — `business_outcomes`,
  `business_outcome_lifecycle_events` (stream-local provisional migration
  `0035_r7_a_conversion_outcome_foundation`, artefact only).

R7-B is a **downstream consumer** of the frozen outcome projection
`conversion-outcome/v1` (27-key allowlist). R7-B does **not** import, merge, or
re-implement R7-A code. The outcome consumption seam
(`api/lib/attribution/attribution-outcome-seam.ts`) validates the frozen
projection shape and reads outcome rows through a guarded table-existence
check; until R7-X convergence materialises the R7-A tables, the runtime
fail-closed degrades (no outcomes readable ⇒ attribution unavailable, never
fabricated).

Outcome fields R7-B depends on (from the frozen contract): `outcomeId`
(`out1:`), `businessId`, `leadId` (numeric, server-verified, nullable),
`leadIdentityVersion` (opaque R6-A seam reference), `conversionId` (`cnv1:`),
`outcomeType`, `outcomeStatus` (`OBSERVED/PROVISIONAL/VERIFIED/REVERSED/
CANCELLED/SUPERSEDED`), `valueType`, `amountMinor`, `currency`,
`evidenceAuthority`, `occurredAt`, `recordedAt`, reversal/renewal/supersession
lineage, `lifecycle`, and the verbatim causation/attribution disclaimers.

### 2.2 R6-E Conversion Tracking (in-tree, frozen)

`docs/contracts/conversion-event-contract.md`,
`docs/contracts/conversion-to-attribution-contract.md`,
`api/lib/conversion/*`, tables `conversion_events`,
`conversion_lifecycle_events` (migration `0034_r6_lead_autonomy_foundation`).

R7-consumable projection `conversion-to-attribution/v1` (22 keys). Provenance
references are **reference-only lineage, never causation**:
`sourceOpportunityId` (R5-D), `sourceEngagementReceiptId` (R5-C),
`sourceSignalId` (R5-A), `sourceCampaignId` (R4), `sourcePublicationId` (R4).
R7-B may use them as **observed-association touchpoints only**, at reduced
evidence class — never as causal authority.

### 2.3 R6-A Lead Identity (in-tree, frozen)

`docs/contracts/lead-identity-contract.md`, `api/lib/lead-identity/*`, tables
`lead_identities` (`lid1:` identities, `identityKey`, `userId`, `businessId`
nullable, `sourceOpportunityId`, `sourceHandoffId`, `firstObservedAt`,
`lastObservedAt`), `lead_identity_provenance` (immutable; `kind =
opportunity_handoff | identity_evidence | merge | conflict`; carries
`handoffId`, `opportunityId`, `campaignId`, `publicationId`, `occurredAt`),
`lead_identity_merges`. Hash-only identity; no raw PII anywhere.

### 2.4 R6-B Lead Scoring (in-tree, frozen)

`docs/contracts/lead-scoring-contract.md`, table `lead_score_snapshots`
(`lsc1:` leadScoreId, `lss1:` evidenceSnapshotId, **numeric `leadId`**,
`leadIdentityVersion` seam string, `scoringVersion`, `evidenceSnapshotHash`,
`computedAt`). Scores are evidence, never authority. Crucially, score
snapshots carry **both** the numeric `leads.id` key and the R6-A seam version —
they are the score-mediated binding between the two lead key families.

### 2.5 R6-C Lead Qualification (in-tree, frozen)

`docs/contracts/lead-qualification-contract.md`, tables `lead_qualifications`
(`lqu1:`, **lid1 `leadId`**, `leadIdentityVersion`, `leadScoreId` → numeric
score, `decision`, `evaluatedAt`, `validUntil`), `lead_qualification_reviews`.
C validated the score↔identity binding at evaluation time; R7-B consumes that
validated chain read-only.

### 2.6 R6-D Nurture / Sales Handoff (in-tree, frozen)

`docs/contracts/lead-nurture-sales-handoff-contract.md`, tables
`nurture_handoff_decisions` (`nd1:`, lid1 `leadId`, `occurredAt`),
`sales_handoffs` (`sh1:`, lid1 `leadId`, `preparedAt`, `dispatchedAt`,
`acknowledgedAt`), `handoff_dispatch_receipts` (`hd1:`, `occurredAt`),
`nurture_touch_records` (`nt1:`, lid1 `leadId`, `touchedAt`, `channel`).
Provider truth: only the fake/test transport dispatches; R7-B must not treat D
execution rows as evidence of real external contact (they are journey
touchpoints of bounded label only).

### 2.7 R6-F Lead Governance / Privacy (in-tree, frozen)

`docs/contracts/lead-governance-operations-contract.md`, table
`lead_privacy_states` (numeric `leadId`, `privacyState ∈ ACTIVE | SUPPRESSED |
RESTRICTED | RETENTION_PENDING | RETENTION_EXPIRED | ARCHIVED`). Per the
R6→R7 handoff contract §8, `SUPPRESSED/RESTRICTED/RETENTION_EXPIRED` are hard
stop signals for any optimisation action touching a lead — privacy overrides
all R7 authorities. R7-B enforces this as a fail-closed gate.

### 2.8 R5-D Opportunity Detection (in-tree, frozen)

`docs/contracts/opportunity-candidate-contract.md`, tables
`opportunity_candidates` (`opp1:` opportunityId, `userId`, `businessId`
**nullable**, `campaignId` numeric nullable, `publicationId` varchar
nullable, `actorKey`/`threadKey` keyed hashes, `firstObservedAt`,
`lastObservedAt`, `handedOffAt`), `opportunity_evidence` (`occurredAt`,
`sourceCampaignId`), `opportunity_suppressions`, `opportunity_handoffs`
(`oph1:` handoffId, envelope with `campaignId`, `publicationId`).

### 2.9 R5-C Autonomous Engagement (in-tree, frozen)

Table `engagement_receipts` (`engagementReceiptId`, `executionId`,
`businessId` NOT NULL, `userId`, `signalId`, `interpretationId`,
`actionRequestId`, `policyDecisionId`, `executedAt`, `status`). Receipts carry
no campaign/publication link directly — linkage runs through `signalId` →
`social_signals`.

### 2.10 R5-A Social Listening (in-tree, frozen)

Table `social_signals` (`sigv1:` signalKey, `userId`, `businessId` nullable,
`occurredAt`/`observedAt` timestamps, `sourceCampaignId`,
`sourcePublicationId` varchar, `sourcePublicationReceiptId`,
`attributionType ∈ direct | business | unattributed`). R5-A owns direct
publication binding; R7-B never re-resolves provider objects.

### 2.11 R4 Campaign / Publication provenance (in-tree, frozen)

Tables `campaigns` (`id`, `userId`, `businessId` nullable, `createdAt`,
`status`), `publishing_queue` (`id`, `userId`, `campaignId` NOT NULL,
`scheduledAt`, `publishedAt`, `platform`), publication receipts
(`operationId = publication:<platform>:<queueItemId>`, `queueItemId`,
`publishedAtIso`). Publication identity is fragmented across streams (see §4).

### 2.12 Infrastructure

- Audit: `api/lib/audit/audit-event.ts` (`AUDIT_EVENT_TYPES`,
  `createAuditEvent`, fingerprint-deduplicated `audit_events`).
- Router registry: `api/router.ts` (one additive registration per stream).
- Schema: `db/schema.ts` append-only; migrations append-only under
  `db/migrations/`.
- Test harness: in-memory fake DB replicating durable unique anchors
  (`api/r5-test-support.ts`, `api/conversion-acceptance.test.ts`).

## 3. What can be linked deterministically

All linkage is **tenant-anchored** (`userId` from the authenticated session
predicates every read) and **business-scoped** (house convention: a nullable
`businessId` links when null-or-equal to the outcome's `businessId`).

| # | Link | Mechanism | Authoritative? |
|---|---|---|---|
| L1 | outcome → conversion | `outcome.conversionId` verbatim | Yes (R7-A) |
| L2 | outcome → numeric lead | `outcome.leadId`, server-verified at outcome intake | Yes, when non-null |
| L3 | outcome → R6-A seam | `outcome.leadIdentityVersion` opaque reference | Verbatim only; carries no trust of its own |
| L4 | numeric lead → lid1 | score-mediated chain: `lead_score_snapshots` (numeric `leadId` + `leadScoreId`) → `lead_qualifications` (`leadScoreId` → lid1 `leadId`, `leadIdentityVersion`) | Yes — the R6-C-validated chain; consumed read-only through these surfaces, never reconstructed from bare ids |
| L5 | lid1 → R6-D journey events | `nurture_handoff_decisions` / `sales_handoffs` / `nurture_touch_records` / `handoff_dispatch_receipts` keyed by lid1 `leadId` | Yes (bounded labels only; fake-transport caveat preserved) |
| L6 | lid1 → R5 lineage | `lead_identity_provenance` (`kind = opportunity_handoff`: `handoffId`, `opportunityId`, `campaignId`, `publicationId`, `occurredAt`) | Yes |
| L7 | opportunity → campaign/publication | `opportunity_candidates.campaignId` / `publicationId`; handoff envelope copies | Yes (reference-only) |
| L8 | engagement → signal | `engagement_receipts.signalId` → `social_signals` | Yes |
| L9 | signal → campaign/publication | `social_signals.sourceCampaignId` / `sourcePublicationId` when `attributionType = direct` | Yes (R5-A-owned binding) |
| L10 | campaign/publication → tenant+business | `campaigns` / `publishing_queue` ownership re-verification | Yes |
| L11 | conversion → provenance refs | `conversion_events.sourceCampaignId` … | Reference-only lineage |
| L12 | journey ordering | authoritative per-row timestamps (`occurredAt`/`executedAt`/`touchedAt`/`publishedAt`/`computedAt`/`evaluatedAt`/`preparedAt`…), normalized to epoch ms | Yes, per row |

## 4. What cannot be linked deterministically (gaps)

| # | Gap | Consequence |
|---|---|---|
| G1 | **No direct campaign↔outcome link exists anywhere.** Campaigns never carry outcome references; outcomes never carry campaign references. | Campaign credit is always a **model output** over a reconstructed journey, never a lookup. |
| G2 | **Publication identity is fragmented.** `publishing_queue.id` (numeric), publication receipt `operationId` (string), `social_signals.sourcePublicationId` (varchar 255), `opportunity_candidates.publicationId` (varchar 255), `conversion_events.sourcePublicationId` (numeric). No single stable publication key spans streams. | R7-B must **not** re-resolve or stitch publication identity across streams. Publication touchpoints are admitted only with the identity exactly as carried by the authoritative linking row (signal direct binding or opportunity evidence); otherwise the touchpoint is excluded (lower confidence). |
| G3 | **Cross-key-family lead binding.** R6 journey events key on `lid1`; the outcome carries the numeric `leads.id`. | Only the L4 score-mediated chain may bind them. Absent a validated chain row, lid1 journey events are **ineligible** (fail closed), never fuzzy-matched. |
| G4 | **No fuzzy person matching is possible or permitted.** `actorKey`/`threadKey` are keyed one-way hashes; R6-A stores hash-only identity. | No cross-lead stitching, no cross-business stitching, no inferred events. |
| G5 | **R6-D execution rows are bounded labels.** Only the fake/test transport ever dispatched. | Nurture/handoff touchpoints carry channel/outcome labels only; they are chronology evidence, not proof of real external contact. |
| G6 | **Experimentation/baseline data does not exist in R7-B's upstream.** R7-D owns it. | R7-B can never compute incrementality or claim causal lift; association only. |
| G7 | **Timestamp type heterogeneity.** varchar ISO 8601 (conversion, outcome, opportunity, nurture, qualification) vs `timestamp` columns (social_signals, publishing_queue, computedAt…). | All timestamps are normalized to epoch ms at the reconstruction boundary; unparseable/implausible values fail closed (touchpoint excluded with reason; outcome timestamp invalid ⇒ evaluation fails closed). |
| G8 | **`unknown` conversion/outcome types** exist as reserved aggregation fallbacks. | Never fabricated into touchpoints; handled gracefully, attributed at reduced confidence only if legitimately present. |

## 5. Ambiguity handling — fail closed vs lower confidence

| Condition | Handling |
|---|---|
| Outcome unknown / not found for tenant | Fail closed (`FORBIDDEN` — mirrors R7-A; never reveals existence) |
| Outcome `businessId` ≠ session-context business / business not tenant-owned | Fail closed (`OWNERSHIP_MISMATCH`) |
| Outcome status `REVERSED` / `CANCELLED` / `SUPERSEDED` at evaluation | Fail closed — no active positive attribution is minted (`ATTRIBUTION_OUTCOME_NOT_ATTRIBUTABLE`) |
| Outcome status `PROVISIONAL` / `OBSERVED` | Attributable **only** per policy; confidence capped at `STRONG_ASSOCIATION` and reason code recorded |
| Outcome with `leadId = null` | Journey-attributable only when policy allows anonymous-outcome attribution; otherwise `INSUFFICIENT_EVIDENCE`; no linkage fabricated |
| Privacy state `SUPPRESSED` / `RESTRICTED` / `RETENTION_EXPIRED` | Hard stop — evaluation fails closed (`ATTRIBUTION_PRIVACY_BLOCKED`) |
| Touchpoint for a different lead | Excluded with reason (`TOUCHPOINT_LEAD_MISMATCH`) |
| Cross-tenant touchpoint | Impossible by construction (tenant predicates every read); any seam breach fails closed |
| Cross-business touchpoint (`businessId` neither null nor equal) | Excluded with reason (`TOUCHPOINT_BUSINESS_MISMATCH`) |
| Touch after outcome (`occurredAt` > outcome.occurredAt) | Excluded with reason (`TOUCHPOINT_AFTER_OUTCOME`) |
| Future-dated touch (beyond clock skew bound) | Rejected/excluded (`TOUCHPOINT_FUTURE_DATED`) |
| Outside attribution window | Excluded with reason (`TOUCHPOINT_OUTSIDE_WINDOW`) |
| Duplicate touch (same stable touchpoint identity) | Deduplicated — one touchpoint, no duplicated credit |
| Malformed touchpoint timestamp | Touchpoint excluded (`TOUCHPOINT_TIMESTAMP_INVALID`); outcome malformed ⇒ whole evaluation fails closed |
| Malformed lineage (provenance ref belonging to another tenant/lead/business) | Excluded with reason; never repaired |
| Missing intermediate journey events | Allowed — lowers evidence class |
| Reversal lineage present on outcome | Supersession semantics: prior attribution superseded by a zero-credit successor; history preserved |

## 6. Resulting design constraints (carried into the contract)

1. **Attribution identity** is deterministic over the full calculation
   material (outcome reference, model, model version, window, eligible
   touchpoint set, credit, classes, policy version) — no wall-clock, no
   randomness. Retries converge; conflicting replay fails closed.
2. **Two durable unique anchors** — `attributionId` and a natural key over
   `(userId, outcomeId, modelType, modelVersion, windowStart, windowEnd,
   journeyHash)` — give insert-first exact-once convergence while allowing
   supersession on new evidence (new journey hash).
3. **Credit is integer basis points**; total normalised exactly to 100000
   (100.000%) with deterministic largest-remainder rounding; no float drift.
4. **Closed model set** — `FIRST_TOUCH`, `LAST_TOUCH`, `LINEAR`,
   `POSITION_BASED`, `TIME_DECAY` — every one calculable deterministically
   from repository-native fields; versioned; no LLM in the path; no
   client-supplied weights (weights are model-version constants).
5. **Evidence/confidence taxonomy** derives from journey quality (chronology
   completeness, timestamp authority, lineage stability, outcome verification
   state) — never from model opinion, and never translated into causal proof.
6. **Immutability + supersession** — results are insert-only; changed inputs
   mint new results linked by `supersedesAttributionId` plus an immutable
   supersession fact.
7. **Read-only downstream projection** for R7-C with verbatim disclaimers.
8. **No upstream mutation** — R4/R5/R6/R7-A tables are never written by R7-B.
