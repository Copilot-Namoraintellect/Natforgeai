// ─── R5-D Opportunity Detection — canonical opportunity candidate contract ───
//
// PURE contract module: closed vocabularies, canonical record types, zod
// schemas and typed error taxonomy for the opportunity-detection authority
// (docs/contracts/opportunity-candidate-contract.md). It performs no I/O of
// any kind, has no clock and authorizes nothing. An opportunity candidate is
// an evidence-backed marketing/business signal, NOT yet a lead: this stream
// never creates leads, assigns lead scores, performs outreach, or initiates
// governed marketing actions (R5-E owns action policy).

import { z } from "zod";

export const OPPORTUNITY_CANDIDATE_CONTRACT_VERSION = "opportunity-candidate/v1" as const;
export const DETECTOR_RULES_VERSION = "opportunity-detector/v1" as const;
export const HANDOFF_ENVELOPE_VERSION = "opportunity-to-lead-autonomy/v1" as const;

// ─── R5-D controlled vocabularies (candidate contract §3, §4, §6, §9 — closed) ───

export const OPPORTUNITY_TYPE_VALUES = [
  "purchase_interest",
  "service_enquiry",
  "demo_or_consultation_interest",
  "partnership_interest",
  "repeat_interest",
  "retention_risk",
  "churn_risk",
  "referral_or_advocacy",
  "unresolved_complaint_opportunity",
  "support_to_sales_transition",
  "unknown",
] as const;

/** Types the v1 rule table can legitimately mint (contract §3). */
export const EMITTED_OPPORTUNITY_TYPE_VALUES = [
  "purchase_interest",
  "service_enquiry",
  "partnership_interest",
  "retention_risk",
  "unresolved_complaint_opportunity",
  "referral_or_advocacy",
  "support_to_sales_transition",
] as const;

export const OPPORTUNITY_STATUS_VALUES = [
  "candidate",
  "strengthening",
  "weak",
  "suppressed",
  "expired",
  "escalated",
  "handed_off_to_r6",
] as const;

/** Bounded honest ordinals (contract §6) — never a calibrated probability. */
export const CONFIDENCE_CLASS_VALUES = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;
export const EVIDENCE_STRENGTH_VALUES = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;

export const SUPPRESSION_REASON_VALUES = [
  "SAFETY_ESCALATION",
  "RISK_GATED",
  "POLICY_SUPPRESSED",
  "NOT_OPPORTUNITY_SIGNAL",
  "INSUFFICIENT_CLASSIFICATION",
  "NO_OPPORTUNITY_CLASSIFICATION",
  "LOW_RELEVANCE",
  "FLOOD_GUARDED",
] as const;

export const EVIDENCE_KIND_VALUES = ["signal_interpretation", "engagement_receipt"] as const;

export const URGENCY_VALUES = ["low", "normal", "high", "critical"] as const;

// ─── zod enums over the closed vocabularies ───

export const OpportunityTypeEnum = z.enum(OPPORTUNITY_TYPE_VALUES);
export const OpportunityStatusEnum = z.enum(OPPORTUNITY_STATUS_VALUES);
export const ConfidenceClassEnum = z.enum(CONFIDENCE_CLASS_VALUES);
export const EvidenceStrengthEnum = z.enum(EVIDENCE_STRENGTH_VALUES);
export const SuppressionReasonEnum = z.enum(SUPPRESSION_REASON_VALUES);
export const EvidenceKindEnum = z.enum(EVIDENCE_KIND_VALUES);
export const UrgencyEnum = z.enum(URGENCY_VALUES);

export type OpportunityType = z.infer<typeof OpportunityTypeEnum>;
export type OpportunityStatus = z.infer<typeof OpportunityStatusEnum>;
export type ConfidenceClass = z.infer<typeof ConfidenceClassEnum>;
export type EvidenceStrength = z.infer<typeof EvidenceStrengthEnum>;
export type SuppressionReason = z.infer<typeof SuppressionReasonEnum>;
export type EvidenceKind = z.infer<typeof EvidenceKindEnum>;
export type OpportunityUrgency = z.infer<typeof UrgencyEnum>;

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export class OpportunityError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "OpportunityError";
    this.code = code;
  }
}

/** Evaluation input failed safety/bounding/ownership validation. */
export class OpportunityInputError extends OpportunityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OpportunityInputError";
  }
}

/** A record or receipt failed schema validation. */
export class OpportunityValidationError extends OpportunityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OpportunityValidationError";
  }
}

/** Evidence hash drift — retained evidence no longer matches its hash. */
export class OpportunityTamperError extends OpportunityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OpportunityTamperError";
  }
}

/** Tenant/business ownership could not be proven server-side. */
export class OpportunityOwnershipError extends OpportunityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OpportunityOwnershipError";
  }
}

/** Guarded state transition rejected (stale version / illegal transition). */
export class OpportunityStateConflictError extends OpportunityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "OpportunityStateConflictError";
  }
}

/** Engagement receipt failed seam validation. */
export class ForgedEvidenceError extends OpportunityError {
  constructor(code: string, message: string) {
    super(code, message);
    this.name = "ForgedEvidenceError";
  }
}

export type OpportunityDuplicateClassification = "none" | "idempotent_replay";

// ─── Canonical local helpers (repo convention: each module owns a copy) ───

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value) ?? "undefined";
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(",")}]`;
  }
  const obj = value as Record<string, unknown>;
  const entries = Object.keys(obj)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(obj[key])}`);
  return `{${entries.join(",")}}`;
}

export function sha256Hex(input: string): string {
  // Lazy require-free import kept at module top by bundlers; crypto is node builtin.
  return createSha256(input);
}

import { createHash } from "crypto";
function createSha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export const HEX_64 = /^[a-f0-9]{64}$/;
const ISO_8601_PARSEABLE = (value: string) => !Number.isNaN(Date.parse(value));
const ISO_REFINEMENT = { message: "must be a parseable ISO 8601 timestamp" } as const;

// ─── Evidence reference (contract §2 — references only, no social text) ───

export const EvidenceRefSchema = z.strictObject({
  interpretationId: z.string().min(1).max(64),
  signalId: z.string().min(1).max(128),
  signalVersion: z.number().int().min(1),
  occurredAt: z.string().min(1).refine(ISO_8601_PARSEABLE, ISO_REFINEMENT),
});
export type EvidenceRef = z.infer<typeof EvidenceRefSchema>;

// ─── Immutable evidence row (contract §5) ───

export interface OpportunityEvidence {
  readonly id: number;
  readonly candidateId: number;
  readonly userId: number;
  readonly interpretationId: string;
  readonly signalId: string;
  readonly signalVersion: number;
  readonly kind: EvidenceKind;
  readonly engagementReceiptId: string | null;
  readonly opportunityTypeAtEvaluation: OpportunityType;
  readonly intent: string;
  readonly overallConfidence: string;
  readonly relevance: string;
  readonly sentiment: string;
  readonly urgency: OpportunityUrgency;
  readonly sourceCampaignId: number | null;
  readonly occurredAt: string;
  readonly contributesToStrength: boolean;
  readonly evidenceHash: string;
  readonly createdAt: string;
}

// ─── Durable suppression record (contract §9) ───

export interface OpportunitySuppression {
  readonly id: number;
  readonly userId: number;
  readonly businessId: number | null;
  readonly interpretationId: string;
  readonly signalId: string;
  readonly reason: SuppressionReason;
  readonly detail: string | null;
  /** Thread coordinates allow R9/R10 thread-history lookups (contract §8). */
  readonly actorKey: string | null;
  readonly threadKey: string | null;
  readonly intent: string;
  readonly occurredAt: string;
  readonly createdAt: string;
}

// ─── Canonical candidate record (contract §2) ───

export interface OpportunityCandidate {
  readonly opportunityId: string;
  readonly opportunityKey: string;
  readonly contractVersion: typeof OPPORTUNITY_CANDIDATE_CONTRACT_VERSION;
  readonly userId: number;
  readonly businessId: number | null;
  readonly opportunityType: OpportunityType;
  readonly opportunityStatus: OpportunityStatus;
  readonly confidenceClass: ConfidenceClass;
  readonly evidenceStrength: EvidenceStrength;
  readonly urgency: OpportunityUrgency;
  readonly topic: string | null;
  readonly topicKey: string;
  readonly actorKey: string;
  readonly threadKey: string;
  readonly campaignId: number | null;
  readonly publicationId: string | null;
  readonly provider: "meta" | "linkedin" | "twitter" | "tiktok" | null;
  readonly externalActorReference: null;
  readonly firstEvidence: EvidenceRef;
  readonly latestEvidence: EvidenceRef;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly evidenceCount: number;
  readonly contradictionCount: number;
  readonly detectorRulesVersion: typeof DETECTOR_RULES_VERSION;
  readonly classifierVersions: readonly string[];
  readonly version: number;
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly statusChangedAt: string;
  readonly handedOffAt: string | null;
}

// ─── R6 handoff envelope (contract §11 — references + bounded labels only) ───

export interface OpportunityHandoffEnvelope {
  readonly handoffEnvelopeVersion: typeof HANDOFF_ENVELOPE_VERSION;
  readonly handoffId: string;
  readonly opportunityId: string;
  readonly opportunityKey: string;
  readonly userId: number;
  readonly businessId: number | null;
  readonly opportunityType: OpportunityType;
  readonly opportunityStatusAtHandoff: OpportunityStatus;
  readonly confidenceClass: ConfidenceClass;
  readonly evidenceStrength: EvidenceStrength;
  readonly urgency: OpportunityUrgency;
  readonly topic: string | null;
  readonly topicKey: string;
  readonly actorKey: string;
  readonly threadKey: string;
  readonly campaignId: number | null;
  readonly publicationId: string | null;
  readonly provider: "meta" | "linkedin" | "twitter" | "tiktok" | null;
  readonly externalActorReference: null;
  readonly evidenceCount: number;
  readonly contradictionCount: number;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly detectorRulesVersion: typeof DETECTOR_RULES_VERSION;
  readonly classifierVersions: readonly string[];
  /** Bounded evidence manifest: references + closed labels only, no text. */
  readonly evidence: readonly EvidenceRef[];
  readonly evidenceSnapshotHash: string;
  readonly handedOffAt: string;
}
