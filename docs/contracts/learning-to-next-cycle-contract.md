# LEARNING → NEXT-CYCLE CONTRACT (WBS-R4 Stream D → Stream A / Integration)

> **Status:** authoritative contract for Stream A (`feature/r4-a-core-autonomy`)
> and integration/r4-full-autonomy.
> **Owner:** Stream D (learning autonomy). **Consumers:** Stream A (Strategy
> dispatch / next-cycle orchestration), integration.
> **Provenance:** every rule below is exercised by
> `api/lib/learning/multi-cycle-learning-evidence.test.ts` (three successive
> synthetic cycles) and the suites listed under *Verification*.

Stream D produces **approved learning evidence**. Stream A consumes that
evidence to create the NEXT governed Strategy version. This document is the
exact contract between the two streams: what the evidence is, where it lives,
and what makes it valid or invalid.

---

## 1. Learning evidence fields (exact set Stream A consumes)

For one optimisation cycle, Stream A needs exactly this material. Field names
refer to the sealed `ApprovedPromotionEnvelope`
(`api/lib/learning/promotion/promotion-envelope.ts:43`) plus identity helpers.

| Field | Source | Rule |
|---|---|---|
| `campaignId` | envelope `.campaignId` | positive integer; durable campaign identity |
| `strategyHashSha256` | the CURRENT authoritative Strategy hash | 64-char lowercase hex; the hash of the immutable `strategy_snapshots` row the cycle starts from (Stream A must re-resolve it, never cache it across cycles) |
| `proposalFingerprints` | set of envelope `.proposalFingerprint` | canonical SET: unique, sorted, non-empty; 64-char hex each |
| sealed approval provenance | envelope `.approvalRequestId`, `.decidedAt`, `.decidedByUserId`, `.decision` | `.decision` must be exactly `"approved"` |
| `learningRecordId` | envelope `.learningRecordId` | durable learning record identity |
| `evaluationVersion` | envelope `.evaluationVersion` | currently `learning-v2` (`LEARNING_CYCLE_EVALUATION_VERSION`) |
| `learningEngineVersion` | envelope `.learningAuthority.engineVersion` | engine authority version |
| `recommendationId` | envelope `.promoted.recommendationId` | scoped to its learning record; uniqueness key is `(learningRecordId, recommendationId)` |
| `nextCycleIdentity` | `buildNextCycleIdentity({campaignId, strategyHashSha256, proposalFingerprints})` | deterministic `next-cycle:v1:` + SHA-256; input-order canonicalised; no timestamps |

The full evidence bundle per cycle is exactly the shape asserted in the
multi-cycle harness (`CycleEvidence` in
`api/lib/learning/multi-cycle-learning-evidence.test.ts`).

## 2. Authoritative source modules (consume, do not duplicate)

| Capability | Module (import from here) |
|---|---|
| Sealed approved envelopes (fail-closed availability) | `api/lib/learning/promotion/promotion-service.ts` → `getApprovedPromotionEnvelopes` |
| Envelope type + shape | `api/lib/learning/promotion/promotion-envelope.ts` |
| Scope resolution (same-business / same-campaign fail-closed) | `api/lib/learning/learning-strategy-consumption.ts` → `resolveApprovedLearningPromotionsForStrategy` |
| Prompt section embedding | `learning-strategy-consumption.ts` → `buildApprovedLearningPromotionPromptSection` |
| Lineage entries for the NEW Strategy snapshot | `learning-strategy-consumption.ts` → `buildStrategyLearningPromotionLineage`, `strategyLearningPromotionLineageToJson` |
| Next-cycle identity | `learning-strategy-consumption.ts` → `buildNextCycleIdentity`, `NEXT_CYCLE_IDENTITY_PREFIX` |
| Instruction envelope (parse, strict) | `learning-strategy-consumption.ts` → `parseNextCycleInstruction` |
| Proposal sealing hooks (approval flow) | `api/lib/learning/promotion/promotion-decision.ts` |
| Dataset (KPI input authority) | `api/lib/learning/performance/loader.ts` + `dataset.ts` |
| Governed cycle | `api/lib/learning/learning-cycle-service.ts` → `runGovernedLearningCycle` |

Stream A must NOT re-derive fingerprints, re-parse envelopes, or re-implement
scope rules — call these modules.

## 3. Sealed approval requirements

An envelope is **authoritative** only when ALL hold (enforced by
`getApprovedPromotionEnvelopes`, revalidated live on every read):

1. The approval row is terminal `approved` (guarded pending-only transition).
2. `context` strictly parses (`extractLearningPromotionContext`) and the
   stored fingerprint rebinds the coordinates exactly.
3. A `learning_promotion_resolved` audit event seals the envelope and matches
   the context (`envelopeMatchesContext`).
4. The live learning record still matches every bound coordinate (record id,
   campaign, evaluation version, engine, engine version, input digest) and the
   recommendation material is unchanged.

Any drift → the envelope is excluded (returns `null` / empty list). Sealed
envelopes and historical learning records are immutable; later cycles never
rewrite them.

## 4. Canonical proposal fingerprint rules

- `buildLearningPromotionProposalFingerprint(coordinates)` = SHA-256 over the
  key-sorted canonical JSON of the exact coordinates (no timestamps).
- Idempotency key `lp:{fingerprint}` is unique; identical material replays to
  the SAME proposal row; the same key with drifted material fails closed
  (CONFLICT).
- In the next-cycle identity, fingerprints are a SET: sorted before hashing,
  duplicates rejected, empty set rejected.

## 5. Strategy hash expectations

- `strategyHashSha256` is the 64-char lowercase hex digest of the immutable
  strategy snapshot the cycle starts from (`strategy_snapshots.strategyHashSha256`,
  surfaced through the dataset as
  `dataset.strategyAuthority.snapshot.strategyHashSha256`).
- The NEW Strategy version Stream A creates must carry the
  `StrategyLearningPromotionLineageEntry[]`
  (`buildStrategyLearningPromotionLineage`) inside its snapshot payload so the
  new snapshot is reconstructable as: Business DNA + campaign objective +
  approved learning promotions.
- The next cycle's learning record MUST bind the new snapshot's hash through
  `provenance.wbs15.strategyAuthority.strategyHashSha256` (asserted for cycles
  2 and 3 in the harness).

## 6. Retry / idempotency semantics

| Action | Semantics |
|---|---|
| Governed cycle per (campaign, version, window) | idempotent: unique `lr:{campaign}:{version}:{windowStart}:{windowEnd}`; replay re-reads the winner (`idempotentReplay: true`) |
| Proposal per exact recommendation | idempotent (`lp:{fingerprint}`); one durable proposal, no duplicate promotion authority |
| Approval decision | guarded pending-only transition; double decision → BAD_REQUEST, still one sealed envelope |
| Sealed envelope persistence | fingerprint-deduplicated audit insert; exact replay inserts nothing |
| Observation persistence | upsert on deterministic `obs:{sha256}` observation id — retries never duplicate durable metrics |
| Engagement persistence | upsert on `dedupHash` (events) / unique `(campaignId, externalIdentifier)` (interest signals) |

## 7. Invalid / pending / rejected conditions (fail closed)

| Condition | Result |
|---|---|
| Proposal pending (not decided) | never consumable; contributes no fingerprint; `buildNextCycleIdentity` with an empty set throws |
| Proposal rejected | auditable, never consumable, no envelope sealed |
| Context tampered / fingerprint mismatch | decision refused (PRECONDITION_FAILED); envelope excluded |
| Learning authority drifted after proposal | decision refused; envelope excluded on read |
| Missing strategy snapshot / unapproved lineage | dataset `authority_missing`; cycle returns `authority_missing`, nothing persisted |
| `strategyHashSha256` not 64-char hex | `buildNextCycleIdentity` throws |
| Duplicate/blank proposal fingerprints | `buildNextCycleIdentity` throws |
| Cross-business scope | `resolveApprovedLearningPromotionsForStrategy` only returns same-business (or fail-closed same-campaign) envelopes; other businesses owned by the same user are never consulted |

## 8. Known integration dependencies

1. **Strategy agent consumption** already exists
   (`api/lib/agents/strategy-agent.ts` consumes
   `resolveApprovedLearningPromotionsForStrategy` + prompt section + lineage
   builders). Stream A dispatches the next cycle; Stream D does not dispatch.
2. **Next-cycle instruction persistence** lives in Stream A's boundary
   (`api/lib/workflow/next-cycle-persistence.ts`,
   `next-cycle-trigger.ts`, `next-cycle-dispatcher.ts` — WBS-R1.2A). Stream D
   provides the identity material only.
3. **Post-live lifecycle scheduler** (campaign-state reconciliation that runs
   the post-live learning trigger) remains default-off in Stream D
   (`POST_LIVE_LIFECYCLE_ENABLED`); the metrics-observation scheduler is
   default-on as of WBS-R4-D1. Activating lifecycle reconciliation is an
   operational decision for integration.
4. **Live provider metric reads** are intentionally NOT wired (fail-closed
   bindings). Until a provider expansion lands, observed metrics arrive from
   manual analytics recording and the engagement ingest; the learning chain is
   fully functional on those.
5. **Migrations 0027 / 0028** (analytics.observationId, campaign interest
   signal actor unique key) are generated but intentionally NOT executed by
   this stream; execution belongs to the deployment gate.

## 9. Verification

- `api/lib/learning/multi-cycle-learning-evidence.test.ts` — D5 three-cycle
  contract harness (2 tests).
- `api/lib/learning/performance/loader-isolation.test.ts` — D3 dataset
  authority/isolation (6 tests).
- `api/lib/workflow/post-live-metrics-observation-persistence.test.ts` — D2
  idempotent observation persistence (11 tests).
- `api/lib/audience/ingest-engagement-dedup.test.ts` — D2 engagement
  idempotency (6 tests).
- `api/learning-router.test.ts`, `api/learning-promotion-router.test.ts`,
  `api/lib/learning/promotion/*.test.ts`,
  `api/lib/learning/learning-cycle-service.test.ts` — D4 authorization,
  sealing, idempotency, drift (existing + added).
