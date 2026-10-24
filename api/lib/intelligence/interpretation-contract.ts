// ─── R5-B Intent & Sentiment Intelligence — canonical interpretation contract ───
//
// PURE contract module: closed vocabularies, canonical record types, zod
// schemas and typed error taxonomy for the social-intelligence interpretation
// authority (docs/contracts/social-intelligence-contract.md). It performs no
// I/O of any kind, has no clock and authorizes nothing. Interpretation never
// executes an action: recommendedHandling is a classification for downstream
// governance, not a command.

import { z } from "zod";
import type { CanonicalSignalType } from "./canonical-signal";

export const SOCIAL_INTELLIGENCE_SCHEMA_VERSION = "social-intelligence/v1" as const;
export const CLASSIFIER_VERSION = "intent-sentiment-classifier/v1" as const;

// ─── Controlled vocabularies (contract §6 — closed) ───

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

export const CONFIDENCE_VALUES = ["high", "medium", "low", "unknown"] as const;

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

export const EVIDENCE_KIND_VALUES = [
  "signal_excerpt",
  "rule",
  "model",
  "business_dna",
  "provider_metadata",
] as const;

export const CONFIDENCE_BASIS_VALUES = [
  "deterministic_rule",
  "model_self_assessed",
  "insufficient_evidence",
] as const;

export const MODEL_OR_RULE_SOURCE_VALUES = ["RULE", "MODEL"] as const;

// ─── zod enums over the closed vocabularies ───

export const IntentLabelEnum = z.enum(INTENT_VALUES);
export const SentimentLabelEnum = z.enum(SENTIMENT_VALUES);
export const UrgencyLabelEnum = z.enum(URGENCY_VALUES);
export const RelevanceLabelEnum = z.enum(RELEVANCE_VALUES);
export const ConfidenceLabelEnum = z.enum(CONFIDENCE_VALUES);
export const HandlingClassEnum = z.enum(HANDLING_VALUES);
export const RiskFlagEnum = z.enum(RISK_FLAG_VALUES);
export const OpportunityIndicatorEnum = z.enum(OPPORTUNITY_INDICATOR_VALUES);
export const EvidenceKindEnum = z.enum(EVIDENCE_KIND_VALUES);
export const ConfidenceBasisEnum = z.enum(CONFIDENCE_BASIS_VALUES);
export const ModelOrRuleSourceEnum = z.enum(MODEL_OR_RULE_SOURCE_VALUES);

export type IntentLabel = z.infer<typeof IntentLabelEnum>;
export type SentimentLabel = z.infer<typeof SentimentLabelEnum>;
export type UrgencyLabel = z.infer<typeof UrgencyLabelEnum>;
export type RelevanceLabel = z.infer<typeof RelevanceLabelEnum>;
export type ConfidenceLabel = z.infer<typeof ConfidenceLabelEnum>;
export type HandlingClass = z.infer<typeof HandlingClassEnum>;
export type RiskFlagLabel = z.infer<typeof RiskFlagEnum>;
export type OpportunityIndicatorLabel = z.infer<typeof OpportunityIndicatorEnum>;
export type EvidenceKind = z.infer<typeof EvidenceKindEnum>;
export type ConfidenceBasis = z.infer<typeof ConfidenceBasisEnum>;
export type ModelOrRuleSource = z.infer<typeof ModelOrRuleSourceEnum>;

// ─── Evidence-carrying entries (contract §10, §11, §14) ───

export const RiskFlagEntrySchema = z.strictObject({
  flag: RiskFlagEnum,
  evidence: z.string().max(160),
});
export type RiskFlagEntry = z.infer<typeof RiskFlagEntrySchema>;

export const OpportunityEntrySchema = z.strictObject({
  indicator: OpportunityIndicatorEnum,
  evidence: z.string().max(160),
});
export type OpportunityEntry = z.infer<typeof OpportunityEntrySchema>;

export const EvidenceReferenceSchema = z.strictObject({
  kind: EvidenceKindEnum,
  ref: z.string().max(128),
  excerpt: z.string().max(160).optional(),
});
export type EvidenceReference = z.infer<typeof EvidenceReferenceSchema>;

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class InterpretationError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "InterpretationError";
    this.code = code;
  }
}

/** Untrusted input failed safety/bounding validation (§7). */
export class InterpretationInputError extends InterpretationError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "InterpretationInputError";
  }
}

/** A record or model output failed schema validation. */
export class InterpretationValidationError extends InterpretationError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "InterpretationValidationError";
  }
}

/** Replay/identity conflict: same signal version, different content hash (§5). */
export class InterpretationTamperError extends InterpretationError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "InterpretationTamperError";
  }
}

/** Signal type outside the closed enum; rejected before any processing (§3). */
export class UnsupportedSignalTypeError extends InterpretationError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "UnsupportedSignalTypeError";
  }
}

// ─── Canonical interpretation record (contract §4) ───

/**
 * Single canonical interpretation model produced by the R5-B intelligence
 * layer. All fields readonly; records are immutable once accepted.
 */
export interface SocialInterpretation {
  readonly interpretationId: string;
  readonly schemaVersion: typeof SOCIAL_INTELLIGENCE_SCHEMA_VERSION;
  readonly classifierVersion: typeof CLASSIFIER_VERSION;
  readonly userId: number;
  readonly businessId: number;
  readonly signalId: string;
  readonly signalVersion: number;
  readonly signalContentHash: string;
  readonly signalType: CanonicalSignalType;
  /** Producing authority (contract §12): deterministic rule or governed model. */
  readonly source: ModelOrRuleSource;
  readonly intent: IntentLabel;
  readonly intentConfidence: ConfidenceLabel;
  readonly sentiment: SentimentLabel;
  readonly sentimentConfidence: ConfidenceLabel;
  readonly urgency: UrgencyLabel;
  readonly relevance: RelevanceLabel;
  readonly relevanceConfidence: ConfidenceLabel;
  readonly overallConfidence: ConfidenceLabel;
  readonly confidenceBasis: ConfidenceBasis;
  /** Navigation hints: ≤5 entries, each ≤48 chars, lowercase, no PII. */
  readonly topics: readonly string[];
  readonly riskFlags: readonly RiskFlagEntry[];
  readonly opportunityIndicators: readonly OpportunityEntry[];
  /** Classification only — never executed by this stream. */
  readonly recommendedHandling: HandlingClass;
  /** Immutable context reference when a Business DNA snapshot was used (§9). */
  readonly businessDnaSnapshotId: string | null;
  readonly evidenceReferences: readonly EvidenceReference[];
  /** Display-only; never re-fed as authority. */
  readonly explanation: string;
  /** Null on the RULE path (non-billable, contract §13). */
  readonly billingIdentity: string | null;
  /** sha256 of the full accepted record (§5). */
  readonly interpretationFingerprint: string;
  /** Single clock read at the persistence boundary; never generated here. */
  readonly createdAt: string;
  readonly status: "accepted";
}

/**
 * Pre-persistence validation schema for the full canonical record. Used by the
 * orchestrator/store slice; kept here so the record contract lives in exactly
 * one authority module.
 */
export const SocialInterpretationSchema = z.strictObject({
  interpretationId: z.string().min(1),
  schemaVersion: z.literal(SOCIAL_INTELLIGENCE_SCHEMA_VERSION),
  classifierVersion: z.literal(CLASSIFIER_VERSION),
  userId: z.number().int().positive(),
  businessId: z.number().int().positive(),
  signalId: z.string().min(1).max(128),
  signalVersion: z.number().int().min(1),
  signalContentHash: z.string().regex(/^[a-f0-9]{64}$/),
  signalType: z.enum([
    "comment",
    "message",
    "mention",
    "reaction",
    "share",
    "dm",
    "post_interaction",
    "unknown",
  ]),
  source: ModelOrRuleSourceEnum,
  intent: IntentLabelEnum,
  intentConfidence: ConfidenceLabelEnum,
  sentiment: SentimentLabelEnum,
  sentimentConfidence: ConfidenceLabelEnum,
  urgency: UrgencyLabelEnum,
  relevance: RelevanceLabelEnum,
  relevanceConfidence: ConfidenceLabelEnum,
  overallConfidence: ConfidenceLabelEnum,
  confidenceBasis: ConfidenceBasisEnum,
  topics: z.array(z.string().max(48)).max(5),
  riskFlags: z.array(RiskFlagEntrySchema).max(10),
  opportunityIndicators: z.array(OpportunityEntrySchema).max(6),
  recommendedHandling: HandlingClassEnum,
  businessDnaSnapshotId: z.string().max(128).nullable(),
  evidenceReferences: z.array(EvidenceReferenceSchema).max(8),
  explanation: z.string().min(1).max(280),
  billingIdentity: z.string().min(1).nullable(),
  interpretationFingerprint: z.string().regex(/^[a-f0-9]{64}$/),
  createdAt: z.string().min(1),
  status: z.literal("accepted"),
});

/**
 * Fail-closed guard for a fully-constructed interpretation record. Throws a
 * typed {@link InterpretationValidationError} on any schema deviation.
 */
export function assertValidInterpretationRecord(record: unknown): SocialInterpretation {
  const result = SocialInterpretationSchema.safeParse(record);
  if (!result.success) {
    const issues = result.error.issues
      .map((issue) => `${issue.path.join(".") || "(root)"}: ${issue.message}`)
      .join("; ");
    throw new InterpretationValidationError(
      "INVALID_INTERPRETATION_RECORD",
      `Interpretation record failed canonical schema validation: ${issues}`
    );
  }
  return result.data as SocialInterpretation;
}

// ─── Governed model output schema (contract §7, §12) ───

/**
 * Structured model output contract: the only channel by which model reasoning
 * can influence a record. Labels outside the closed vocabularies cannot parse.
 */
export const ModelInterpretationSchema = z.strictObject({
  intent: IntentLabelEnum,
  sentiment: SentimentLabelEnum,
  urgency: UrgencyLabelEnum,
  /** Ordinal self-assessment; never re-labelled as statistical confidence. */
  modelConfidence: z.enum(["high", "medium", "low"]),
  relevanceHint: RelevanceLabelEnum.optional(),
  topics: z.array(z.string().max(48)).max(5),
  riskHints: z.array(RiskFlagEnum).max(6),
  opportunityHints: z.array(OpportunityIndicatorEnum).max(4),
  evidence: z.array(z.string().max(160)).max(5),
  explanation: z.string().min(1).max(280),
});

export type ModelInterpretation = z.infer<typeof ModelInterpretationSchema>;
