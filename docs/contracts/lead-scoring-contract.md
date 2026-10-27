# CANONICAL LEAD SCORING CONTRACT (WBS-R6-B B1)

> **Stream:** WBS-R6 Stream B — Lead Scoring Autonomy
> **Module authority:** `api/lib/scoring/`
> **Schema:** `lead_score_snapshots` (provisional migration
> `0034_lead_scoring_foundation` — artefacts only, **not executed**; R6-X owns
> canonical sequencing)
> **Upstream (consumed, not redefined):** R5-D
> `docs/contracts/opportunity-candidate-contract.md`,
> `docs/contracts/opportunity-to-lead-autonomy-contract.md`; R6-A lead identity
> (contract pending — identity isolated behind `lead-identity-seam.ts`)
> **Audience:** R6-C (qualification), R6-X integration
> **Status:** authoritative as of the R6-B acceptance harness

This contract defines the single canonical lead-score record. R6-B owns
**lead scoring only**: evidence-bound feature extraction, deterministic bounded
score computation, honest confidence, reason codes, immutable versioning, and
exact-once replay. It does **not** own lead identity (R6-A), lead merging,
qualification, nurture, outreach, sales handoff, CRM ownership, conversion,
disposition, marketing action policy (R5-E), or campaign optimization.

**Required principle:** a lead score is **evidence, not a qualification
decision**. A high score must not by itself trigger sales outreach, mark a lead
qualified, or initiate any governed marketing action. R6-C derives
qualification separately under its own authority.

---

## 1. Version identities (closed)

| Constant | Value | Meaning |
|---|---|---|
| `LEAD_SCORING_CONTRACT_VERSION` | `lead-scoring/v1` | This contract. |
| `SCORING_VERSION` | `lead-scoring-engine/v1` | Scoring model/rules version. Any weights/formula change → bump → new immutable scores. |
| `FEATURE_VERSION` | `lead-scoring-features/v1` | Feature catalog version. Any feature add/remove/rename → bump. |
| `IDENTITY_SEAM_VERSION` | `lead-identity-seam/v1` | R6-A placeholder seam; replaced when R6-A publishes identity authority. |

## 2. Score record (`lead_score_snapshots` — immutable, append-only)

```ts
LeadScoreRecord {
  leadScoreId: string;                 // "lsc1:" + 64 hex — deterministic, server-minted only
  evidenceSnapshotId: string;          // "lss1:" + 64 hex — deterministic, server-minted only
  scoreContractVersion: "lead-scoring/v1";
  userId: number;                      // tenant anchor (session-derived only)
  businessId: number | null;           // from authoritative lead seam
  leadId: number;                      // canonical lead row id (R6-A seam today)
  leadIdentityVersion: string;         // seam-derived identity version (§8)
  scoringVersion: string;              // SCORING_VERSION that produced the score
  featureVersion: string;              // FEATURE_VERSION used
  evidenceSnapshotHash: string;        // sha256 over canonical evidence manifest (§5)
  evidenceManifest: EvidenceManifestEntry[];  // references + closed labels only, no text
  overallScore: number;                // 0–100 inclusive, integer
  scoreBand: ScoreBand;                // §3
  scoreConfidence: ScoreConfidence;    // §6 — honest ordinal, never a probability
  fitScore: number;                    // 0–100 component
  intentScore: number;                 // 0–100 component
  engagementScore: number;             // 0–100 component
  recencyScore: number;                // 0–100 component
  opportunityScore: number;            // 0–100 component
  componentWeights: Record<ComponentKey, number>;  // exact weights applied (§4)
  reasonCodes: ReasonCode[];           // bounded (≤ 8), closed vocabulary §7
  computedAt: string;                  // single explicit clock read at persistence boundary
  createdAt: string;
}
```

`EvidenceManifestEntry = { opportunityId, interpretationId, signalId,
signalVersion, kind, occurredAt }` — sorted deterministically
(by `opportunityId`, then `interpretationId`, then `kind`), sha256-verified.
No social text, no actor handles, no provider payloads, ever.

**Immutability:** rows are insert-only. There is no update or delete path in
the stream. Score history is the ordered set of rows for a lead.

## 3. Score range and bands

`overallScore ∈ [0,100]` integer. Bands (deterministic partition):

| Band | Range |
|---|---|
| `VERY_LOW` | [0, 20) |
| `LOW` | [20, 40) |
| `MEDIUM` | [40, 60) |
| `HIGH` | [60, 80) |
| `VERY_HIGH` | [80, 100] |

**`HIGH`/`VERY_HIGH` ≠ qualified.** Bands are evidence-density ordinals for
prioritization only. Qualification is R6-C authority.

## 4. Scoring model (exact, deterministic — `lead-scoring-engine/v1`)

Server-owned weights (clients can never supply or influence them):

```
fit 0.25 | intent 0.30 | engagement 0.15 | recency 0.15 | opportunity 0.15
```

`overallScore = clamp(round(0.25·fit + 0.30·intent + 0.15·engagement +
0.15·recency + 0.15·opportunity), 0, 100)`

Every component is computed by a pure function over the feature snapshot
(§4a–§4e). Same feature snapshot + same `SCORING_VERSION` → same components,
same overall, same identity. No randomness, no clock inside components
(recency takes explicit `now` from the caller boundary), no model.

### 4a. INTENT (0–100)

- `typeBase`: purchase_interest 50 · repeat_interest 55 ·
  demo_or_consultation_interest 45 · service_enquiry 40 ·
  support_to_sales_transition 35 · partnership_interest 35 ·
  referral_or_advocacy 15 · unresolved_complaint_opportunity 10 ·
  unknown 10 · retention_risk 5 · churn_risk 5
- `+ 20 × min(explicitHighCount, 2)` — evidence whose
  `opportunityTypeAtEvaluation` ∈ {purchase_interest, service_enquiry,
  partnership_interest, support_to_sales_transition, unresolved_complaint_opportunity,
  referral_or_advocacy} (R5 §6 explicit set) **AND** `overallConfidence = high`
  **AND** `relevance = relevant`.
- `+ 10 × min(explicitMediumCount, 1)` — same type set, `overallConfidence =
  medium`, `relevance ∈ {relevant, partially_relevant}`.
- Cap 100.

Praise-only or complaint-only evidence never matches the explicit set (R5-D
rules R12 keep praise/complaint out of sales types), so it cannot produce a
high intent score by construction.

### 4b. FIT (0–100)

- `typeRelevance` (0–1): purchase_interest 1.00 · repeat_interest 1.00 ·
  demo_or_consultation_interest 0.90 · service_enquiry 0.90 ·
  support_to_sales_transition 0.80 · partnership_interest 0.70 ·
  referral_or_advocacy 0.40 · unresolved_complaint_opportunity 0.20 ·
  unknown 0.20 · retention_risk 0.10 · churn_risk 0.10
- `campaignAlignment` (0–1): candidate `campaignId` non-null and lead
  `campaignId` non-null → 1.00 if equal else 0.30; candidate unattributed
  (null) → 0.40; lead has no campaign context → 0.50 (neutral).
- `fit = round(70 × typeRelevance + 30 × campaignAlignment)`.

### 4c. ENGAGEMENT (0–100)

- `+ 35 × min(validatedReceiptCount, 2)` — evidence rows
  `kind = engagement_receipt` with `contributesToStrength = true` (validated
  R5-C receipts only).
- thread continuation over contributing evidence: `≥ 3` distinct
  interpretations → `+30`; `= 2` → `+20`; else `+0`.
- Cap 100.

### 4d. RECENCY (0–100)

`ageHours = (now − lastObservedAt) / 3.6e6`, `lastObservedAt` = max evidence
`occurredAt` in the manifest (ISO, provider time). No evidence → 0.

| age | score |
|---|---|
| ≤ 24h | 100 |
| ≤ 72h | 80 |
| ≤ 168h | 60 |
| ≤ 336h | 30 |
| > 336h | 10 |

### 4e. OPPORTUNITY / EVIDENCE STRENGTH (0–100)

- ordinal base from candidate `evidenceStrength`: HIGH 70 · MEDIUM 50 ·
  LOW 20 · UNKNOWN 0
- `+ min(20, 5 × max(0, contributingEvidenceCount − 1))`
- `− 15 × contradictionCount` (floor 0)
- Cap 100.

## 5. Evidence snapshot / versioning (B5)

One lead + one evidence snapshot + one scoring version → one score identity.

```
manifest        = sort([{ opportunityId, interpretationId, signalId,
                          signalVersion, kind, occurredAt }])
evidenceSnapshotHash = sha256(canonicalJson(manifest))
evidenceSnapshotId   = "lss1:" + sha256(canonicalJson({ IDENTITY_SEAM_VERSION,
                          leadId, leadIdentityVersion, evidenceSnapshotHash }))
leadScoreId          = "lsc1:" + sha256(canonicalJson({ LEAD_SCORING_CONTRACT_VERSION,
                          userId, leadId, leadIdentityVersion,
                          evidenceSnapshotHash, scoringVersion, featureVersion }))
```

- Evidence rows are read through `opportunity-store` and are
  **hash-verified on read** (R5-D `assertEvidenceIntegrity`): tampered evidence
  fails closed before scoring. A score record whose stored manifest no longer
  hashes to `evidenceSnapshotHash` is tampering and fails closed on read
  (`SCORING_EVIDENCE_TAMPERED`).
- New evidence → new manifest → new snapshot hash → **new score row** (new
  version in history). Historical rows never change.
- Scoring/feature version bump → new `leadScoreId` → new immutable row.
- Replay of the same (lead, snapshot, version) re-reads the existing row
  (`idempotent_replay`) — exactly one durable score ever exists per identity.

## 6. Score confidence (B6 — honest ordinal, separate from score value)

`scoreConfidence ∈ LOW | MEDIUM | HIGH | UNKNOWN`. It reflects evidence
completeness, freshness, source strength, contradictions, and missing features
— never model self-confidence and never a calibrated probability. Derivation
(caps applied top-down, floor at the lowest applicable class):

| Condition | Cap |
|---|---|
| No opportunity evidence (`evidenceCount = 0`) or `evidenceStrength = UNKNOWN` | `UNKNOWN` |
| `evidenceStrength = LOW` | `LOW` |
| `contradictionCount > 0` | `LOW` |
| `lastObservedAt` missing, or age > 336h | `LOW` |
| age > 168h (stale) | `MEDIUM` |
| exactly one distinct interpretation (single source) | `MEDIUM` |
| recency evidence missing → see row above; engagement receipts absent | `MEDIUM` only if other groups complete |

A high numeric score with `LOW` confidence remains explicitly low-confidence in
every projection. **High score + LOW confidence is a valid, honest state.**

## 7. Reason codes (closed, bounded ≤ 8)

`STRONG_PURCHASE_INTENT, REPEATED_INTENT_SIGNALS, EXPLICIT_SERVICE_ENQUIRY,
PARTNERSHIP_INTEREST, VALIDATED_ENGAGEMENT_RESPONSE, RECENT_EVIDENCE,
HIGH_EVIDENCE_STRENGTH, CAMPAIGN_ALIGNED, NEUTRAL_CAMPAIGN_ALIGNMENT,
STALE_EVIDENCE, LOW_EVIDENCE_STRENGTH, CONTRADICTING_EVIDENCE,
SINGLE_EVIDENCE_SOURCE, MISSING_ENGAGEMENT_EVIDENCE, MISSING_RECENCY_EVIDENCE,
INSUFFICIENT_EVIDENCE, PRAISE_ONLY_EVIDENCE, COMPLAINT_ONLY_EVIDENCE,
UNRESOLVED_COMPLAINT_SIGNAL`

Emission: dominant positive drivers (by weighted contribution) + mandatory
caveats (stale/contradiction/missing/single-source). Bounded list — reason
codes explain; they never authorize action.

## 8. Lead identity seam (R6-A pending)

`leadIdentityVersion = "lead-identity-seam/v1:" + sha256(canonicalJson({
leadId, userId, businessId, campaignId }))` — derived server-side from the
durable lead row. Lead existence and tenant ownership are re-verified
server-side on every scoring call; forged or cross-tenant `leadId` fails
closed (`LEAD_NOT_FOUND` / `OWNERSHIP_MISMATCH`). When R6-A publishes identity
authority, only `api/lib/scoring/lead-identity-seam.ts` changes.

## 9. Exact-once / concurrency (B7)

All convergence is DB-authoritative (unique keys — no in-memory dedupe):

- unique `(userId, leadId, evidenceSnapshotHash, scoringVersion)` → duplicate
  and concurrent scoring converge to one row; losers re-read (`idempotent_replay`).
- unique `leadScoreId` → deterministic identity collision is impossible.
- stale evidence cannot overwrite a newer score: scores are insert-only; newer
  evidence mints a new row.
- cross-business/cross-tenant leads are rejected at the identity seam before
  any evidence is read; evidence scope is always re-validated against the
  lead's tenant/business/campaign attribution.

## 10. Privacy / fairness restrictions

- No protected-trait or demographic features — forbidden list is rejected at
  feature validation (race, ethnicity, religion, sex/gender, sexual
  orientation, health, political affiliation, disability, socioeconomic class,
  speculative demographics). Feature provenance is recorded per feature
  (source: R5 candidate / R5 evidence / lead identity / derived).
- No raw provider text, handles, tokens, or PII in scores, manifests, or audit
  metadata — opaque references and closed labels only.
- No model in v1 (see B4 decision): deterministic path is non-billable, no
  `ai_usage` rows, no reservations.

## 11. Downstream surface (B8)

R6-C consumes the read-only projection defined in
`docs/contracts/lead-scoring-to-qualification-contract.md`. R6-C must not
overwrite scores, alter weights, equate score with qualification, or mutate
evidence snapshots.

## 12. AI-augmented feature extraction decision (B4)

**Verdict: NOT USED.** Deterministic R5-B/R5-D evidence fully covers the v1
feature model; no legitimate gap exists that would justify a model in the
scoring path. Consequences, affirmed:

- The scoring path contains no `runAgent` call, no prompt, no model output —
  prompt-injection and malformed-model-output adversarial classes are
  structurally impossible here (acceptance case 23/24).
- Non-billable: no reservation, no `ai_usage` row, no `agent_runs` entry;
  retries cannot double-charge because nothing is charged.
- If a future governed need emerges, AI may assist feature extraction only
  under these standing constraints: structured output validated against a
  strict schema; untrusted text delimited and never concatenated into
  instructions; bounded effect on the final score (weights remain
  server-owned and deterministic); no hidden reasoning persisted; failure
  falls back to UNKNOWN/insufficient evidence, never invented confidence;
  stable server-derived model operation identity with exact-once billing per
  R4/R5 financial policy. The deterministic score computation itself must
  remain non-billable and unchanged in authority.

---

**R6-C/R6-X: consume lead scores through this contract. Do not redefine
scoring authority. A score is evidence, not a decision.**
