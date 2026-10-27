// ─── R6-C Lead Qualification — downstream handoff projection (contract §13) ───
//
// One safe projection for R6-D: ids, decision, reason codes, references,
// versions, timestamps, review state, privacy state, and the derived
// mayProgress + blocked reason. Reference-only — no PII, no raw evidence, no
// model output, no decision/authority fields a caller could forge. D consumes
// this surface and must not rewrite qualification authority.

import type {
  NormalizedPrivacyState,
  QualificationDecision,
} from "./qualification-contract";
import type {
  LeadQualificationReviewRow,
  LeadQualificationRow,
} from "./qualification-store";

/** Frozen top-level key set of the projection (asserted by the acceptance suite). */
export const QUALIFICATION_HANDOFF_PROJECTION_KEYS = [
  "qualificationId",
  "businessId",
  "leadId",
  "decision",
  "reasonCodes",
  "scoreReference",
  "evidenceSnapshotReference",
  "qualificationPolicyVersion",
  "engineVersion",
  "evaluatedAt",
  "validUntil",
  "review",
  "privacy",
  "mayProgress",
  "progressBlockedReason",
] as const;

export type QualificationProgressBlockedReason =
  | "DECISION_NOT_QUALIFIED"
  | "REVIEW_REQUIRED_PENDING"
  | "REVIEW_REJECTED"
  | "STALE_DECISION"
  | "PRIVACY_BLOCKED";

export interface QualificationHandoffProjection {
  readonly qualificationId: string;
  readonly businessId: number | null;
  readonly leadId: string;
  readonly decision: QualificationDecision;
  readonly reasonCodes: string[];
  readonly scoreReference: {
    readonly leadScoreId: string;
    readonly scoringVersion: string;
    readonly scoreContentHash: string;
  };
  readonly evidenceSnapshotReference: {
    readonly evidenceSnapshotHash: string;
  };
  readonly qualificationPolicyVersion: string;
  readonly engineVersion: string;
  readonly evaluatedAt: string;
  readonly validUntil: string;
  readonly review: {
    readonly reviewId: string;
    readonly status: string;
    readonly outcome: string | null;
    readonly reviewedAt: string | null;
  } | null;
  readonly privacy: {
    readonly state: string;
    readonly actionable: boolean;
  };
  readonly mayProgress: boolean;
  readonly progressBlockedReason: QualificationProgressBlockedReason | null;
}

function asReasonCodes(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((code): code is string => typeof code === "string");
}

/**
 * Derives the safe handoff projection for one decision row.
 *
 * mayProgress (first match wins): a non-actionable privacy state blocks
 * everything; a superseded or expired decision is stale; QUALIFIED progresses
 * on fresh, actionable evidence alone. Review resolution is historical evidence,
 * never a substitute for a new deterministic QUALIFIED decision.
 */
export function buildHandoffProjection(
  q: LeadQualificationRow,
  review: LeadQualificationReviewRow | null,
  privacy: NormalizedPrivacyState,
  isCurrentDecision: boolean,
  now: Date
): QualificationHandoffProjection {
  let mayProgress = false;
  let progressBlockedReason: QualificationProgressBlockedReason | null = null;

  if (!privacy.actionable) {
    progressBlockedReason = "PRIVACY_BLOCKED";
  } else if (!isCurrentDecision || now.getTime() > Date.parse(q.validUntil)) {
    progressBlockedReason = "STALE_DECISION";
  } else if (q.decision === "QUALIFIED") {
    mayProgress = true;
  } else if (q.decision === "REVIEW_REQUIRED") {
    progressBlockedReason = review?.status === "progression_rejected"
      ? "REVIEW_REJECTED"
      : "REVIEW_REQUIRED_PENDING";
  } else {
    progressBlockedReason = "DECISION_NOT_QUALIFIED";
  }

  return Object.freeze({
    qualificationId: q.qualificationId,
    businessId: q.businessId,
    leadId: q.leadId,
    decision: q.decision as QualificationDecision,
    reasonCodes: asReasonCodes(q.reasonCodes),
    scoreReference: Object.freeze({
      leadScoreId: q.leadScoreId,
      scoringVersion: q.scoringVersion,
      scoreContentHash: q.scoreContentHash,
    }),
    evidenceSnapshotReference: Object.freeze({
      evidenceSnapshotHash: q.evidenceSnapshotHash,
    }),
    qualificationPolicyVersion: q.qualificationPolicyVersion,
    engineVersion: q.engineVersion,
    evaluatedAt: q.evaluatedAt,
    validUntil: q.validUntil,
    review:
      review === null
        ? null
        : Object.freeze({
            reviewId: review.reviewId,
            status: review.status,
            outcome: review.status === "pending" ? null : review.status,
            reviewedAt: review.resolvedAt,
          }),
    privacy: Object.freeze({
      state: privacy.state,
      actionable: privacy.actionable,
    }),
    mayProgress,
    progressBlockedReason,
  });
}
