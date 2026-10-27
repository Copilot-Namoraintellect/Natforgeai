# R6-B LEAD SCORING AUTONOMY — REPOSITORY / SCORING INVENTORY (B0)

> **Stream:** WBS-R6 Stream B — Lead Scoring Autonomy
> **Branch:** `feature/r6-b-lead-scoring` (base `a947ecb`)
> **Date:** 2026-06-28
> **Verdict:** repository scanned; scoring authority is **greenfield but surrounded by
> three legacy scorers and one name collision** — the stream must carve a new,
> R6-owned scoring surface without redefining any of them.

---

## 1. Authority consumed (read, not redefined)

| Authority | Path | Use |
|---|---|---|
| R5-D opportunity candidate contract | `docs/contracts/opportunity-candidate-contract.md` | Canonical pre-lead evidence: types, confidence/evidence-strength ordinals, immutable hash-verified evidence rows, expiry window (168h default). |
| R5-D → R6 handoff contract | `docs/contracts/opportunity-to-lead-autonomy-contract.md` | §7 opportunity confidence is **not** a lead score; §16 R6 derives its own score/rationale; §17 R6 state in R6-owned tables, never mutate R5 rows; §19 do not execute/renumber migrations. |
| R5 supporting contracts | `social-signal`, `social-intelligence`, `engagement-to-opportunity`, `marketing-action-policy`, `marketing-operations-governance` | Vocabulary + boundaries (read-only consumption). |
| R6-A lead identity | **NOT AVAILABLE.** Branch `feature/r6-a-lead-identity` sits at the base commit `a947ecb` (zero stream commits); `docs/contracts/lead-identity-to-scoring-qualification-contract.md` does not exist on that ref. | R6-B isolates identity behind `api/lib/scoring/lead-identity-seam.ts`; the seam is the single convergence point when R6-A lands. Do **not** merge R6-A. |

---

## 2. Existing score-like fields and heuristics (do NOT redefine)

| # | Location | What it is | Collision rule |
|---|---|---|---|
| S1 | `leads.score` (`db/schema.ts:409`), writers: `api/lead-router.ts:205-340` (`autoScore`/`bulkAutoScore` — source-weight map + attribute bonuses, auto-promotes status at 50/80), `api/lib/agents/audience-intelligence-agent.ts:559`, `api/lib/agents/engagement-agent.ts:203` | Mutable 0-100 CRM convenience score | R6-B **never writes** `leads.score` and never auto-promotes lead status. Score ≠ qualification stays structurally true. |
| S2 | `lead_scores` table (`db/schema.ts:1015-1053`) — audience-intelligence pipeline (`externalIdentifier`-keyed, AI + baseline, `reach_out/nurture/ignore`) | Per-campaign social-profile score with `confidence` low/med/high | **Table name taken** (`ls_` index prefix taken). R5-B inventory (`docs/recovery/r5-b-intent-sentiment-inventory.md:63`) reserves this vocabulary ("persisted scoring vocabulary B must not silently re-define"). R6-B uses NEW tables (`lead_score_snapshots`, `lss_` prefix). Also gates `api/lib/workflow/post-live-lifecycle-db.ts:186` (`hasLeadScoreSince`) — do not touch. |
| S3 | `api/lib/audience/scoring.ts` (`computeBaselineScore`, `confidenceFromScore`, `actionFromScore`) | Deterministic bounded recency-decayed engagement score (0-100) for audience events | Reusable **pattern only** (bounded weights, recency multiplier); not a lead scorer, no R5 evidence binding. R6-B does not import or mutate it. |
| S4 | `api/lead-router.ts` source weights (referral 40, whatsapp 30, tiktok 10, +attribute bonuses) | Lead-source heuristic | Behavioral source weighting precedent; R6-B documents its own weights; no protected-trait inputs exist anywhere in these tables. |
| S5 | `opportunityCandidates.confidenceClass/evidenceStrength` (`db/schema.ts:2139-2140`) | Bounded deterministic ordinals (LOW/MEDIUM/HIGH/UNKNOWN), **explicitly not calibrated probabilities and not a lead score** (contract §6/§7) | Consumed as EVIDENCE STRENGTH input to scoring; never surfaced as the score. |
| S6 | `outreachRecommendations.priority`, `contentPosts.engagementScore`, `learningRecords.confidence` | Unrelated scores | Out of scope; untouched. |

## 3. Reusable R5 opportunity evidence (read-only consumption)

`api/lib/opportunity/` — consumed via store + contract modules only (never writes):

- `opportunity-store.ts`: `listCandidates`, `findCandidateByOpportunityId`, `listEvidenceForCandidate` (hash-verified on read — tampered evidence fails closed before scoring), `findHandoff`/`listHandoffs`.
- `opportunity-contract.ts`: closed vocab (`OPPORTUNITY_TYPE_VALUES`, `CONFIDENCE_CLASS_VALUES`, …), `canonicalJson`, `sha256Hex`, `EvidenceRefSchema`.
- `evidence-strength.ts`: deterministic recompute-over-window + recency cap — **design precedent** for B3/B6.
- `detector.ts` `handoffToR6`: envelope manifest + `evidenceSnapshotHash` pattern — **design precedent** for B5.
- Tables: `opportunity_candidates`, `opportunity_evidence` (immutable, `evidenceHash`), `opportunity_handoffs` (exactly-once envelopes).

Feature-source mapping (R5 → R6-B feature groups):

| R6-B group | R5 source |
|---|---|
| FIT | `opportunityType` relevance table; `campaignId` alignment candidate↔lead |
| INTENT | `opportunityTypeAtEvaluation` + immutable copies of R5-B labels on evidence rows (`intent`, `overallConfidence`, `relevance`) |
| ENGAGEMENT | evidence `kind = engagement_receipt` rows (validated R5-C receipts, `contributesToStrength`); distinct-interpretation count (thread continuation) |
| RECENCY | `lastObservedAt` vs scoring clock (explicit `now`, no hidden wall-clock) |
| EVIDENCE STRENGTH / OPPORTUNITY | `confidenceClass`, `evidenceStrength`, `evidenceCount`, `contradictionCount` |

Campaign performance (`analytics` table: impressions/clicks/conversions/leads/revenue/engagement/followers/reach) was evaluated as a feature source and **excluded from v1**: per-campaign aggregates are not per-lead evidence and would dilute the evidence-bound principle. Documented as external limitation.

## 4. Candidate feature sources (evaluated)

| Source | Verdict |
|---|---|
| R5 opportunity candidates + evidence | **Primary** (v1) |
| R5-C engagement receipts via opportunity evidence | **Primary** (v1 enrichment) |
| `leads` row identity fields (campaignId, businessId) | Identity binding only (via seam), never a scoring feature |
| `lead_activities` (CRM activity log) | **Excluded v1** — CRM-owned, mutable, post-qualification; mixing it would blur score/qualification boundary |
| `analytics` aggregates | **Excluded v1** (not per-lead) |
| `campaign_interest_signals` / audience events | **Excluded v1** — belongs to S2/S3 pipeline vocabulary |
| AI-extracted features (B4) | **Not used** — deterministic R5 features fully cover v1 requirements |

## 5. Model boundaries

- **R6-B owns:** input contract, feature model, score computation, components
  (fit/intent/engagement/recency/opportunity), confidence, versioning, reason
  codes, replay/idempotency, history, observability (audit).
- **R6-B reads (never writes):** `opportunity_*`, `leads` (identity seam),
  `campaigns` (ownership validation).
- **R6-B never touches:** `lead_scores` (S2), `leads.score` (S1),
  `lead_activities`, `outreach_recommendations`, policy tables (R5-E read-only
  boundary), billing (non-billable stream), R5 migration artefacts.
- **Downstream:** R6-C qualification consumes only the read-only projection
  (contract: `docs/contracts/lead-scoring-to-qualification-contract.md`).

## 6. Bias / proxy risks

- **Good baseline:** no protected-trait or demographic columns exist in `leads`,
  `lead_scores`, or `opportunity_*` tables (schema-verified).
- **Guarded risks:** follower counts / handles exist only in the audience-agent
  profile schema — R5 envelopes deliberately strip them, so the v1 feature set
  (envelope/reference-only) cannot reach them. Feature model carries an explicit
  forbidden-feature list (race, ethnicity, religion, sex/gender, sexual
  orientation, health, political affiliation, disability, socioeconomic class,
  speculative demographics) rejected at validation.
- **Geography:** `businesses.location` exists; geographic lead scoring would
  require a governance decision — **excluded v1**.
- **No opaque model reasoning** anywhere in the path; no AI in v1 (B4 verdict).

## 7. Overlap-risk files

| File | Rule |
|---|---|
| `api/router.ts` | additive `scoring` registration only |
| `db/schema.ts` | append new `lead_score_snapshots` table only; do not alter S1/S2 tables |
| `db/migrations/` + `meta/_journal.json` | next canonical index **0034** (`0034_lead_scoring_foundation`); generate via drizzle-kit offline; **do not execute**; do not touch 0029-0033 |
| `api/lib/audit/audit-event.ts` | additive `lead_score_recorded` event type only (closed taxonomy) |
| `api/lead-router.ts` | untouched — `autoScore` semantics preserved |
| `api/lib/audience/scoring.ts`, `audience-intelligence-agent.ts` | untouched — S2/S3 vocabulary preserved |
| `api/lib/opportunity/*` | read-only consumption; no edits |
| `api/lib/workflow/post-live-lifecycle-db.ts` | untouched (S2 gate) |

## 8. Schema implications

- **New table:** `lead_score_snapshots` (immutable, append-only score records;
  history = ordered rows). Unique convergence key
  `(userId, leadId, evidenceSnapshotHash, scoringVersion)`; unique
  `leadScoreId`. Index prefix `lss_`.
- **No FK constraints** (repo convention; enforcement in query predicates).
- **Migration:** `0034_lead_scoring_foundation.sql` + snapshot, generated
  offline, **not executed** (R6-X owns convergence; consistent with R5-X
  precedent `docs/recovery/r5-x-migration-convergence.md`).
- `db/relations.ts` needs no changes.

## 9. R6-A dependency points (seam isolation)

`feature/r6-a-lead-identity` == base commit; no contract file. All identity
assumptions isolated in `api/lib/scoring/lead-identity-seam.ts`:

- resolves lead existence + tenant ownership server-side from the durable
  `leads` row (forged / cross-tenant `leadId` → fail closed);
- derives `leadIdentityVersion` deterministically from durable lead coordinates
  (`lead-identity-seam/v1` until R6-A publishes a real version);
- defines the interim evidence scope (lead ↔ opportunity candidates via
  tenant + business + campaign attribution) — replaced by authoritative
  R6-A lead→handoff linkage on convergence;
- tests drive the seam through a fixture lead, so R6-A convergence touches only
  this file + fixtures.

## 10. R6-C handoff requirements

- One read-only projection: `leadScoreId`, `leadId`, `scoringVersion`,
  `overallScore` (0-100), `scoreBand`, `scoreConfidence`, component scores,
  bounded `reasonCodes`, `evidenceSnapshotId`/`evidenceSnapshotHash`,
  evidence freshness (`computedAt` + manifest `occurredAt`), timestamps.
- R6-C **must not** overwrite scores, alter weights, treat score =
  qualification, or mutate evidence snapshots (see handoff contract).
- No qualification / nurture / outreach / CRM / conversion actions in R6-B;
  verified by zero-write assertions on `leads`, `lead_activities`,
  `lead_scores`, `outreach_recommendations` in the acceptance suite
  (mirrors `r5-d-acceptance.test.ts:369`).

## 11. Security/fairness baseline carried into design

Strict server-side authz (`authedQuery`), tenant scoping from `ctx.user.id`
only, server-minted identities, DB-authoritative exact-once (unique keys, no
in-memory dedupe), immutable append-only records, bounded honest confidence
(separate from score value), bounded reason codes, no PII beyond opaque
references, deterministic non-billable path, no model in v1.
