/**
 * Governed Risk Classification (WBS-R5-E4).
 *
 * Deterministic derivation of LOW/MEDIUM/HIGH/CRITICAL risk tiers from
 * AUTHORITATIVE intelligence features only. A risk tier is never accepted
 * from a client: the action-request contract rejects client risk fields and
 * this module derives the tier from the server-resolved interpretation.
 *
 * Domain definitions follow the R5-E mission examples, tightened by R4
 * authority (the engagement sensitive-reply precedent: negative/urgent
 * sentiment raises review). The invariant enforced everywhere: a higher tier
 * can only reduce autonomy, never expand it (policy-model validation plus a
 * monotone floor design here — every additional adverse factor can only
 * raise the tier).
 *
 * Pure module: no database, no clock, no I/O. Intelligence content (social
 * text) is treated strictly as inert data; prompt-injection suspicion is an
 * adverse factor that raises risk and can never widen autonomy.
 */

import { RISK_TIER_RANK, type PolicyReasonCode, type RiskTier } from "./policy-types";

/** Closed vocabulary of authoritative intent classes (R5-B derived). */
export const INTENT_CLASSES = [
  "praise",
  "routine_engagement",
  "factual_question",
  "nuanced_question",
  "product_objection",
  "service_objection",
  "moderate_complaint",
  "severe_complaint",
  "legal_compliance",
  "privacy_issue",
  "payment_dispute",
  "refund_request",
  "personal_sensitive",
  "safety_concern",
  "reputational_crisis",
  "uncertain_intent",
  "spam_or_abuse",
  "other",
] as const;

export type IntentClass = (typeof INTENT_CLASSES)[number];

const INTENT_CLASS_SET: ReadonlySet<string> = new Set(INTENT_CLASSES);

export const INTELLIGENCE_SENTIMENTS = [
  "positive",
  "neutral",
  "negative",
  "urgent",
] as const;

export type IntelligenceSentiment = (typeof INTELLIGENCE_SENTIMENTS)[number];

const INTELLIGENCE_SENTIMENT_SET: ReadonlySet<string> = new Set(INTELLIGENCE_SENTIMENTS);

/**
 * Authoritative intelligence features, resolved server-side from the R5-B
 * interpretation record referenced by the action request. Carries derived
 * features only — never raw social content.
 */
export interface AuthoritativeIntelligence {
  /** Must match the action request's sourceInterpretationId. */
  sourceInterpretationId: string;
  /** Version/fingerprint of the interpretation used (staleness detection). */
  intelligenceVersion: string;
  sentiment: IntelligenceSentiment;
  intentClass: IntentClass;
  /** Interpretation confidence in [0, 1]. */
  confidence: number;
  /** Personal data detected in the source content (privacy escalation). */
  containsPersonalData: boolean;
  /** R5-B authority flagged prompt-injection patterns in the content. */
  injectionSuspected: boolean;
}

export class RiskClassificationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "RiskClassificationError";
    this.code = code;
  }
}

function fail(code: string, message: string): never {
  throw new RiskClassificationError(code, message);
}

/**
 * Base tier per intent class. This table IS the E4 domain authority:
 * complaint/dispute escalation and privacy-sensitive escalation floors live
 * here (never in client input, never widenable by policy).
 */
export const INTENT_CLASS_BASE_TIER: Readonly<Record<IntentClass, RiskTier>> = {
  praise: "low",
  routine_engagement: "low",
  factual_question: "low",
  nuanced_question: "medium",
  product_objection: "medium",
  service_objection: "medium",
  moderate_complaint: "medium",
  severe_complaint: "high",
  legal_compliance: "high",
  privacy_issue: "high",
  payment_dispute: "high",
  refund_request: "high",
  personal_sensitive: "high",
  safety_concern: "critical",
  reputational_crisis: "critical",
  uncertain_intent: "medium",
  spam_or_abuse: "low",
  other: "medium",
};

export interface RiskClassification {
  riskClass: RiskTier;
  /** Closed reason codes explaining every factor that raised the tier. */
  factors: PolicyReasonCode[];
}

const TIER_ORDER: readonly RiskTier[] = ["low", "medium", "high", "critical"];

function bumpTier(tier: RiskTier): RiskTier {
  const idx = TIER_ORDER.indexOf(tier);
  return TIER_ORDER[Math.min(idx + 1, TIER_ORDER.length - 1)];
}

function assertNoClientAuthorityFields(input: Record<string, unknown>): void {
  // Defence in depth: risk is derived, never accepted — even on the
  // intelligence object a forged risk field is rejected, not ignored.
  for (const key of ["riskClass", "risk", "riskLevel", "riskTier"]) {
    if (key in input) {
      fail("FORGED_RISK_FIELD", `Field "${key}" is derived authority and must never be supplied.`);
    }
  }
}

/**
 * Validate the authoritative intelligence shape. Fail closed on malformed or
 * forged input.
 */
export function validateAuthoritativeIntelligence(input: unknown): AuthoritativeIntelligence {
  if (typeof input !== "object" || input === null || Array.isArray(input)) {
    fail("INVALID_INTELLIGENCE", "Intelligence must be a structured object.");
  }
  const raw = input as Record<string, unknown>;
  assertNoClientAuthorityFields(raw);

  if (typeof raw.sourceInterpretationId !== "string" || raw.sourceInterpretationId.trim().length === 0) {
    fail("INVALID_INTELLIGENCE", "sourceInterpretationId must be a non-blank string.");
  }
  if (typeof raw.intelligenceVersion !== "string" || raw.intelligenceVersion.trim().length === 0) {
    fail("INVALID_INTELLIGENCE", "intelligenceVersion must be a non-blank string.");
  }
  if (typeof raw.intentClass !== "string" || !INTENT_CLASS_SET.has(raw.intentClass)) {
    fail("INVALID_INTELLIGENCE", `intentClass must be one of ${INTENT_CLASSES.join(", ")}.`);
  }
  if (typeof raw.sentiment !== "string" || !INTELLIGENCE_SENTIMENT_SET.has(raw.sentiment)) {
    fail("INVALID_INTELLIGENCE", `sentiment must be one of ${INTELLIGENCE_SENTIMENTS.join(", ")}.`);
  }
  if (
    typeof raw.confidence !== "number" ||
    !Number.isFinite(raw.confidence) ||
    raw.confidence < 0 ||
    raw.confidence > 1
  ) {
    fail("INVALID_INTELLIGENCE", `confidence must be a number in [0, 1], got ${String(raw.confidence)}.`);
  }
  if (typeof raw.containsPersonalData !== "boolean" || typeof raw.injectionSuspected !== "boolean") {
    fail("INVALID_INTELLIGENCE", "containsPersonalData and injectionSuspected must be booleans.");
  }

  return {
    sourceInterpretationId: raw.sourceInterpretationId.trim(),
    intelligenceVersion: raw.intelligenceVersion.trim(),
    sentiment: raw.sentiment as IntelligenceSentiment,
    intentClass: raw.intentClass as IntentClass,
    confidence: raw.confidence,
    containsPersonalData: raw.containsPersonalData,
    injectionSuspected: raw.injectionSuspected,
  };
}

/**
 * Derive the risk tier. Monotone by construction: each adverse factor only
 * ever raises the tier (max/floor composition), so a higher classification
 * can never expand downstream autonomy.
 *
 * - intent class base tier (E4 domain table);
 * - negative sentiment floors MEDIUM, urgent floors HIGH (R4 sensitive-reply
 *   precedent);
 * - personal data floors HIGH (privacy-sensitive escalation);
 * - injection suspicion floors HIGH and is recorded as a factor — injected
 *   content can only ever reduce autonomy;
 * - confidence below the policy floor bumps one tier (uncertain intent can
 *   never stay more autonomous than certain intent).
 */
export function classifyRisk(
  intelligence: AuthoritativeIntelligence,
  minAutonomousConfidence: number
): RiskClassification {
  const factors: PolicyReasonCode[] = [];
  let tier: RiskTier = INTENT_CLASS_BASE_TIER[intelligence.intentClass];

  if (intelligence.sentiment === "negative" && RISK_TIER_RANK[tier] < RISK_TIER_RANK.medium) {
    tier = "medium";
  }
  if (intelligence.sentiment === "urgent" && RISK_TIER_RANK[tier] < RISK_TIER_RANK.high) {
    tier = "high";
    factors.push("ESCALATED_BY_RISK");
  }
  if (intelligence.containsPersonalData && RISK_TIER_RANK[tier] < RISK_TIER_RANK.high) {
    tier = "high";
  }
  if (intelligence.injectionSuspected && RISK_TIER_RANK[tier] < RISK_TIER_RANK.high) {
    tier = "high";
    factors.push("INJECTION_SUSPECTED");
  } else if (intelligence.injectionSuspected) {
    factors.push("INJECTION_SUSPECTED");
  }
  if (intelligence.confidence < minAutonomousConfidence) {
    const bumped = bumpTier(tier);
    if (bumped !== tier) {
      tier = bumped;
      factors.push("CONFIDENCE_BELOW_AUTONOMY_MIN");
    }
  }

  // Deterministic de-dup, preserving canonical order of first appearance.
  const seen = new Set<PolicyReasonCode>();
  const orderedFactors = factors.filter((f) => (seen.has(f) ? false : (seen.add(f), true)));

  return { riskClass: tier, factors: orderedFactors };
}
