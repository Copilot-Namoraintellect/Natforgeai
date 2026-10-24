// ─── R5-B Intent & Sentiment Intelligence — risk & opportunity layer (§10, §11) ───
//
// PURE deterministic layer over the normalized interpretation plus bounded
// text markers. Every flag carries evidence; flags dedup by first evidence.
// Risk flags route to downstream human/policy review — they never trigger
// automated action from this stream. No I/O, no clock, no logging.

import type {
  ConfidenceLabel,
  HandlingClass,
  IntentLabel,
  OpportunityEntry,
  OpportunityIndicatorLabel,
  RelevanceLabel,
  RiskFlagEntry,
  RiskFlagLabel,
  SentimentLabel,
  UrgencyLabel,
} from "./interpretation-contract";
import { RiskFlagEnum, OpportunityIndicatorEnum } from "./interpretation-contract";
import { excerptOf } from "./input-safety";

// ─── Versioned marker vocabularies ───

/** Refund/dispute phrase markers → refund_dispute_or_complaint (§10). */
export const REFUND_DISPUTE_MARKERS = [
  "refund",
  "chargeback",
  "money back",
  "get my money back",
  "dispute the charge",
  "cancel my order",
] as const;

/** Legal-threat phrase markers → legal_compliance_sensitive (§10). */
export const LEGAL_THREAT_MARKERS = [
  "sue",
  "lawsuit",
  "lawyer",
  "legal action",
  "attorney",
  "court order",
] as const;

const EMAIL_PII_PATTERN = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/;
const PHONE_PII_PATTERN = /(?:\+\d{1,3}[\s-]?)?\(?\d{3}\)?[\s-]?\d{3}[\s-]?\d{4}\b/;

/** Word-boundary phrase match so short markers ("sue") never match inside words. */
function containsWordPhrase(lowerText: string, phrase: string): boolean {
  const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`\\b${escaped}\\b`).test(lowerText);
}

/** Flags that force safety escalation when present (§10). */
export const SAFETY_CRITICAL_FLAGS: readonly RiskFlagLabel[] = [
  "self_harm_safety_concern",
  "abusive_or_harassing",
];

/**
 * Positive/non-gating flags: they never force human_review on their own
 * (contract §11 step 2 gates review-forcing flags; normal_engagement and
 * potential_opportunity are signals, not review triggers).
 */
export const NON_GATING_RISK_FLAGS: readonly RiskFlagLabel[] = [
  "normal_engagement",
  "potential_opportunity",
];

export interface ClassifyRisksArgs {
  readonly text: string;
  readonly intent: IntentLabel;
  readonly sentiment: SentimentLabel;
  readonly urgency: UrgencyLabel;
  /** Validated enum values from the governed model output. */
  readonly modelRiskHints: readonly RiskFlagLabel[];
}

export interface ClassifyRisksResult {
  readonly riskFlags: readonly RiskFlagEntry[];
  /** Risk-derived handling floor: safety_escalation / human_review, else null. */
  readonly handlingOverride: HandlingClass | null;
}

function markerEvidence(prefix: string, detail: string): string {
  return excerptOf(`${prefix}: ${detail}`, 160);
}

/**
 * Deterministic risk classification. Starts from validated model hints, then
 * applies text-marker rules. Empty result means no risk; normal_engagement is
 * minted only for praise/informational intent with no other flags, as a
 * positive signal for downstream.
 */
export function classifyRisks(args: ClassifyRisksArgs): ClassifyRisksResult {
  const flags = new Map<RiskFlagLabel, RiskFlagEntry>();
  const lower = args.text.toLowerCase();

  const add = (flag: RiskFlagLabel, evidence: string): void => {
    if (!flags.has(flag)) {
      flags.set(flag, Object.freeze({ flag, evidence: excerptOf(evidence, 160) }));
    }
  };

  // Model hints pass through with explicit provenance (validated upstream).
  for (const hint of args.modelRiskHints) {
    if (RiskFlagEnum.safeParse(hint).success && !flags.has(hint)) {
      add(hint, "model_hint");
    }
  }

  // Text-marker rules.
  const refundHit = REFUND_DISPUTE_MARKERS.find((marker) => lower.includes(marker));
  if (refundHit) {
    add("refund_dispute_or_complaint", markerEvidence("matched marker", refundHit));
  }
  const legalHit = LEGAL_THREAT_MARKERS.find((marker) => containsWordPhrase(lower, marker));
  if (legalHit) {
    add("legal_compliance_sensitive", markerEvidence("matched marker", legalHit));
  }
  if (EMAIL_PII_PATTERN.test(args.text)) {
    add("privacy_sensitive", "pii_in_text: email address present in signal text");
  }
  if (PHONE_PII_PATTERN.test(args.text)) {
    add("privacy_sensitive", "pii_in_text: phone number present in signal text");
  }
  if (args.sentiment === "negative" && (args.urgency === "high" || args.urgency === "critical")) {
    add("high_emotion_escalation", "negative sentiment combined with high/critical urgency");
  }
  if (
    args.sentiment === "negative" &&
    (args.intent === "complaint" || refundHit !== undefined)
  ) {
    add("reputational_risk", "negative sentiment combined with complaint/refund intent");
  }

  // Positive signal only when nothing else applies.
  if (
    flags.size === 0 &&
    (args.intent === "praise" || args.intent === "information_request")
  ) {
    add("normal_engagement", "no risk markers; praise/informational intent");
  }

  const riskFlags = Array.from(flags.values());
  const hasSafety = riskFlags.some((entry) =>
    (SAFETY_CRITICAL_FLAGS as readonly string[]).includes(entry.flag)
  );
  const hasGating = riskFlags.some(
    (entry) => !(NON_GATING_RISK_FLAGS as readonly string[]).includes(entry.flag)
  );
  const handlingOverride: HandlingClass | null = hasSafety
    ? "safety_escalation"
    : hasGating
      ? "human_review"
      : null;

  return Object.freeze({ riskFlags, handlingOverride });
}

export interface DeriveOpportunityArgs {
  readonly intent: IntentLabel;
  readonly sentiment: SentimentLabel;
  readonly relevance: RelevanceLabel;
  /** Validated enum values from the governed model output. */
  readonly opportunityHints: readonly OpportunityIndicatorLabel[];
}

/**
 * Opportunity indicators per contract §11 example mapping. These are hints
 * for R5-D, not qualified opportunities. Returns [] when nothing applies.
 */
export function deriveOpportunityIndicators(
  args: DeriveOpportunityArgs
): readonly OpportunityEntry[] {
  const indicators = new Map<OpportunityIndicatorLabel, OpportunityEntry>();
  const add = (indicator: OpportunityIndicatorLabel, evidence: string): void => {
    if (!indicators.has(indicator)) {
      indicators.set(
        indicator,
        Object.freeze({ indicator, evidence: excerptOf(evidence, 160) })
      );
    }
  };

  if (
    args.intent === "purchase_interest" &&
    (args.sentiment === "positive" || args.sentiment === "neutral") &&
    args.relevance !== "not_relevant"
  ) {
    add("purchase_intent_detected", "purchase_interest intent with positive/neutral sentiment");
  }
  if (args.intent === "partnership_interest") {
    add("partnership_or_b2b_signal", "partnership_interest intent detected");
  }
  if (args.intent === "praise" && args.sentiment === "positive") {
    add("high_value_praise", "praise intent with positive sentiment");
  }
  if (
    (args.intent === "complaint" || args.intent === "support_request") &&
    args.sentiment === "negative"
  ) {
    add("support_recovery_moment", "complaint/support_request intent with negative sentiment");
  }
  for (const hint of args.opportunityHints) {
    if (hint === "none") continue;
    if (OpportunityIndicatorEnum.safeParse(hint).success) {
      add(hint, "model_hint");
    }
  }

  return Object.freeze(Array.from(indicators.values()));
}

export interface ResolveHandlingArgs {
  readonly riskFlags: readonly RiskFlagEntry[];
  readonly overallConfidence: ConfidenceLabel;
  readonly intent: IntentLabel;
  readonly relevance: RelevanceLabel;
  readonly opportunityIndicators: readonly OpportunityEntry[];
}

const ENGAGEMENT_SUITABLE_INTENTS: readonly IntentLabel[] = [
  "information_request",
  "product_question",
  "service_question",
  "purchase_interest",
  "praise",
];

/**
 * Recommended-handling resolution (contract §11, first match wins):
 * 1. safety-critical risk flag → safety_escalation
 * 2. any other gating risk flag, or overall confidence low/unknown → human_review
 * 3. opportunity indicator present with overall ≥ medium → opportunity_candidate
 * 4. engagement-suitable intent, overall ≥ medium, relevance ≠ not_relevant → candidate_for_engagement
 * 5. definitive spam/irrelevant/abuse intent → no_action
 * 6. otherwise → monitor
 */
export function resolveRecommendedHandling(
  args: ResolveHandlingArgs
): HandlingClass {
  const flagLabels = args.riskFlags.map((entry) => entry.flag);
  if (flagLabels.some((flag) => (SAFETY_CRITICAL_FLAGS as readonly string[]).includes(flag))) {
    return "safety_escalation";
  }
  const hasGatingRisk = args.riskFlags.some(
    (entry) => !(NON_GATING_RISK_FLAGS as readonly string[]).includes(entry.flag)
  );
  if (
    hasGatingRisk ||
    args.overallConfidence === "low" ||
    args.overallConfidence === "unknown"
  ) {
    return "human_review";
  }
  if (
    args.opportunityIndicators.length > 0 &&
    (args.overallConfidence === "medium" || args.overallConfidence === "high")
  ) {
    return "opportunity_candidate";
  }
  if (
    ENGAGEMENT_SUITABLE_INTENTS.includes(args.intent) &&
    (args.overallConfidence === "medium" || args.overallConfidence === "high") &&
    args.relevance !== "not_relevant"
  ) {
    return "candidate_for_engagement";
  }
  if (args.intent === "spam" || args.intent === "irrelevant" || args.intent === "abuse") {
    return "no_action";
  }
  return "monitor";
}
