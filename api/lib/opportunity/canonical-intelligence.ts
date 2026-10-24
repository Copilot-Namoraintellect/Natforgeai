// ─── R5-D Opportunity Detection — canonical interpretation boundary ───
//
// PURE adapter module aligned with the frozen R5-B social-intelligence
// contracts (docs/contracts/social-intelligence-contract.md and
// docs/contracts/intelligence-to-engagement-opportunity-contract.md @
// feature/r5-b-intent-sentiment b939328). It consumes the R5-B-consumable
// interpretation field set (B handoff contract §17–§18 plus A-side lineage
// allowed to R5-D by A contract §13) and normalizes it into the canonical
// interpretation evaluated by the R5-D detector. No R5-B code is imported;
// the structural mirror below is the only coupling.
//
// Identity mapping (R5-B → R5-D), preserved verbatim:
//   interpretationId/signalId/signalVersion/signalType/provider/platform/
//   businessId/sourceCampaignId/parentExternalObjectId/intent/sentiment/
//   urgency/relevance/overallConfidence/opportunityIndicators/topics/
//   riskFlags/recommendedHandling/classifierVersion/createdAt.
//   businessId null = R5-A unattributed, tenant-scoped (B §3) — never a
//   fabricated linkage.
//
// Invalid input fails closed with a typed error before any rule processing
// (no record, no candidate). No I/O, no clock, no logging.

import { z } from "zod";
import { OpportunityInputError } from "./opportunity-contract";

export const CANONICAL_INTELLIGENCE_CONTRACT_VERSION = "canonical-intelligence/v1" as const;

// ─── Frozen upstream vocabularies (mirrored, never extended) ───

export const SIGNAL_TYPE_VALUES = [
  "comment",
  "reply",
  "mention",
  "reaction",
  "direct_message",
  "repost",
  "follow",
  "unfollow",
  "campaign_response",
  "inbound_message",
  "unknown",
] as const;

export const PROVIDER_VALUES = ["meta", "linkedin", "twitter", "tiktok"] as const;
export const PLATFORM_VALUES = [
  "facebook",
  "instagram",
  "whatsapp",
  "linkedin",
  "twitter",
  "tiktok",
] as const;

export const INTENT_VALUES = [
  "information_request",
  "purchase_interest",
  "product_question",
  "service_question",
  "complaint",
  "support_request",
  "praise",
  "objection",
  "cancellation_or_churn_signal",
  "partnership_interest",
  "recruitment_or_employment",
  "spam",
  "abuse",
  "irrelevant",
  "unknown",
] as const;

export const SENTIMENT_VALUES = ["positive", "neutral", "negative", "mixed", "unknown"] as const;
export const URGENCY_VALUES = ["low", "normal", "high", "critical"] as const;
export const RELEVANCE_VALUES = ["relevant", "partially_relevant", "not_relevant", "unknown"] as const;
export const CONFIDENCE_LABEL_VALUES = ["high", "medium", "low", "unknown"] as const;

export const HANDLING_VALUES = [
  "no_action",
  "monitor",
  "candidate_for_engagement",
  "human_review",
  "safety_escalation",
  "opportunity_candidate",
] as const;

export const RISK_FLAG_VALUES = [
  "abusive_or_harassing",
  "self_harm_safety_concern",
  "legal_compliance_sensitive",
  "privacy_sensitive",
  "refund_dispute_or_complaint",
  "reputational_risk",
  "high_emotion_escalation",
  "spam_or_scam",
  "potential_opportunity",
  "normal_engagement",
] as const;

export const OPPORTUNITY_INDICATOR_VALUES = [
  "purchase_intent_detected",
  "partnership_or_b2b_signal",
  "high_value_praise",
  "support_recovery_moment",
  "repeat_engagement_signal",
  "none",
] as const;

export const SAFETY_CRITICAL_RISK_FLAGS: readonly string[] = [
  "self_harm_safety_concern",
  "abusive_or_harassing",
];

/** Gating (non-safety) risk flags — force suppression before rule evaluation. */
export const GATING_RISK_FLAGS: readonly string[] = [
  "legal_compliance_sensitive",
  "privacy_sensitive",
  "refund_dispute_or_complaint",
  "reputational_risk",
  "high_emotion_escalation",
  "spam_or_scam",
];

export const IntentLabelEnum = z.enum(INTENT_VALUES);
export const SentimentLabelEnum = z.enum(SENTIMENT_VALUES);
export const UrgencyLabelEnum = z.enum(URGENCY_VALUES);
export const RelevanceLabelEnum = z.enum(RELEVANCE_VALUES);
export const ConfidenceLabelEnum = z.enum(CONFIDENCE_LABEL_VALUES);
export const HandlingClassEnum = z.enum(HANDLING_VALUES);
export const RiskFlagEnum = z.enum(RISK_FLAG_VALUES);
export const OpportunityIndicatorEnum = z.enum(OPPORTUNITY_INDICATOR_VALUES);

export type CanonicalIntentLabel = z.infer<typeof IntentLabelEnum>;
export type CanonicalSentimentLabel = z.infer<typeof SentimentLabelEnum>;
export type CanonicalUrgencyLabel = z.infer<typeof UrgencyLabelEnum>;
export type CanonicalRelevanceLabel = z.infer<typeof RelevanceLabelEnum>;
export type CanonicalConfidenceLabel = z.infer<typeof ConfidenceLabelEnum>;
export type CanonicalHandlingClass = z.infer<typeof HandlingClassEnum>;

const RiskFlagEntrySchema = z.strictObject({
  flag: RiskFlagEnum,
  evidence: z.string().max(160),
});
const OpportunityEntrySchema = z.strictObject({
  indicator: OpportunityIndicatorEnum,
  evidence: z.string().max(160),
});

// ─── Strict input schema (aligned R5-B consumption boundary) ───

const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));
const ISO_REFINEMENT = { message: "must be a parseable ISO 8601 timestamp" } as const;

export const CanonicalInterpretationInputSchema = z.strictObject({
  /** R5-B interpretationId, consumed opaquely. */
  interpretationId: z.string().min(1).max(64),
  classifierVersion: z.string().min(1).max(64),
  /** Server-resolved tenant owner (B §4); re-validated against the session. */
  userId: z.number().int().positive(),
  /** Server-validated owner business; null = unattributed tenant-scoped. */
  businessId: z.number().int().positive().nullable(),
  /** R5-A signalKey, consumed opaquely. */
  signalId: z.string().min(1).max(128),
  signalVersion: z.number().int().min(1),
  signalType: z.enum(SIGNAL_TYPE_VALUES),
  provider: z.enum(PROVIDER_VALUES),
  platform: z.enum(PLATFORM_VALUES),
  /** Opaque provider actor id; bound into actorKey as a hash, never stored raw. */
  actorReference: z.string().min(1).max(255).nullable().optional(),
  /** Bounded display name; never persisted by R5-D. */
  actorDisplayName: z.string().min(1).max(255).nullable().optional(),
  /** Provider event time, ISO 8601; evidence ordering only. */
  occurredAt: z.string().min(1).refine(ISO_8601_PARSEABLE, ISO_REFINEMENT).nullable().optional(),
  /** R5-A threading reference (thread linkage authority). */
  parentExternalObjectId: z.string().min(1).max(255).nullable().optional(),
  /** R5-A object reference (thread fallback). */
  externalObjectId: z.string().min(1).max(255).nullable().optional(),
  /** R5-B relevance context lineage. */
  sourceCampaignId: z.number().int().positive().nullable().optional(),
  /** R5-A publication lineage where authoritative (else null). */
  sourcePublicationId: z.string().min(1).max(255).nullable().optional(),
  source: z.enum(["RULE", "MODEL"]),
  intent: IntentLabelEnum,
  sentiment: SentimentLabelEnum,
  urgency: UrgencyLabelEnum,
  relevance: RelevanceLabelEnum,
  overallConfidence: ConfidenceLabelEnum,
  topics: z.array(z.string().max(48)).max(5),
  riskFlags: z.array(RiskFlagEntrySchema).max(10),
  opportunityIndicators: z.array(OpportunityEntrySchema).max(6),
  recommendedHandling: HandlingClassEnum,
  /** Single clock read at the upstream persistence boundary. */
  createdAt: z.string().min(1).refine(ISO_8601_PARSEABLE, ISO_REFINEMENT),
});

export type CanonicalInterpretationInput = z.infer<typeof CanonicalInterpretationInputSchema>;

/** Canonical, normalized, deeply-frozen interpretation consumed by R5-D. */
export interface CanonicalInterpretation {
  readonly interpretationContractVersion: typeof CANONICAL_INTELLIGENCE_CONTRACT_VERSION;
  readonly interpretationId: string;
  readonly classifierVersion: string;
  readonly userId: number;
  readonly businessId: number | null;
  readonly signalId: string;
  readonly signalVersion: number;
  readonly signalType: (typeof SIGNAL_TYPE_VALUES)[number];
  readonly provider: (typeof PROVIDER_VALUES)[number];
  readonly platform: (typeof PLATFORM_VALUES)[number];
  readonly actorReference: string | null;
  readonly occurredAt: string | null;
  readonly parentExternalObjectId: string | null;
  readonly externalObjectId: string | null;
  readonly sourceCampaignId: number | null;
  readonly sourcePublicationId: string | null;
  readonly source: "RULE" | "MODEL";
  readonly intent: CanonicalIntentLabel;
  readonly sentiment: CanonicalSentimentLabel;
  readonly urgency: CanonicalUrgencyLabel;
  readonly relevance: CanonicalRelevanceLabel;
  readonly overallConfidence: CanonicalConfidenceLabel;
  readonly topics: readonly string[];
  readonly riskFlags: readonly { readonly flag: string; readonly evidence: string }[];
  readonly opportunityIndicators: readonly { readonly indicator: string; readonly evidence: string }[];
  readonly recommendedHandling: CanonicalHandlingClass;
  readonly createdAt: string;
}

function deepFreeze<T>(value: T): T {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

function failInput(code: string, message: string): never {
  throw new OpportunityInputError(code, message);
}

/**
 * Validates and normalizes an R5-B-facing interpretation into the canonical
 * readonly shape. Fails closed with {@link OpportunityInputError} on any
 * schema deviation before any rule processing.
 */
export function toCanonicalInterpretation(input: unknown): CanonicalInterpretation {
  const parsed = CanonicalInterpretationInputSchema.safeParse(input);
  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    failInput("INVALID_INTERPRETATION_INPUT", `Interpretation input failed schema validation: ${issues}`);
  }
  const data = parsed.data;
  return deepFreeze({
    interpretationContractVersion: CANONICAL_INTELLIGENCE_CONTRACT_VERSION,
    interpretationId: data.interpretationId,
    classifierVersion: data.classifierVersion,
    userId: data.userId,
    businessId: data.businessId,
    signalId: data.signalId,
    signalVersion: data.signalVersion,
    signalType: data.signalType,
    provider: data.provider,
    platform: data.platform,
    actorReference: data.actorReference ?? null,
    occurredAt: data.occurredAt ?? null,
    parentExternalObjectId: data.parentExternalObjectId ?? null,
    externalObjectId: data.externalObjectId ?? null,
    sourceCampaignId: data.sourceCampaignId ?? null,
    sourcePublicationId: data.sourcePublicationId ?? null,
    source: data.source,
    intent: data.intent,
    sentiment: data.sentiment,
    urgency: data.urgency,
    relevance: data.relevance,
    overallConfidence: data.overallConfidence,
    topics: data.topics,
    riskFlags: data.riskFlags,
    opportunityIndicators: data.opportunityIndicators,
    recommendedHandling: data.recommendedHandling,
    createdAt: data.createdAt,
  }) as CanonicalInterpretation;
}

/**
 * Structural convergence seam for R5-X: pure, fail-closed mapper from a
 * `social_interpretations` row shape (B-owned durable record, JSON `record`
 * column + query dims) to the strict input above. No R5-B code is imported;
 * the field mirror is the only coupling. Unknown fields are ignored; missing
 * or malformed contract fields fail closed.
 */
export function adaptSocialInterpretation(row: unknown): CanonicalInterpretation {
  if (typeof row !== "object" || row === null) {
    failInput("INVALID_INTERPRETATION_ROW", "adaptSocialInterpretation requires a row object.");
  }
  const record = row as Record<string, unknown>;
  const source = (record.record ?? record) as Record<string, unknown>;
  return toCanonicalInterpretation({
    interpretationId: source.interpretationId ?? record.interpretationId,
    classifierVersion: source.classifierVersion ?? record.classifierVersion,
    userId: source.userId ?? record.userId,
    businessId: source.businessId ?? record.businessId ?? null,
    signalId: source.signalId ?? record.signalId,
    signalVersion: source.signalVersion ?? record.signalVersion,
    signalType: source.signalType ?? record.signalType,
    provider: source.provider ?? record.provider,
    platform: source.platform ?? record.platform,
    actorReference: source.actorReference ?? null,
    actorDisplayName: source.actorDisplayName ?? null,
    occurredAt: source.occurredAt ?? null,
    parentExternalObjectId: source.parentExternalObjectId ?? null,
    externalObjectId: source.externalObjectId ?? null,
    sourceCampaignId: source.sourceCampaignId ?? null,
    sourcePublicationId: source.sourcePublicationId ?? null,
    source: source.source,
    intent: source.intent,
    sentiment: source.sentiment,
    urgency: source.urgency,
    relevance: source.relevance,
    overallConfidence: source.overallConfidence,
    topics: source.topics ?? [],
    riskFlags: source.riskFlags ?? [],
    opportunityIndicators: source.opportunityIndicators ?? [],
    recommendedHandling: source.recommendedHandling,
    createdAt: source.createdAt,
  });
}

/** True when the interpretation carries a safety-critical risk flag. */
export function hasSafetyCriticalFlag(interpretation: CanonicalInterpretation): boolean {
  return interpretation.riskFlags.some((entry) => SAFETY_CRITICAL_RISK_FLAGS.includes(entry.flag));
}

/** True when the interpretation carries a non-safety gating risk flag. */
export function hasGatingRiskFlag(interpretation: CanonicalInterpretation): boolean {
  return interpretation.riskFlags.some((entry) => GATING_RISK_FLAGS.includes(entry.flag));
}

/** True when the given opportunity indicator is present. */
export function hasIndicator(interpretation: CanonicalInterpretation, indicator: string): boolean {
  return interpretation.opportunityIndicators.some((entry) => entry.indicator === indicator);
}
