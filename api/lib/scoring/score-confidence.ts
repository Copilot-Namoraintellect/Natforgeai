// ─── R6-B Lead Scoring — score confidence / uncertainty (B6) ───
//
// PURE module: derives the honest confidence ordinal for a score, separate
// from the score value. Confidence reflects evidence completeness, identity
// resolution, freshness, source strength and contradictions — never model
// self-confidence and never a calibrated probability. Bounded classes only:
// LOW < MEDIUM < HIGH, plus UNKNOWN (no usable basis).

import type { ScoringFeatureVector } from "./feature-model";
import { ScoringValidationError } from "./scoring-contract";

export const SCORE_CONFIDENCE_VALUES = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;
export type ScoreConfidence = (typeof SCORE_CONFIDENCE_VALUES)[number];

const RANK: Record<ScoreConfidence, number> = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 };

export const DEFAULT_STALE_AFTER_HOURS = 168; // R5 evidence window
export const DEFAULT_VERY_STALE_AFTER_HOURS = 336;

function minConfidence(a: ScoreConfidence, b: ScoreConfidence): ScoreConfidence {
  return RANK[a] <= RANK[b] ? a : b;
}

export interface ScoreConfidenceInput {
  nowMs: number;
  staleAfterHours?: number;
  veryStaleAfterHours?: number;
}

/**
 * Derive the confidence cap (contract §6). `nowMs` is the explicit scoring
 * clock. A high numeric score with LOW confidence stays explicitly
 * low-confidence — the class is reported alongside the score everywhere.
 */
export function deriveScoreConfidence(
  vector: ScoringFeatureVector,
  input: ScoreConfidenceInput
): ScoreConfidence {
  const nowMs = input.nowMs;
  if (!Number.isFinite(nowMs)) {
    throw new ScoringValidationError("INVALID_SCORING_CLOCK", "scoring clock must be a finite timestamp.");
  }
  const staleAfter = input.staleAfterHours ?? DEFAULT_STALE_AFTER_HOURS;
  const veryStaleAfter = input.veryStaleAfterHours ?? DEFAULT_VERY_STALE_AFTER_HOURS;

  if (!vector.hasAnyEvidence || vector.evidenceStrengthOrdinal === "UNKNOWN") {
    return "UNKNOWN";
  }

  let confidence: ScoreConfidence = "HIGH";

  if (vector.evidenceStrengthOrdinal === "LOW") confidence = minConfidence(confidence, "LOW");
  if (vector.contradictionCount > 0) confidence = minConfidence(confidence, "LOW");

  if (vector.latestObservedAtMs === null) {
    confidence = minConfidence(confidence, "LOW");
  } else {
    const ageHours = Math.max(0, (nowMs - vector.latestObservedAtMs) / 3.6e6);
    if (ageHours > veryStaleAfter) confidence = minConfidence(confidence, "LOW");
    else if (ageHours > staleAfter) confidence = minConfidence(confidence, "MEDIUM");
  }

  if (vector.distinctInterpretationCount <= 1) confidence = minConfidence(confidence, "MEDIUM");
  if (vector.validatedReceiptCount === 0) confidence = minConfidence(confidence, "MEDIUM");

  return confidence;
}
