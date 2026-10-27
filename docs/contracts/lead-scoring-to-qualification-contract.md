# LEAD SCORING → QUALIFICATION CONTRACT (WBS-R6-B → R6-C)

> **Producer:** R6-B (Lead Scoring), branch `feature/r6-b-lead-scoring`
> **Consumer:** R6-C (Lead Qualification)
> **Status:** canonical handoff contract — R6-C consumes, does not redefine
> **Source of truth:** `docs/contracts/lead-scoring-contract.md` (R6-B canonical
> scoring contract) + `api/lib/scoring/scoring-service.ts` projection
> **Upstream (consumed, not merged):** R5-D opportunity contracts; R6-A lead
> identity (pending — R6-B consumes through `lead-identity-seam.ts`)

This contract defines the read-only surface over which R6-C may consume lead
scores. **A lead score is evidence, not a qualification decision.** R6-C
derives qualification under its own authority; nothing here authorizes
outreach, nurture, CRM mutation, conversion, or any governed marketing action.

---

## 1. Score identity

- `leadScoreId` — `"lsc1:" + sha256(canonicalJson({scoreContractVersion,
  userId, leadId, leadIdentityVersion, evidenceSnapshotHash, scoringVersion,
  featureVersion}))` — deterministic, server-minted, immutable. R6-C must
  treat it as an opaque immutable reference.

## 2. Lead identity / version binding

- Scores bind `leadId` + `leadIdentityVersion` (`lead-identity-seam/v1:<hash>`
  until R6-A publishes authority). R6-C must not re-derive, merge, or repair
  identity from score rows; identity corrections are R6-A records, and a
  changed identity mints new score versions, never edits.

## 3. Scoring version

- `scoringVersion` (`lead-scoring-engine/v1`), `featureVersion`
  (`lead-scoring-features/v1`), `scoreContractVersion` (`lead-scoring/v1`).
  Any model change → new versions → new immutable score rows. R6-C must
  consume the version fields and never compare scores across versions as if
  identical.

## 4. Evidence snapshot identity

- `evidenceSnapshotId` (`"lss1:" + …`) + `evidenceSnapshotHash` (sha256 over
  the canonical manifest). The manifest is references + closed labels only
  (no social text, no actor PII). R6-C must treat it as read-only provenance;
  tamper drift fails closed (`SCORING_EVIDENCE_TAMPERED`).

## 5. Overall score range

- `overallScore ∈ [0,100]` integer, deterministic per (lead, evidence
  snapshot, scoring version).

## 6. Score bands

- `VERY_LOW [0,20) · LOW [20,40) · MEDIUM [40,60) · HIGH [60,80) · VERY_HIGH
  [80,100]`. **HIGH/VERY_HIGH ≠ qualified.** Bands are evidence-density
  ordinals for prioritization only.

## 7. Confidence semantics

- `scoreConfidence ∈ LOW | MEDIUM | HIGH | UNKNOWN` — bounded honest ordinal,
  **never a calibrated probability** and never model self-confidence. A high
  score with LOW confidence is a valid state and must remain explicitly
  low-confidence in any R6-C derivation.

## 8. Component scores

- `fitScore`, `intentScore`, `engagementScore`, `recencyScore`,
  `opportunityScore` (each 0–100) + `componentWeights` (exact weights
  applied). Components are inspectable evidence; R6-C may read them but must
  not recompute the score or apply its own weights to them.

## 9. Allowed feature groups

- FIT (opportunity-type relevance, campaign alignment), INTENT (R5 §6 explicit
  evidence), ENGAGEMENT (validated R5-C receipts, thread continuation),
  RECENCY (evidence age vs scoring clock), OPPORTUNITY (R5 evidence strength,
  coverage, contradictions). All deterministic, all provenance-carrying.

## 10. Forbidden feature groups

- Race, ethnicity, religion, sex/gender, sexual orientation, health,
  political affiliation, disability, socioeconomic class, income, age,
  speculative demographics — rejected at the feature boundary
  (`FORBIDDEN_FEATURE`). R6-C must never supply, request, or derive such
  features through this surface.

## 11. Reason codes

- Bounded (≤ 8) closed vocabulary (`STRONG_PURCHASE_INTENT`,
  `REPEATED_INTENT_SIGNALS`, `RECENT_EVIDENCE`, `STALE_EVIDENCE`,
  `LOW_EVIDENCE_STRENGTH`, `CONTRADICTING_EVIDENCE`, `SINGLE_EVIDENCE_SOURCE`,
  `MISSING_ENGAGEMENT_EVIDENCE`, `INSUFFICIENT_EVIDENCE`,
  `PRAISE_ONLY_EVIDENCE`, `UNRESOLVED_COMPLAINT_SIGNAL`, …). Codes explain;
  they never authorize action.

## 12. Evidence freshness

- `evidenceFreshness.latestObservedAt` (max manifest `occurredAt`, ISO) +
  `computedAt` (single scoring-clock read). R6-C must check freshness before
  acting on a score and must not treat stale evidence as current signal.

## 13. Versioning semantics

- One lead + one evidence snapshot + one scoring version → one score
  identity. New evidence → new row (new history entry). Version bump → new
  row. Replays converge to the existing row (`idempotent_replay`). History is
  `listHistory`, oldest first; rows are immutable.

## 14. Immutable fields

- All fields of a persisted score record are immutable. There is no update or
  delete path. Corrections are new score versions.

## 15. Billable / non-billable semantics

- The scoring path is **non-billable**: deterministic rules only — no model,
  no `runAgent`, no reservation, no `ai_usage` row. R6-C must not attach
  billing to score consumption.

## 16. Fields R6-C may consume

`leadScoreId, leadId, leadIdentityVersion, scoringVersion, featureVersion,
scoreContractVersion, evidenceSnapshotId, evidenceSnapshotHash, overallScore,
scoreBand, scoreConfidence, fitScore, intentScore, engagementScore,
recencyScore, opportunityScore, componentWeights, reasonCodes,
evidenceFreshness, computedAt, createdAt, businessId, userId,
duplicateClassification`.

Surface: `scoring.scoreLead({leadId})`, `scoring.get({leadScoreId})`,
`scoring.listHistory({leadId})` — all tenant-scoped, authed-only.

## 17. Fields downstream must not mutate

- All of them. Scores, snapshots, weights, evidence manifests, and R5 rows
  are read-only for R6-C. Corrections are new R6-B/R6-A records, never edits
  (R5 tables are not shared-writable; `lead_score_snapshots` is insert-only).

## 18. Schema dependencies

- `lead_score_snapshots` — provisional migration `0034_lead_scoring_foundation`
  (**artefacts only, not executed**; R6-X owns sequencing). No FK constraints;
  enforcement in query predicates. Distinct from legacy `lead_scores`
  (audience-intelligence pipeline) — never shared.

## 19. Overlap-risk files

| Area | Files | Rule |
|---|---|---|
| Score producer | `api/lib/scoring/*`, `api/scoring-router.ts` | R6-B owned |
| Lead/CRM | `api/lead-router.ts`, `leads`, `lead_activities` | R6-C evolves; R6-B never writes |
| Legacy scoring | `lead_scores`, `api/lib/audience/scoring.ts` | untouched; separate vocabulary |
| Opportunity evidence | `api/lib/opportunity/*` | read-only for both streams |
| Router registry | `api/router.ts` | additive only |
| Audit taxonomy | `api/lib/audit/audit-event.ts` | additive `lead_score_recorded` only |

## 20. Security / fairness invariants

1. Tenant isolation: `userId` anchors every score row and query; R6-C reads
   only within its tenant.
2. No client authority: identity, scores, confidence, and versions are
   server-minted; strict schemas reject injected fields.
3. Score ≠ qualification: consuming a score authorizes nothing by itself.
4. Fairness: forbidden features never influence a score; R6-C must not
   reintroduce them downstream.
5. Privacy: scores and manifests carry opaque references and closed labels
   only — no social text, handles, tokens, or PII.
6. Injection resistance: closed vocabularies + strict schemas at every seam.
7. Exactly-once, replay-safe, fail-closed on hash drift or stale evidence.

---

**R6-C: consume lead scores through this contract. Derive qualification
separately. A score is evidence, never a decision.**
