/**
 * Interpretation → Authoritative Intelligence bridge (WBS-R5-C1/C3).
 *
 * R5-C never re-derives policy risk; it translates the frozen R5-B
 * interpretation record into the exact `AuthoritativeIntelligence` shape the
 * R5-E engine consumes (`validateAuthoritativeIntelligence`). The mapping is
 * deterministic and closed:
 *
 * - intent (15-value R5-B vocabulary) → intentClass (18-value R5-E
 *   vocabulary);
 * - coarse sentiment → the policy sentiment axis (mixed/unknown conservatively
 *   map to neutral — never to positive);
 * - ordinal confidence → bounded numeric confidence (advisory input to the
 *   policy engine, not a calibrated probability);
 * - personal-data / injection suspicion are derived from the interpretation's
 *   risk flags plus a deterministic injection-marker scan over the bounded
 *   evidence excerpts the interpretation carries (R5-B records never contain
 *   full social text).
 *
 * Social content is untrusted input everywhere in this stream: injection
 * suspicion can only RAISE risk inside the policy engine (R5-E invariant) —
 * it can never widen authority.
 */

import {
  validateAuthoritativeIntelligence,
  type AuthoritativeIntelligence,
  type IntentClass,
} from "../policy/risk-classification";

/** R5-B closed intent vocabulary (mirrored — B owns the taxonomy). */
export type InterpretationIntent =
  | "information_request"
  | "purchase_interest"
  | "product_question"
  | "service_question"
  | "complaint"
  | "support_request"
  | "praise"
  | "objection"
  | "cancellation_or_churn_signal"
  | "partnership_interest"
  | "recruitment_or_employment"
  | "spam"
  | "abuse"
  | "irrelevant"
  | "unknown";

export type InterpretationSentiment = "positive" | "neutral" | "negative" | "mixed" | "unknown";
export type InterpretationConfidence = "high" | "medium" | "low" | "unknown";

export interface InterpretationRiskFlagEntry {
  flag: string;
  evidence?: string | null;
}

/** Read-only consumption view of the R5-B interpretation record (§17 fields). */
export interface EngagementInterpretationView {
  interpretationId: string;
  classifierVersion: string;
  intent: InterpretationIntent;
  sentiment: InterpretationSentiment;
  overallConfidence: InterpretationConfidence;
  riskFlags: readonly InterpretationRiskFlagEntry[];
  explanation?: string | null;
}

/** Deterministic closed mapping: R5-B intent → R5-E intent class. */
export const INTENT_TO_INTENT_CLASS: Readonly<Record<InterpretationIntent, IntentClass>> = {
  information_request: "factual_question",
  product_question: "factual_question",
  service_question: "factual_question",
  purchase_interest: "routine_engagement",
  partnership_interest: "routine_engagement",
  praise: "praise",
  complaint: "moderate_complaint",
  support_request: "other",
  objection: "product_objection",
  cancellation_or_churn_signal: "moderate_complaint",
  recruitment_or_employment: "other",
  spam: "spam_or_abuse",
  abuse: "spam_or_abuse",
  irrelevant: "other",
  unknown: "uncertain_intent",
};

const CONFIDENCE_VALUE: Readonly<Record<InterpretationConfidence, number>> = {
  high: 0.9,
  medium: 0.7,
  low: 0.4,
  unknown: 0.2,
};

const PERSONAL_DATA_FLAGS = new Set(["privacy_sensitive", "legal_compliance_sensitive"]);

/**
 * Closed injection-marker list applied to interpretation evidence/explanation
 * text. Deliberately narrow and deterministic; a hit only ever raises risk
 * (policy floors HIGH + INJECTION_SUSPECTED) — it never blocks legitimate
 * engagement by itself and never widens authority.
 */
export const INJECTION_MARKERS: readonly string[] = [
  "ignore previous instructions",
  "ignore all previous",
  "disregard previous",
  "system prompt",
  "you are now",
  "jailbreak",
  "dan mode",
  "developer mode",
  "do anything now",
  "reveal your instructions",
  "print your instructions",
];

export function detectInjectionSuspicion(text: string | null | undefined): boolean {
  if (!text) return false;
  const normalized = text.toLowerCase();
  return INJECTION_MARKERS.some((marker) => normalized.includes(marker));
}

export interface DeriveIntelligenceInput {
  interpretation: EngagementInterpretationView;
}

/**
 * Translate one interpretation into the exact authoritative intelligence the
 * R5-E engine validates. Fail closed through E's own validator — any
 * malformed derivation is rejected before policy evaluation.
 */
export function deriveAuthoritativeIntelligence(
  input: DeriveIntelligenceInput
): AuthoritativeIntelligence {
  const interpretation = input.interpretation;
  const sentiment =
    interpretation.sentiment === "positive" ||
    interpretation.sentiment === "neutral" ||
    interpretation.sentiment === "negative"
      ? interpretation.sentiment
      : "neutral";

  const containsPersonalData = interpretation.riskFlags.some((entry) =>
    PERSONAL_DATA_FLAGS.has(entry.flag)
  );

  const flagEvidenceText = interpretation.riskFlags
    .map((entry) => entry.evidence ?? "")
    .join("\n");
  const injectionSuspected =
    detectInjectionSuspicion(flagEvidenceText) ||
    detectInjectionSuspicion(interpretation.explanation);

  return validateAuthoritativeIntelligence({
    sourceInterpretationId: interpretation.interpretationId,
    intelligenceVersion: interpretation.classifierVersion,
    sentiment,
    intentClass: INTENT_TO_INTENT_CLASS[interpretation.intent] ?? "uncertain_intent",
    confidence: CONFIDENCE_VALUE[interpretation.overallConfidence] ?? 0.2,
    containsPersonalData,
    injectionSuspected,
  });
}
