// ─── R6-B Lead Scoring — deterministic scoring engine (B3) ───
//
// PURE module: computes the bounded lead score from a validated feature
// vector. Rule-first, versioned, fully deterministic — same feature snapshot
// + same SCORING_VERSION + same explicit clock → same score, always. No model,
// no randomness, no hidden clock, no client influence. The exact model is
// documented in docs/contracts/lead-scoring-contract.md §4 and implemented
// verbatim here.

import {
  SCORE_BAND_VALUES,
  SCORE_REASON_CODE_VALUES,
  SCORING_WEIGHTS,
  ScoringValidationError,
  type ComponentKey,
  type ScoreBand,
  type ScoreReasonCode,
} from "./scoring-contract";
import type { ScoringFeatureVector } from "./feature-model";
import { deriveScoreConfidence, type ScoreConfidence } from "./score-confidence";

export interface ScoreComputation {
  overallScore: number;
  scoreBand: ScoreBand;
  components: Record<ComponentKey, number>;
  /** Weighted points per component — contributions are inspectable. */
  contributions: Record<ComponentKey, number>;
  reasonCodes: ScoreReasonCode[];
  confidence: ScoreConfidence;
}

const REASON_CODE_SET = new Set<string>(SCORE_REASON_CODE_VALUES);
const MAX_REASON_CODES = 8;

/** Weight bounds validation — tampered/overridden weights fail closed. */
export function assertValidWeights(weights: Readonly<Record<ComponentKey, number>>): void {
  let sum = 0;
  for (const key of Object.keys(SCORING_WEIGHTS) as ComponentKey[]) {
    const value = weights[key];
    if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
      throw new ScoringValidationError(
        "INVALID_SCORING_WEIGHTS",
        `scoring weight for ${key} must be a finite number in [0,1]; got ${String(value)}.`
      );
    }
    sum += value;
  }
  if (sum > 1.000001) {
    throw new ScoringValidationError(
      "INVALID_SCORING_WEIGHTS",
      `scoring weights must sum to <= 1; got ${sum}.`
    );
  }
}

function clampScore(value: number): number {
  if (!Number.isFinite(value)) {
    // Defensive: validated features make this unreachable; never propagate NaN.
    throw new ScoringValidationError("INVALID_SCORE", "score computation produced a non-finite value.");
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

export function scoreBandFor(overallScore: number): ScoreBand {
  if (overallScore < 20) return "VERY_LOW";
  if (overallScore < 40) return "LOW";
  if (overallScore < 60) return "MEDIUM";
  if (overallScore < 80) return "HIGH";
  return "VERY_HIGH";
}

// ─── Component formulas (contract §4a–§4e — verbatim) ───

function computeIntent(v: ScoringFeatureVector): number {
  return clampScore(v.intentTypeBase + 20 * Math.min(v.explicitHighCount, 2) + 10 * Math.min(v.explicitMediumCount, 1));
}

function computeFit(v: ScoringFeatureVector): number {
  return clampScore(70 * v.fitTypeRelevance + 30 * v.fitCampaignAlignment);
}

function computeEngagement(v: ScoringFeatureVector): number {
  const receiptPoints = 35 * Math.min(v.validatedReceiptCount, 2);
  const continuation = v.distinctInterpretationCount >= 3 ? 30 : v.distinctInterpretationCount === 2 ? 20 : 0;
  return clampScore(receiptPoints + continuation);
}

function computeRecency(v: ScoringFeatureVector, nowMs: number): number {
  if (v.latestObservedAtMs === null) return 0;
  const ageHours = Math.max(0, (nowMs - v.latestObservedAtMs) / 3.6e6);
  if (ageHours <= 24) return 100;
  if (ageHours <= 72) return 80;
  if (ageHours <= 168) return 60;
  if (ageHours <= 336) return 30;
  return 10;
}

function computeOpportunity(v: ScoringFeatureVector): number {
  const base = { HIGH: 70, MEDIUM: 50, LOW: 20, UNKNOWN: 0 }[v.evidenceStrengthOrdinal];
  const coverage = Math.min(20, 5 * Math.max(0, v.contributingEvidenceCount - 1));
  return clampScore(base + coverage - 15 * v.contradictionCount);
}

// ─── Reason codes (contract §7 — bounded, deterministic priority) ───

function deriveReasonCodes(v: ScoringFeatureVector, components: Record<ComponentKey, number>, ageHours: number | null): ScoreReasonCode[] {
  const codes: ScoreReasonCode[] = [];
  const push = (code: ScoreReasonCode) => {
    if (codes.length < MAX_REASON_CODES && REASON_CODE_SET.has(code) && !codes.includes(code)) {
      codes.push(code);
    }
  };

  if (!v.hasAnyEvidence) {
    push("INSUFFICIENT_EVIDENCE");
    return codes;
  }

  // Dominant positive drivers (weighted contribution order).
  const ordered = (Object.keys(components) as ComponentKey[]).sort((a, b) => components[b] - components[a]);
  const top = ordered[0];
  if (top === "intent" && v.explicitHighCount > 0) {
    if (v.primaryOpportunityType === "service_enquiry") push("EXPLICIT_SERVICE_ENQUIRY");
    else if (v.primaryOpportunityType === "partnership_interest") push("PARTNERSHIP_INTEREST");
    else push("STRONG_PURCHASE_INTENT");
  } else if (top === "fit" && v.fitCampaignAlignment >= 1) {
    push("CAMPAIGN_ALIGNED");
  } else if (top === "opportunity" && v.evidenceStrengthOrdinal === "HIGH") {
    push("HIGH_EVIDENCE_STRENGTH");
  }

  if (v.distinctInterpretationCount >= 2) push("REPEATED_INTENT_SIGNALS");
  if (v.validatedReceiptCount > 0) push("VALIDATED_ENGAGEMENT_RESPONSE");
  if (ageHours !== null && ageHours <= 72) push("RECENT_EVIDENCE");

  // Caveats (mandatory when applicable).
  if (v.evidenceStrengthOrdinal === "LOW") push("LOW_EVIDENCE_STRENGTH");
  if (v.contradictionCount > 0) push("CONTRADICTING_EVIDENCE");
  if (v.distinctInterpretationCount === 1) push("SINGLE_EVIDENCE_SOURCE");
  if (v.validatedReceiptCount === 0) push("MISSING_ENGAGEMENT_EVIDENCE");
  if (ageHours === null) push("MISSING_RECENCY_EVIDENCE");
  else if (ageHours > 168) push("STALE_EVIDENCE");
  if (v.fitCampaignAlignment <= 0.5) push("NEUTRAL_CAMPAIGN_ALIGNMENT");

  // Signal-shape codes: praise-only / complaint-only never score as sales-ready.
  if (v.primaryOpportunityType === "referral_or_advocacy") push("PRAISE_ONLY_EVIDENCE");
  if (v.primaryOpportunityType === "unresolved_complaint_opportunity") push("UNRESOLVED_COMPLAINT_SIGNAL");
  if (v.primaryOpportunityType === "retention_risk" || v.primaryOpportunityType === "churn_risk") {
    push("COMPLAINT_ONLY_EVIDENCE");
  }
  return codes;
}

/**
 * Compute the authoritative bounded score. `now` is the explicit scoring
 * clock read at the persistence boundary — the engine never reads a clock.
 * `weights` must be the server-owned SCORING_WEIGHTS; any tampered set fails
 * the bounds assertion before computation.
 */
export function computeScore(
  vector: ScoringFeatureVector,
  input: { now: Date; weights?: Readonly<Record<ComponentKey, number>> }
): ScoreComputation {
  const weights = input.weights ?? SCORING_WEIGHTS;
  assertValidWeights(weights);

  const nowMs = input.now.getTime();
  if (!Number.isFinite(nowMs)) {
    throw new ScoringValidationError("INVALID_SCORING_CLOCK", "scoring clock must be a finite timestamp.");
  }

  const components: Record<ComponentKey, number> = {
    intent: computeIntent(vector),
    fit: computeFit(vector),
    engagement: computeEngagement(vector),
    recency: computeRecency(vector, nowMs),
    opportunity: computeOpportunity(vector),
  };

  let weighted = 0;
  const contributions = {} as Record<ComponentKey, number>;
  for (const key of Object.keys(weights) as ComponentKey[]) {
    const points = components[key] * weights[key];
    contributions[key] = Math.round(points * 100) / 100;
    weighted += points;
  }
  const overallScore = clampScore(weighted);

  const ageHours =
    vector.latestObservedAtMs === null ? null : Math.max(0, (nowMs - vector.latestObservedAtMs) / 3.6e6);
  const reasonCodes = deriveReasonCodes(vector, components, ageHours);
  const confidence = deriveScoreConfidence(vector, { nowMs });

  return {
    overallScore,
    scoreBand: scoreBandFor(overallScore),
    components,
    contributions,
    reasonCodes,
    confidence,
  };
}
