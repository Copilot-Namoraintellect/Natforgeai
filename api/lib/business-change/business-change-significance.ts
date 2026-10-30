// ─── R8-B Business Change Intelligence — significance classification ───
//
// PURE module: deterministic, evidence-bounded significance derivation
// (contract §7). Dimensions are bounded integers derived from the detected
// change material only — never from model/client opinion. The source
// confidence class then CAPS the derived class: weak evidence can never rank
// HIGH/CRITICAL, and only hash-verified AUTHORITATIVE sources can mint
// CRITICAL. Authority only ever narrows.

import type {
  BusinessChangeConfidenceClass,
  BusinessChangeSignificanceClass,
  BusinessChangeSubjectType,
  BusinessChangeType,
} from "./business-change-contract";

export interface SignificanceDimensions {
  /** 0–2 — relative size of the delta (ratio bands, set-change fraction, ordinal distance). */
  magnitude: number;
  /** 0–2 — business-wide subjects score higher than subject-local ones. */
  scope: number;
  /** 0–2 — integer minor-unit financial delta bands (0 for non-monetary domains). */
  financialImplication: number;
  /** 0–2 — objective/constraint/risk intrinsic strategic weight. */
  strategicObjectiveImpact: number;
}

const LOW: BusinessChangeSignificanceClass = "LOW";
const MODERATE: BusinessChangeSignificanceClass = "MODERATE";
const HIGH: BusinessChangeSignificanceClass = "HIGH";
const CRITICAL: BusinessChangeSignificanceClass = "CRITICAL";

/** Deterministic dimension model (contract §7.1). */
export function deriveSignificanceDimensions(input: {
  subjectType: BusinessChangeSubjectType;
  changeType: BusinessChangeType;
  /** Absolute budget delta in integer minor units (BUDGET domain only). */
  budgetDeltaMinor?: number | null;
  /** Number of set items added/removed (provider/product/audience domains). */
  setChangeCount?: number | null;
  /** Previous approved total in minor units for ratio bands (BUDGET domain). */
  previousApprovedTotalMinor?: number | null;
  /** Ordinal distance for ranked types (risk posture). */
  ordinalDistance?: number | null;
}): SignificanceDimensions {
  const setCount = Math.max(0, Math.min(2, input.setChangeCount ?? 0));
  const ordinalDistance = Math.max(0, Math.min(2, input.ordinalDistance ?? 0));
  let magnitude = 1;
  switch (true) {
    case input.changeType.startsWith("BUDGET_ENVELOPE"): {
      const prev = input.previousApprovedTotalMinor ?? 0;
      const delta = Math.abs(input.budgetDeltaMinor ?? 0);
      const ratio = prev > 0 ? delta / prev : delta > 0 ? 1 : 0;
      magnitude = ratio >= 0.1 ? 2 : 1;
      break;
    }
    case input.changeType.startsWith("PROVIDER_SUPPORT"):
    case input.changeType.startsWith("PRODUCT_"):
    case input.changeType.startsWith("AUDIENCE_SEGMENT"):
      magnitude = setCount >= 2 ? 2 : 1;
      break;
    case input.changeType === "OBJECTIVE_REMOVED":
    case input.changeType === "LEARNING_PATTERN_CONTRADICTED":
      magnitude = 2;
      break;
    case input.changeType === "RISK_POSTURE_ELEVATED":
    case input.changeType === "RISK_POSTURE_REDUCED":
      magnitude = ordinalDistance >= 2 ? 2 : 1;
      break;
    default:
      magnitude = 1;
  }

  const businessWide =
    input.subjectType === "BUDGET_ENVELOPE" ||
    input.subjectType === "PROVIDER_CAPABILITY" ||
    input.subjectType === "RISK_POSTURE" ||
    input.subjectType === "PRODUCT_SET" ||
    input.subjectType === "AUDIENCE_SET";
  const scope = businessWide ? 2 : 1;

  let financialImplication = 0;
  if (input.changeType.startsWith("BUDGET_ENVELOPE")) {
    const delta = Math.abs(input.budgetDeltaMinor ?? 0);
    financialImplication = delta >= 500_000 ? 2 : delta >= 50_000 ? 1 : 0;
  }

  let strategicObjectiveImpact = 0;
  if (input.subjectType === "OBJECTIVE") strategicObjectiveImpact = 2;
  else if (input.subjectType === "CONSTRAINT" || input.subjectType === "RISK_POSTURE") strategicObjectiveImpact = 1;

  return { magnitude, scope, financialImplication, strategicObjectiveImpact };
}

/** Confidence ceilings (contract §7.3 — binding). */
const CONFIDENCE_CAP: Record<BusinessChangeConfidenceClass, BusinessChangeSignificanceClass> = {
  UNVERIFIED: LOW,
  OBSERVED: MODERATE,
  PROVISIONAL: MODERATE,
  VERIFIED: HIGH,
  AUTHORITATIVE: CRITICAL,
};

const CLASS_RANK: Record<BusinessChangeSignificanceClass, number> = { LOW: 0, MODERATE: 1, HIGH: 2, CRITICAL: 3 };
const RANK_CLASS: BusinessChangeSignificanceClass[] = [LOW, MODERATE, HIGH, CRITICAL];

/**
 * score = Σ dimensions ⇒ 0–1 LOW, 2–3 MODERATE, 4–5 HIGH, ≥6 CRITICAL, then
 * the confidence cap is applied. Only hash-verified AUTHORITATIVE sources can
 * reach CRITICAL; PROVISIONAL/OBSERVED evidence stays ≤ MODERATE by
 * construction. A model may not increase significance — no model input
 * participates in this derivation at all.
 */
export function classifySignificance(
  dimensions: SignificanceDimensions,
  confidenceClass: BusinessChangeConfidenceClass
): BusinessChangeSignificanceClass {
  const score =
    dimensions.magnitude + dimensions.scope + dimensions.financialImplication + dimensions.strategicObjectiveImpact;
  const derived: BusinessChangeSignificanceClass =
    score <= 1 ? LOW : score <= 3 ? MODERATE : score <= 5 ? HIGH : CRITICAL;
  const cap = CONFIDENCE_CAP[confidenceClass];
  return RANK_CLASS[Math.min(CLASS_RANK[derived], CLASS_RANK[cap])];
}

/** Advisory governance hint for the downstream projection (B8 contract §5). */
export type GovernanceEligibilityHint =
  | "CONTEXT_ONLY"
  | "REVIEW_ORIENTED"
  | "ELIGIBLE_FOR_GOVERNED_REASONING";

export function deriveGovernanceEligibilityHint(input: {
  significanceClass: BusinessChangeSignificanceClass;
  confidenceClass: BusinessChangeConfidenceClass;
}): GovernanceEligibilityHint {
  if (input.significanceClass === "LOW") return "CONTEXT_ONLY";
  if (input.significanceClass === "MODERATE") return "REVIEW_ORIENTED";
  // HIGH/CRITICAL both require VERIFIED-or-better confidence under the caps.
  return "ELIGIBLE_FOR_GOVERNED_REASONING";
}

/** Deterministic confidence mapping from governed source material (§6.3). */
export function deriveConfidenceFromLearningConfidence(confidenceClass: string): BusinessChangeConfidenceClass {
  switch (confidenceClass) {
    case "STRONG":
      return "VERIFIED";
    case "MODERATE":
      return "PROVISIONAL";
    case "WEAK":
      return "OBSERVED";
    default:
      return "UNVERIFIED";
  }
}
