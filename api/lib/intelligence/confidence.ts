// ─── R5-B Intent & Sentiment Intelligence — confidence semantics (§8) ───
//
// PURE confidence module: bounded ordinal arithmetic with an explicit source.
// Confidence is never a fabricated probability. Combination is the ordinal min;
// handling gates force low/unknown confidence into honest, non-auto-actionable
// classes while letting safety escalation always survive.
// No I/O, no clock, no logging.

import type { ConfidenceLabel, HandlingClass } from "./interpretation-contract";

/** Closed ordinal: unknown < low < medium < high. */
export const CONFIDENCE_ORDER: Readonly<Record<ConfidenceLabel, number>> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
};

/** Ordinal minimum over one or more confidence labels. */
export function minConfidence(
  first: ConfidenceLabel,
  ...rest: readonly ConfidenceLabel[]
): ConfidenceLabel {
  let min = first;
  for (const label of rest) {
    if (CONFIDENCE_ORDER[label] < CONFIDENCE_ORDER[min]) min = label;
  }
  return min;
}

/**
 * Overall confidence = min(intent, sentiment, relevance) under the closed
 * ordinal (contract §8).
 */
export function combineOverallConfidence(args: {
  readonly intentConfidence: ConfidenceLabel;
  readonly sentimentConfidence: ConfidenceLabel;
  readonly relevanceConfidence: ConfidenceLabel;
}): ConfidenceLabel {
  return minConfidence(
    args.intentConfidence,
    args.sentimentConfidence,
    args.relevanceConfidence
  );
}

/**
 * Model self-assessed confidence is consumed as an ordinal self-report and is
 * never upgraded (contract §8). high→high, medium→medium, low→low.
 */
export function mapModelConfidence(
  modelConfidence: "high" | "medium" | "low"
): ConfidenceLabel {
  return modelConfidence;
}

/**
 * Confidence gate on the recommended-handling class (contract §8).
 *
 * Truth table (first match wins):
 *
 * | overall  | desired                    | result          |
 * |----------|----------------------------|-----------------|
 * | high     | any                        | desired         |
 * | medium   | any                        | desired         |
 * | low      | safety_escalation          | safety_escalation |
 * | low      | anything else              | human_review    |
 * | unknown  | safety_escalation          | safety_escalation |
 * | unknown  | anything else              | monitor         |
 *
 * Low/unknown confidence must never surface as candidate_for_engagement or
 * opportunity_candidate; ambiguity is represented honestly. Safety escalation
 * always survives the gate.
 */
export function gateHandling(
  overall: ConfidenceLabel,
  desired: HandlingClass
): HandlingClass {
  switch (overall) {
    case "high":
    case "medium":
      return desired;
    case "low":
      return desired === "safety_escalation" ? "safety_escalation" : "human_review";
    case "unknown":
      return desired === "safety_escalation" ? "safety_escalation" : "monitor";
  }
}
