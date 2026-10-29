// ─── R7-B Attribution Intelligence — confidence / evidence classification ───
//
// PURE module (no I/O). The evidence class is a deterministic function of
// journey quality signals — never of model choice, never of model output.
// Confidence is a closed deterministic mapping from the evidence class.
// Classification is never translated into causal proof; surfaces carry the
// verbatim disclaimer from the contract.

import {
  ATTRIBUTION_PROVISIONAL_OUTCOME_STATUS_SET,
  type AttributionConfidenceClass,
  type AttributionEvidenceClass,
  type AttributionExcludedTouchpoint,
  type AttributionTouchpoint,
} from "./attribution-contract";

export interface JourneyQualityInput {
  readonly outcomeStatus: string;
  /** Eligible touchpoints (credit-bearing set). */
  readonly eligible: readonly AttributionTouchpoint[];
  /** Excluded candidates with closed reasons. */
  readonly excluded: readonly AttributionExcludedTouchpoint[];
  /** Whether the numeric→lid1 lead chain was validated for this outcome. */
  readonly leadChainValidated: boolean;
  /** Whether provisional/OBSERVED outcomes are attributable under policy. */
  readonly provisionalAllowed: boolean;
}

/**
 * Evidence classes, strongest to weakest:
 *   DIRECT_LINKAGE       — verified outcome, validated lead chain, in-window
 *                          chronology, no material exclusions.
 *   STRONG_ASSOCIATION   — sound lineage with minor gaps (or a provisional/
 *                          observed outcome under policy).
 *   WEAK_ASSOCIATION     — partial journey or material exclusions/ambiguity.
 *   INSUFFICIENT_EVIDENCE— no eligible touchpoints (or unattributable state).
 */
export function classifyEvidence(input: JourneyQualityInput): AttributionEvidenceClass {
  if (input.eligible.length === 0) return "INSUFFICIENT_EVIDENCE";

  const isProvisional = ATTRIBUTION_PROVISIONAL_OUTCOME_STATUS_SET.has(input.outcomeStatus);
  if (isProvisional && !input.provisionalAllowed) return "INSUFFICIENT_EVIDENCE";

  const exclusionCount = input.excluded.length;
  const hasInvalidTimestamps = input.excluded.some(
    (e) => e.reason === "TOUCHPOINT_TIMESTAMP_INVALID"
  );
  const hasUnresolvedLineage = input.excluded.some(
    (e) => e.reason === "TOUCHPOINT_UNRESOLVED_LINEAGE"
  );

  // DIRECT: verified outcome + validated chain + clean chronology.
  if (
    !isProvisional &&
    input.leadChainValidated &&
    exclusionCount === 0 &&
    !hasInvalidTimestamps &&
    !hasUnresolvedLineage
  ) {
    return "DIRECT_LINKAGE";
  }

  // WEAK: material ambiguity — unresolved lineage, invalid timestamps, or a
  // large share of exclusions relative to the eligible set.
  const exclusionHeavy =
    exclusionCount >= 3 || (exclusionCount > 0 && exclusionCount >= input.eligible.length);
  if (hasUnresolvedLineage || hasInvalidTimestamps || exclusionHeavy || !input.leadChainValidated) {
    return "WEAK_ASSOCIATION";
  }

  // STRONG: everything else attributable — minor gaps only. Provisional
  // outcomes under policy cap out here (never DIRECT_LINKAGE).
  return "STRONG_ASSOCIATION";
}

const CONFIDENCE_MAP: Record<AttributionEvidenceClass, AttributionConfidenceClass> = {
  DIRECT_LINKAGE: "HIGH",
  STRONG_ASSOCIATION: "MEDIUM",
  WEAK_ASSOCIATION: "LOW",
  INSUFFICIENT_EVIDENCE: "NONE",
};

export function confidenceForEvidence(evidenceClass: AttributionEvidenceClass): AttributionConfidenceClass {
  return CONFIDENCE_MAP[evidenceClass];
}
