// ─── R6-C Lead Qualification — governed manual review (contract §10) ───
//
// A REVIEW_REQUIRED decision gets exactly one durable review record, bound to
// the exact decision via decisionBindingHash = sha256(canonicalJson(
// {qualificationId, decision, reasonCodes, identityReference, scoreContentHash,
// evidenceSnapshotHash, qualificationPolicyVersion, engineVersion})). The
// review never mutates the immutable decision; resolution authorizes or
// rejects progression of this exact decision only. A decision that drifts
// after review creation (tamper, supersede) breaks the binding and the review
// can no longer be resolved against it.

import {
  deriveDecisionBindingHash,
  deriveReviewId,
  QualificationStateConflictError,
  QualificationValidationError,
} from "./qualification-contract";
import type { LeadQualificationRow, LeadQualificationReviewRow } from "./qualification-store";

/** Domain review shape = the durable review row (contract §10). */
export type LeadQualificationReview = LeadQualificationReviewRow;

function asReasonCodes(value: unknown): string[] {
  if (!Array.isArray(value) || value.some((code) => typeof code !== "string")) {
    throw new QualificationValidationError(
      "INVALID_REASON_CODE",
      "review binding requires a stored string[] reason-code list"
    );
  }
  return [...value];
}

/**
 * Builds the pending-review draft for a REVIEW_REQUIRED decision. Deterministic:
 * same decision row ⇒ same binding hash ⇒ same reviewId (exactly one review
 * per decision).
 */
export function buildReviewForDecision(q: LeadQualificationRow): LeadQualificationReviewRow {
  if (q.decision !== "REVIEW_REQUIRED") {
    throw new QualificationValidationError(
      "INVALID_DECISION",
      `only REVIEW_REQUIRED decisions create reviews; got ${q.decision}`
    );
  }
  const reasonCodes = asReasonCodes(q.reasonCodes);
  const decisionBindingHash = deriveDecisionBindingHash({
    qualificationId: q.qualificationId,
    decision: q.decision,
    reasonCodes,
    identityReference: q.identityReference,
    scoreContentHash: q.scoreContentHash,
    evidenceSnapshotHash: q.evidenceSnapshotHash,
    qualificationPolicyVersion: q.qualificationPolicyVersion,
    engineVersion: q.engineVersion,
  });
  const reviewId = deriveReviewId({
    userId: q.userId,
    qualificationId: q.qualificationId,
    decisionBindingHash,
  });
  return Object.freeze({
    reviewId,
    userId: q.userId,
    businessId: q.businessId,
    leadId: q.leadId,
    qualificationId: q.qualificationId,
    decisionBindingHash,
    status: "pending",
    triggerReasonCodes: Object.freeze(reasonCodes),
    resolvedBy: null,
    resolvedAt: null,
    resolutionReason: null,
    pendingChallengeToken: null,
    challengeExpiresAt: null,
    version: 1,
    createdAt: q.evaluatedAt,
    updatedAt: q.evaluatedAt,
  });
}

/**
 * Recomputes the decision binding from the (current) qualification row and
 * compares it to the review's stored binding. Any drift — the decision row
 * was superseded or tampered after the review was created — fails closed:
 * the review can no longer authorize progression.
 */
export function assertReviewDecisionBinding(
  review: LeadQualificationReviewRow,
  q: LeadQualificationRow
): void {
  const expected = deriveDecisionBindingHash({
    qualificationId: q.qualificationId,
    decision: q.decision,
    reasonCodes: asReasonCodes(q.reasonCodes),
    identityReference: q.identityReference,
    scoreContentHash: q.scoreContentHash,
    evidenceSnapshotHash: q.evidenceSnapshotHash,
    qualificationPolicyVersion: q.qualificationPolicyVersion,
    engineVersion: q.engineVersion,
  });
  if (expected !== review.decisionBindingHash) {
    throw new QualificationStateConflictError(
      "REVIEW_STALE_BINDING",
      `review ${review.reviewId} is bound to a different decision content; the qualification drifted and the review is stale.`
    );
  }
}

/** Exactly one resolution per review: anything not pending is terminal. */
export function assertReviewResolvable(review: LeadQualificationReviewRow): void {
  if (review.status !== "pending") {
    throw new QualificationStateConflictError(
      "REVIEW_ALREADY_RESOLVED",
      `review ${review.reviewId} is already resolved with status ${review.status}`
    );
  }
}
