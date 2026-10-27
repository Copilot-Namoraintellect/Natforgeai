// ─── R6-C Lead Qualification — canonical qualification contract ───
//
// PURE contract module: closed vocabularies, version identities, deterministic
// id/hash derivations, typed error taxonomy, zod router-input schemas and
// canonical hashing helpers for the lead-qualification authority
// (docs/contracts/lead-qualification-contract.md). It performs no I/O of any
// kind and authorizes nothing.
//
// A qualification decision is AUTHORITY derived from governed evidence + rules
// only: score is evidence, never qualification. No model sits in the decision
// path; no client may supply decisions, reason codes, confidence, policy
// content, or identity.

import { z } from "zod";

export const LEAD_QUALIFICATION_CONTRACT_VERSION = "lead-qualification/v1" as const;
export const QUALIFICATION_ENGINE_VERSION = "lead-qualification-engine/v1" as const;
export const DEFAULT_QUALIFICATION_POLICY_VERSION = "lead-qualification-policy/v1" as const;

export const QUALIFICATION_ID_PREFIX = "lqu1:" as const;
export const REVIEW_ID_PREFIX = "lqr1:" as const;
export const QUALIFICATION_ID_PATTERN = /^lqu1:[a-f0-9]{64}$/;
export const REVIEW_ID_PATTERN = /^lqr1:[a-f0-9]{64}$/;

export const LEAD_ID_PATTERN = /^lid1:[a-f0-9]{64}$/;
export const LEAD_SCORE_ID_PATTERN = /^lsc1:[a-f0-9]{64}$/;
export const HEX_64 = /^[a-f0-9]{64}$/;

export const LEAD_IDENTITY_VERSION_ALLOWED = ["lead-identity/v1"] as const;
export const LEAD_IDENTITY_SEAM_VERSION_PATTERN = /^lead-identity-seam\/v1:[a-f0-9]{64}$/;
export const SCORING_VERSION_ALLOWED = ["lead-scoring-engine/v1"] as const;
export const SCORE_CONTRACT_VERSION_ALLOWED = ["lead-scoring/v1"] as const;

export function isAllowedLeadIdentityVersion(version: string): boolean {
  return (
    (LEAD_IDENTITY_VERSION_ALLOWED as readonly string[]).includes(version) ||
    LEAD_IDENTITY_SEAM_VERSION_PATTERN.test(version)
  );
}

export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value);
}

// ─── Closed vocabularies (qualification contract §3, §4, §5 — closed) ───

export const QUALIFICATION_DECISION_VALUES = [
  "QUALIFIED",
  "NOT_QUALIFIED",
  "REVIEW_REQUIRED",
  "INSUFFICIENT_EVIDENCE",
  "BLOCKED",
] as const;
export type QualificationDecision = (typeof QUALIFICATION_DECISION_VALUES)[number];

export const QUALIFICATION_REASON_CODE_VALUES = [
  "IDENTITY_CURRENT",
  "IDENTITY_NOT_ACTIONABLE",
  "IDENTITY_CONFIDENCE_UNKNOWN",
  "PRIVACY_SUPPRESSED",
  "RETENTION_EXPIRED",
  "FIT_EVIDENCE_PRESENT",
  "MISSING_FIT_EVIDENCE",
  "INTENT_EVIDENCE_PRESENT",
  "MISSING_INTENT_EVIDENCE",
  "RECENCY_WITHIN_POLICY",
  "SCORE_BAND_SUFFICIENT",
  "SCORE_BELOW_THRESHOLD",
  "LOW_SCORE_CONFIDENCE",
  "CONTRADICTING_EVIDENCE",
  "DISQUALIFYING_EVIDENCE",
  "INSUFFICIENT_EVIDENCE_DENSITY",
  "CONFIDENCE_SUFFICIENT",
  "CONFIDENCE_BELOW_THRESHOLD",
  "REVIEW_TRIGGERED_BY_POLICY",
  "POLICY_REQUIREMENTS_MET",
] as const;
export type QualificationReasonCode = (typeof QUALIFICATION_REASON_CODE_VALUES)[number];

export const QUALIFICATION_EVIDENCE_CATEGORY_VALUES = [
  "identity_validity",
  "lead_score",
  "business_fit",
  "demonstrated_intent",
  "engagement_evidence",
  "recency",
  "source_quality",
  "opportunity_evidence",
  "eligibility_restrictions",
  "privacy_status",
] as const;
export type QualificationEvidenceCategory = (typeof QUALIFICATION_EVIDENCE_CATEGORY_VALUES)[number];

export const QUALIFICATION_EVIDENCE_STATUS_VALUES = [
  "present",
  "missing",
  "stale",
  "contradicted",
  "blocked",
  "not_required",
] as const;
export type QualificationEvidenceStatus = (typeof QUALIFICATION_EVIDENCE_STATUS_VALUES)[number];

export const SCORE_BAND_VALUES = ["VERY_LOW", "LOW", "MEDIUM", "HIGH", "VERY_HIGH"] as const;
export type ScoreBand = (typeof SCORE_BAND_VALUES)[number];

export const SCORE_CONFIDENCE_VALUES = ["LOW", "MEDIUM", "HIGH", "UNKNOWN"] as const;
export type ScoreConfidence = (typeof SCORE_CONFIDENCE_VALUES)[number];

export const IDENTITY_CONFIDENCE_ORDINAL = { unknown: 0, low: 1, medium: 2, high: 3 } as const;
export type IdentityConfidence = keyof typeof IDENTITY_CONFIDENCE_ORDINAL;

export const SCORE_CONFIDENCE_ORDINAL = { UNKNOWN: 0, LOW: 1, MEDIUM: 2, HIGH: 3 } as const;

export const SCORE_BAND_ORDINAL = { VERY_LOW: 0, LOW: 1, MEDIUM: 2, HIGH: 3, VERY_HIGH: 4 } as const;

export const REVIEW_OUTCOME_VALUES = ["progress_authorized", "progression_rejected"] as const;
export type ReviewOutcome = (typeof REVIEW_OUTCOME_VALUES)[number];

export const REVIEW_STATUS_VALUES = ["pending", "progress_authorized", "progression_rejected"] as const;
export type ReviewStatus = (typeof REVIEW_STATUS_VALUES)[number];

export const QUALIFICATION_DUPLICATE_CLASSIFICATION_VALUES = ["none", "idempotent_replay"] as const;
export type QualificationDuplicateClassification =
  (typeof QUALIFICATION_DUPLICATE_CLASSIFICATION_VALUES)[number];

export const MAX_REASON_CODES = 8;

// ─── Score-band helpers (contract §3 bands, scoring contract bands) ───

export function scoreBandFor(overallScore: number): ScoreBand {
  if (!Number.isFinite(overallScore) || overallScore < 0 || overallScore > 100) {
    throw new QualificationValidationError(
      "INVALID_SCORE",
      `overallScore must be a finite number in [0,100], got ${overallScore}`
    );
  }
  if (overallScore < 20) return "VERY_LOW";
  if (overallScore < 40) return "LOW";
  if (overallScore < 60) return "MEDIUM";
  if (overallScore < 80) return "HIGH";
  return "VERY_HIGH";
}

export function assertScoreBandConsistent(overallScore: number, band: string): void {
  const expected = scoreBandFor(overallScore);
  if (expected !== band) {
    throw new QualificationValidationError(
      "SCORE_BAND_UNKNOWN",
      `scoreBand ${band} is inconsistent with overallScore ${overallScore} (expected ${expected})`
    );
  }
}

// ─── Deterministic id/hash derivations (contract §1, §5, §10) ───
//
// Each derivation rebuilds its hashed fragment field-by-field: callers cannot
// smuggle extra keys into a hash. Same authoritative inputs ⇒ same output;
// any material change ⇒ different binding ⇒ new immutable decision row.

export interface LeadIdentityReferenceInput {
  readonly leadId: string;
  readonly businessId: number | null;
  readonly leadIdentityVersion: string;
  readonly identityStatus: string;
  readonly identityConfidence: string;
  readonly primaryIdentityType: string;
  readonly externalActorReferenceHash: string | null;
  readonly provider: string | null;
  readonly canonicalLeadId: string | null;
  readonly firstObservedAt: string;
  readonly lastObservedAt: string;
  readonly provenance: readonly unknown[];
}

export function deriveIdentityReference(input: LeadIdentityReferenceInput): string {
  return sha256Hex(
    canonicalJson({
      leadId: input.leadId,
      businessId: input.businessId,
      leadIdentityVersion: input.leadIdentityVersion,
      identityStatus: input.identityStatus,
      identityConfidence: input.identityConfidence,
      primaryIdentityType: input.primaryIdentityType,
      externalActorReferenceHash: input.externalActorReferenceHash,
      provider: input.provider,
      canonicalLeadId: input.canonicalLeadId,
      firstObservedAt: input.firstObservedAt,
      lastObservedAt: input.lastObservedAt,
      provenance: input.provenance,
    })
  );
}

export interface ScoreContentHashInput {
  readonly leadScoreId: string;
  readonly scoringVersion: string;
  readonly featureVersion: string;
  readonly scoreContractVersion: string;
  readonly leadIdentityVersion: string;
  readonly leadId: string;
  readonly businessId: number | null;
  readonly overallScore: number;
  readonly scoreBand: string;
  readonly scoreConfidence: string;
  readonly fitScore: number;
  readonly intentScore: number;
  readonly engagementScore: number;
  readonly recencyScore: number;
  readonly opportunityScore: number;
  readonly reasonCodes: readonly string[];
  readonly evidenceSnapshotHash: string;
  readonly evidenceFreshness: {
    readonly latestObservedAt: string | null;
    readonly computedAt: string;
  };
}

export function deriveScoreContentHash(input: ScoreContentHashInput): string {
  return sha256Hex(
    canonicalJson({
      leadScoreId: input.leadScoreId,
      scoringVersion: input.scoringVersion,
      featureVersion: input.featureVersion,
      scoreContractVersion: input.scoreContractVersion,
      leadIdentityVersion: input.leadIdentityVersion,
      leadId: input.leadId,
      businessId: input.businessId,
      overallScore: input.overallScore,
      scoreBand: input.scoreBand,
      scoreConfidence: input.scoreConfidence,
      fitScore: input.fitScore,
      intentScore: input.intentScore,
      engagementScore: input.engagementScore,
      recencyScore: input.recencyScore,
      opportunityScore: input.opportunityScore,
      reasonCodes: [...input.reasonCodes].sort(),
      evidenceSnapshotHash: input.evidenceSnapshotHash,
      evidenceFreshness: {
        latestObservedAt: input.evidenceFreshness.latestObservedAt,
        computedAt: input.evidenceFreshness.computedAt,
      },
    })
  );
}

export interface EvidenceSnapshotHashInput {
  readonly assembledAt: string;
  readonly identity: {
    readonly leadId: string;
    readonly leadIdentityVersion: string;
    readonly identityReference: string;
    readonly identityStatus: string;
    readonly identityConfidence: string;
  };
  readonly score: {
    readonly leadScoreId: string;
    readonly scoringVersion: string;
    readonly scoreContentHash: string;
    readonly scoreBand: string;
    readonly scoreConfidence: string;
  };
  readonly policy: {
    readonly qualificationPolicyVersion: string;
  };
  readonly entries: readonly {
    readonly category: string;
    readonly status: string;
    readonly detail: string;
  }[];
}

export function deriveEvidenceSnapshotHash(input: EvidenceSnapshotHashInput): string {
  return sha256Hex(
    canonicalJson({
      // Assembly wall time is metadata, not evidence identity. Otherwise every
      // later HTTP retry creates a fresh decision and audit event.
      identity: {
        leadId: input.identity.leadId,
        leadIdentityVersion: input.identity.leadIdentityVersion,
        identityReference: input.identity.identityReference,
        identityStatus: input.identity.identityStatus,
        identityConfidence: input.identity.identityConfidence,
      },
      score: {
        leadScoreId: input.score.leadScoreId,
        scoringVersion: input.score.scoringVersion,
        scoreContentHash: input.score.scoreContentHash,
        scoreBand: input.score.scoreBand,
        scoreConfidence: input.score.scoreConfidence,
      },
      policy: {
        qualificationPolicyVersion: input.policy.qualificationPolicyVersion,
      },
      entries: input.entries.map((entry) => ({
        category: entry.category,
        status: entry.status,
        detail: entry.detail,
      })),
    })
  );
}

export interface QualificationIdInput {
  readonly contractVersion: string;
  readonly userId: number;
  readonly businessId: number | null;
  readonly leadId: string;
  readonly leadIdentityVersion: string;
  readonly identityReference: string;
  readonly leadScoreId: string;
  readonly scoringVersion: string;
  readonly scoreContentHash: string;
  readonly qualificationPolicyVersion: string;
  readonly evidenceSnapshotHash: string;
  readonly engineVersion: string;
}

export function deriveQualificationId(input: QualificationIdInput): string {
  return `${QUALIFICATION_ID_PREFIX}${sha256Hex(
    canonicalJson({
      contractVersion: input.contractVersion,
      userId: input.userId,
      businessId: input.businessId,
      leadId: input.leadId,
      leadIdentityVersion: input.leadIdentityVersion,
      identityReference: input.identityReference,
      leadScoreId: input.leadScoreId,
      scoringVersion: input.scoringVersion,
      scoreContentHash: input.scoreContentHash,
      qualificationPolicyVersion: input.qualificationPolicyVersion,
      evidenceSnapshotHash: input.evidenceSnapshotHash,
      engineVersion: input.engineVersion,
    })
  )}`;
}

export interface DecisionBindingHashInput {
  readonly qualificationId: string;
  readonly decision: string;
  readonly reasonCodes: readonly string[];
  readonly identityReference: string;
  readonly scoreContentHash: string;
  readonly evidenceSnapshotHash: string;
  readonly qualificationPolicyVersion: string;
  readonly engineVersion: string;
}

export function deriveDecisionBindingHash(input: DecisionBindingHashInput): string {
  return sha256Hex(
    canonicalJson({
      qualificationId: input.qualificationId,
      decision: input.decision,
      reasonCodes: [...input.reasonCodes],
      identityReference: input.identityReference,
      scoreContentHash: input.scoreContentHash,
      evidenceSnapshotHash: input.evidenceSnapshotHash,
      qualificationPolicyVersion: input.qualificationPolicyVersion,
      engineVersion: input.engineVersion,
    })
  );
}

export interface ReviewIdInput {
  readonly userId: number;
  readonly qualificationId: string;
  readonly decisionBindingHash: string;
}

export function deriveReviewId(input: ReviewIdInput): string {
  return `${REVIEW_ID_PREFIX}${sha256Hex(
    canonicalJson({
      userId: input.userId,
      qualificationId: input.qualificationId,
      decisionBindingHash: input.decisionBindingHash,
    })
  )}`;
}

// ─── Normalized evidence (produced by the C seams in slice 2) ───

export interface NormalizedIdentityEvidence {
  readonly leadId: string;
  readonly businessId: number | null;
  readonly leadIdentityVersion: string;
  readonly identityStatus: string;
  readonly identityConfidence: string;
  readonly lastObservedAt: string;
  readonly identityReference: string;
  /** Canonical target when identityStatus === "merged"; null otherwise. */
  readonly canonicalLeadId: string | null;
}

export interface NormalizedScoreEvidence {
  readonly leadScoreId: string;
  readonly scoringVersion: string;
  readonly scoreContentHash: string;
  readonly overallScore: number;
  readonly scoreBand: ScoreBand;
  readonly scoreConfidence: ScoreConfidence;
  readonly fitScore: number;
  readonly intentScore: number;
  readonly engagementScore: number;
  readonly recencyScore: number;
  readonly opportunityScore: number;
  readonly reasonCodes: readonly string[];
  readonly latestObservedAt: string | null;
  readonly computedAt: string;
  // Cross-binding fields exposed for the service-layer tenant/ownership and
  // score↔identity consistency assertions (slice 2).
  readonly leadId: string;
  readonly businessId: number | null;
  readonly userId: number;
  readonly leadIdentityVersion: string;
}

export interface NormalizedPrivacyState {
  readonly state: string;
  readonly actionable: boolean;
  readonly blockedReason: string | null;
}

// ─── Typed error taxonomy (stable codes, fail-closed) ───

export const QUALIFICATION_ERROR_CODE_VALUES = [
  "LEAD_NOT_FOUND",
  "OWNERSHIP_MISMATCH",
  "SCORE_NOT_FOUND",
  "STALE_IDENTITY",
  "STALE_SCORE",
  "SCORE_TAMPERED",
  "UNKNOWN_SCORE_VERSION",
  "SCORE_BAND_UNKNOWN",
  "UNKNOWN_POLICY_VERSION",
  "QUALIFICATION_POLICY_UNKNOWN",
  "INVALID_POLICY",
  "POLICY_VERSION_CONFLICT",
  "QUALIFICATION_NOT_FOUND",
  "QUALIFICATION_REPLAY_CONFLICT",
  "QUALIFICATION_AUTHORITY_UNAVAILABLE",
  "FORBIDDEN_EVIDENCE",
  "IDENTITY_VERSION_UNKNOWN",
  "REVIEW_NOT_FOUND",
  "REVIEW_ALREADY_RESOLVED",
  "REVIEW_STALE_BINDING",
  "REVIEW_BINDING_INVALID",
  // Independent human-review authority (§10): resolution without a valid,
  // single-use, review-bound out-of-band challenge fails closed.
  "REVIEW_AUTHORIZATION_REQUIRED",
  "REVIEW_AUTHORIZATION_BINDING_MISMATCH",
  "INVALID_DECISION",
  "INVALID_REASON_CODE",
  "INVALID_CONFIDENCE",
  "INVALID_SCORE",
  // Slice-2 seam codes (additive): untrusted upstream payloads re-validated at
  // the C boundary fail closed with these codes.
  "INVALID_IDENTITY_PROJECTION",
  "INVALID_SCORE_PAYLOAD",
  "IDENTITY_MERGE_CHAIN_BROKEN",
  "PRIVACY_STATE_INVALID",
] as const;
export type QualificationErrorCode = (typeof QUALIFICATION_ERROR_CODE_VALUES)[number];

export class QualificationError extends Error {
  readonly code: QualificationErrorCode;
  constructor(code: QualificationErrorCode, message: string) {
    super(message);
    this.name = "QualificationError";
    this.code = code;
  }
}

/** Qualification input failed validation/bounding/ownership checks. */
export class QualificationInputError extends QualificationError {
  constructor(code: QualificationErrorCode, message: string) {
    super(code, message);
    this.name = "QualificationInputError";
  }
}

/** A value was malformed, non-finite, out of range, or forbidden. */
export class QualificationValidationError extends QualificationError {
  constructor(code: QualificationErrorCode, message: string) {
    super(code, message);
    this.name = "QualificationValidationError";
  }
}

/** Tenant/business ownership could not be proven server-side. */
export class QualificationOwnershipError extends QualificationError {
  constructor(code: QualificationErrorCode, message: string) {
    super(code, message);
    this.name = "QualificationOwnershipError";
  }
}

/** Stored content-binding hash drift — tampering. */
export class QualificationTamperError extends QualificationError {
  constructor(code: QualificationErrorCode, message: string) {
    super(code, message);
    this.name = "QualificationTamperError";
  }
}

/** Durable state conflict: replay drift, policy version conflict, review state. */
export class QualificationStateConflictError extends QualificationError {
  constructor(code: QualificationErrorCode, message: string) {
    super(code, message);
    this.name = "QualificationStateConflictError";
  }
}

// ─── Strict router-input schemas (consumed by the router in a later slice) ───
//
// z.strictObject rejects unknown keys: no client-supplied authority of any
// kind crosses the boundary (contract §14.3).

export const EvaluateQualificationInputSchema = z.strictObject({
  leadId: z.string().regex(LEAD_ID_PATTERN),
  leadScoreId: z.string().regex(LEAD_SCORE_ID_PATTERN),
  businessId: z.number().int().positive().optional(),
  policyVersion: z.string().min(1).max(96).optional(),
});
export type EvaluateQualificationInput = z.infer<typeof EvaluateQualificationInputSchema>;

export const GetQualificationInputSchema = z.strictObject({
  qualificationId: z.string().regex(QUALIFICATION_ID_PATTERN),
});
export type GetQualificationInput = z.infer<typeof GetQualificationInputSchema>;

export const ListQualificationHistoryInputSchema = z.strictObject({
  leadId: z.string().regex(LEAD_ID_PATTERN),
});
export type ListQualificationHistoryInput = z.infer<typeof ListQualificationHistoryInputSchema>;

export const ListQualificationReviewsInputSchema = z.strictObject({
  leadId: z.string().regex(LEAD_ID_PATTERN).optional(),
  status: z.enum(REVIEW_STATUS_VALUES).optional(),
});
export type ListQualificationReviewsInput = z.infer<typeof ListQualificationReviewsInputSchema>;

export const ResolveQualificationReviewInputSchema = z.strictObject({
  reviewId: z.string().regex(REVIEW_ID_PATTERN),
  outcome: z.enum(REVIEW_OUTCOME_VALUES),
  reason: z.string().min(1).max(500),
  /**
   * Independent human-review proof (§10): the challenge token issued by
   * requestReviewResolution for exactly this review, plus the 6-digit code
   * delivered out of band. A bare tenant session can never supply these —
   * the code only exists in the reviewer's mailbox.
   */
  challengeToken: z.string().min(32).max(255),
  code: z.string().regex(/^\d{6}$/),
});
export type ResolveQualificationReviewInput = z.infer<typeof ResolveQualificationReviewInputSchema>;

export const RequestReviewResolutionInputSchema = z.strictObject({
  reviewId: z.string().regex(REVIEW_ID_PATTERN),
});
export type RequestReviewResolutionInput = z.infer<typeof RequestReviewResolutionInputSchema>;

export const GetQualificationHandoffInputSchema = z.strictObject({
  qualificationId: z.string().regex(QUALIFICATION_ID_PATTERN),
});
export type GetQualificationHandoffInput = z.infer<typeof GetQualificationHandoffInputSchema>;

// ─── Strict-shape discipline (seam use, slice 2) ───

/** Rejects objects carrying keys outside the allowed closed set (fail closed). */
export function assertKnownFields(
  value: unknown,
  allowed: ReadonlySet<string>,
  code: QualificationErrorCode
): void {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new QualificationInputError(code, "expected an object with a closed field set");
  }
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) {
      throw new QualificationValidationError(code, `unknown field: ${key}`);
    }
  }
}

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

import { createHash } from "crypto";

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}
