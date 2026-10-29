// ─── R7-C Business Learning Engine — confidence & evidence classification ───
//
// PURE module (no I/O, no clock). Closed confidence/evidence semantics
// derived from source evidence only — supporting outcome count, outcome
// verification state, attribution confidence floor, contradictions — never
// from model opinion, and never by averaging attribution confidence without
// a defined deterministic rule. A single outcome-attribution pair can never
// yield STRONG learning; multiple consistent pairs can strengthen it.

import type {
  LearningConfidenceClass,
  LearningEvidenceClass,
} from "./business-learning-contract";
import type { OutcomeAttributionPair } from "./business-learning-derivation";
import { attributionConfidenceFloor } from "./business-learning-derivation";

const CONFIDENCE_RANK: Record<LearningConfidenceClass, number> = {
  INSUFFICIENT_EVIDENCE: 0,
  WEAK: 1,
  MODERATE: 2,
  STRONG: 3,
};

const RANK_CONFIDENCE = [
  "INSUFFICIENT_EVIDENCE",
  "WEAK",
  "MODERATE",
  "STRONG",
] as const;

function dropOneClass(cls: LearningConfidenceClass): LearningConfidenceClass {
  return RANK_CONFIDENCE[Math.max(0, CONFIDENCE_RANK[cls] - 1)];
}

export interface LearningClassificationInput {
  /** Distinct positive-support pairs (creditable, non-terminal, non-reversal). */
  readonly supportCount: number;
  /** Distinct opposite-direction pairs. */
  readonly contradictionCount: number;
  /** Support-contributing pairs (the attribution floor is the minimum
   *  confidence rank across THESE attributions — contradicting evidence
   *  changes confidence through the contradiction rule, never by dragging
   *  the floor to zero). */
  readonly pairs: readonly OutcomeAttributionPair[];
}

export interface LearningClassification {
  readonly confidenceClass: LearningConfidenceClass;
  readonly evidenceClass: LearningEvidenceClass;
}

function verificationStates(pairs: readonly OutcomeAttributionPair[]): {
  verificationAll: boolean;
  verificationAnyProvisional: boolean;
  verificationAnyVerified: boolean;
} {
  let anyProvisional = false;
  let anyVerified = false;
  for (const pair of pairs) {
    const status = pair.outcome.outcomeStatus;
    if (status === "VERIFIED") anyVerified = true;
    if (status === "PROVISIONAL" || status === "OBSERVED") anyProvisional = true;
  }
  return {
    verificationAll: pairs.length > 0 && !anyProvisional,
    verificationAnyProvisional: anyProvisional,
    verificationAnyVerified: anyVerified,
  };
}

/**
 * Deterministic closed classification (contract §7, rules applied in order):
 *
 *  1. supportCount == 0 or attributionFloor == 0 → INSUFFICIENT_EVIDENCE /
 *     INSUFFICIENT.
 *  2. contradictionCount > 0 drops confidence one full class (floor
 *     INSUFFICIENT_EVIDENCE); the contradiction remains visible on the
 *     record.
 *  3. Otherwise the closed table: 1 support → WEAK; ≥2 support with floor 2
 *     → MODERATE when all outcomes verified else WEAK; floor 3 → STRONG when
 *     all verified (and ≥2 support) else MODERATE.
 *  4. Any provisional/observed outcome caps confidence at MODERATE and
 *     labels the evidence class PROVISIONAL (mixed verification → MIXED).
 */
export function classifyLearningEvidence(
  input: LearningClassificationInput
): LearningClassification {
  const floor = attributionConfidenceFloor(input.pairs);
  if (input.supportCount === 0 || floor === 0) {
    return { confidenceClass: "INSUFFICIENT_EVIDENCE", evidenceClass: "INSUFFICIENT" };
  }

  const { verificationAll, verificationAnyProvisional, verificationAnyVerified } =
    verificationStates(input.pairs);

  let confidence: LearningConfidenceClass;
  if (input.supportCount === 1) {
    confidence = "WEAK";
  } else if (floor >= 3) {
    confidence = verificationAll ? "STRONG" : "MODERATE";
  } else if (floor >= 2) {
    confidence = verificationAll ? "MODERATE" : "WEAK";
  } else {
    confidence = "WEAK";
  }

  if (input.contradictionCount > 0) {
    confidence = dropOneClass(confidence);
  }

  if (verificationAnyProvisional && CONFIDENCE_RANK[confidence] > CONFIDENCE_RANK.MODERATE) {
    confidence = "MODERATE";
  }

  let evidenceClass: LearningEvidenceClass;
  if (verificationAnyProvisional) {
    evidenceClass = verificationAnyVerified ? "MIXED" : "PROVISIONAL";
  } else {
    evidenceClass = "VERIFIED";
  }

  return { confidenceClass: confidence, evidenceClass };
}

/**
 * Server-derived initial status (contract §7): SUPPORTED iff confidence is
 * MODERATE/STRONG and no contradiction is present; otherwise CANDIDATE. No
 * client can mark a record SUPPORTED or raise confidence.
 */
export function deriveInitialStatus(input: {
  confidenceClass: LearningConfidenceClass;
  contradictionCount: number;
}): "CANDIDATE" | "SUPPORTED" {
  if (input.contradictionCount > 0) return "CANDIDATE";
  return input.confidenceClass === "MODERATE" || input.confidenceClass === "STRONG"
    ? "SUPPORTED"
    : "CANDIDATE";
}
