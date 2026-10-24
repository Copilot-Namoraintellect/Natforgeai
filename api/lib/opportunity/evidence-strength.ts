// ─── R5-D Opportunity Detection — confidence / evidence strength (contract §6, D5) ───
//
// PURE deterministic derivation of bounded honest classes. Never a calibrated
// probability; no arithmetic on ordinals beyond the documented comparisons;
// no client or model can set these values. Evidence enters only through the
// immutable evidence rows produced by the governed detector.

import type {
  ConfidenceClass,
  EvidenceStrength,
  OpportunityUrgency,
} from "./opportunity-contract";

/** Strength-relevant evidence view (immutable rows only). */
export interface StrengthEvidenceInput {
  readonly kind: "signal_interpretation" | "engagement_receipt";
  readonly opportunityTypeAtEvaluation: string;
  readonly intent: string;
  readonly overallConfidence: string;
  readonly relevance: string;
  readonly sentiment: string;
  readonly urgency: OpportunityUrgency;
  readonly contributesToStrength: boolean;
}

const EXPLICIT_TYPES = new Set([
  "purchase_interest",
  "service_enquiry",
  "partnership_interest",
  "support_to_sales_transition",
  "unresolved_complaint_opportunity",
  "referral_or_advocacy",
]);

const CONTRADICTING_INTENTS = new Set([
  "objection",
  "complaint",
  "cancellation_or_churn_signal",
]);

/**
 * True when an evidence entry contradicts a non-retention candidate type:
 * negative sentiment, or an intent that actively undermines commercial
 * opportunity. Deterministic, counted at append time (contract §6).
 */
export function isContradiction(entry: StrengthEvidenceInput, opportunityType: string): boolean {
  if (opportunityType === "retention_risk") {
    // For retention risk the "contradiction" axis is praise/positive churn
    // reversal: positive sentiment with praise intent undermines the risk.
    return entry.sentiment === "positive" && entry.intent === "praise";
  }
  return (
    entry.sentiment === "negative" ||
    CONTRADICTING_INTENTS.has(entry.intent)
  );
}

export interface StrengthComputation {
  readonly evidenceStrength: EvidenceStrength;
  readonly explicitHigh: boolean;
  readonly explicitMedium: boolean;
  readonly engagementBoost: boolean;
  readonly repeatSignal: boolean;
  readonly contradictionCount: number;
  readonly distinctInterpretations: number;
}

/**
 * Deterministic evidence-strength rules (contract §6, exact table). Only
 * strength-contributing rows count toward the signal axes; every row counts
 * toward contradictions (honesty: contradictions can only reduce).
 */
export function computeEvidenceStrength(
  entries: readonly StrengthEvidenceInput[],
  opportunityType: string
): StrengthComputation {
  const distinct = new Set<string>();
  let contradictionCount = 0;
  for (const entry of entries) {
    if (isContradiction(entry, opportunityType)) contradictionCount += 1;
  }

  const contributing = entries.filter((e) => e.contributesToStrength && e.kind === "signal_interpretation");
  for (const entry of contributing) {
    distinct.add(`${entry.opportunityTypeAtEvaluation}:${entry.overallConfidence}`);
  }
  // Distinct interpretations: one per contributing row identity is enforced
  // by the store (unique interpretationId); count rows as distinct signals.
  const distinctInterpretations = contributing.length;

  const explicitHigh = contributing.some(
    (e) =>
      EXPLICIT_TYPES.has(e.opportunityTypeAtEvaluation) &&
      e.overallConfidence === "high" &&
      e.relevance === "relevant"
  );
  const explicitMedium = contributing.some(
    (e) =>
      EXPLICIT_TYPES.has(e.opportunityTypeAtEvaluation) &&
      e.overallConfidence === "medium" &&
      (e.relevance === "relevant" || e.relevance === "partially_relevant")
  );
  const engagementBoost = entries.some((e) => e.kind === "engagement_receipt");
  const repeatSignal = distinctInterpretations >= 2;

  let evidenceStrength: EvidenceStrength;
  if (
    contradictionCount === 0 &&
    repeatSignal &&
    (explicitHigh || (explicitMedium && engagementBoost))
  ) {
    evidenceStrength = "HIGH";
  } else if (
    contradictionCount === 0 &&
    (explicitHigh || explicitMedium || (repeatSignal && engagementBoost))
  ) {
    evidenceStrength = "MEDIUM";
  } else if (contributing.length === 0 && !engagementBoost) {
    evidenceStrength = "UNKNOWN";
  } else {
    evidenceStrength = "LOW";
  }

  return {
    evidenceStrength,
    explicitHigh,
    explicitMedium,
    engagementBoost,
    repeatSignal,
    contradictionCount,
    distinctInterpretations,
  };
}

const STRENGTH_RANK: Record<EvidenceStrength, number> = {
  UNKNOWN: 0,
  LOW: 1,
  MEDIUM: 2,
  HIGH: 3,
};

export function minStrength(a: EvidenceStrength, b: EvidenceStrength): EvidenceStrength {
  return STRENGTH_RANK[a] <= STRENGTH_RANK[b] ? a : b;
}

/**
 * Recency cap (contract §6): age of lastObservedAt relative to the evidence
 * window. age < ½ window → no cap; ½–1 window → MEDIUM cap; beyond window the
 * candidate is expired by lifecycle (this function is not consulted).
 */
export function recencyCap(lastObservedAtMs: number, nowMs: number, windowMs: number): EvidenceStrength {
  const age = nowMs - lastObservedAtMs;
  if (age < windowMs / 2) return "HIGH";
  if (age <= windowMs) return "MEDIUM";
  return "LOW";
}

export function computeConfidenceClass(
  evidenceStrength: EvidenceStrength,
  cap: EvidenceStrength
): ConfidenceClass {
  const bounded = minStrength(evidenceStrength, cap);
  return bounded === "UNKNOWN" ? "UNKNOWN" : bounded;
}

const URGENCY_RANK: Record<OpportunityUrgency, number> = {
  low: 0,
  normal: 1,
  high: 2,
  critical: 3,
};

/** Urgency of the candidate = max urgency over evidence (deterministic). */
export function maxUrgency(entries: readonly { urgency: OpportunityUrgency }[]): OpportunityUrgency {
  let max: OpportunityUrgency = "low";
  for (const entry of entries) {
    if (URGENCY_RANK[entry.urgency] > URGENCY_RANK[max]) max = entry.urgency;
  }
  return max;
}
