import { describe, expect, it } from "vitest";
import {
  assertReviewDecisionBinding,
  assertReviewResolvable,
  buildReviewForDecision,
} from "./qualification-review";
import { deriveDecisionBindingHash, deriveReviewId } from "./qualification-contract";
import type { LeadQualificationReviewRow, LeadQualificationRow } from "./qualification-store";

const H64 = "ab".repeat(32);
const G64 = "cd".repeat(32);
const E64 = "ef".repeat(32);
const F64 = "12".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const SCORE_ID = `lsc1:${H64}`;
const QUALIFICATION_ID = `lqu1:${H64}`;
const NOW = "2026-06-28T12:00:00.000Z";

function qualificationRow(overrides: Partial<LeadQualificationRow> = {}): LeadQualificationRow {
  return {
    qualificationId: QUALIFICATION_ID,
    contractVersion: "lead-qualification/v1",
    engineVersion: "lead-qualification-engine/v1",
    userId: 7,
    businessId: 3,
    leadId: LEAD_ID,
    leadIdentityVersion: "lead-identity/v1",
    identityReference: G64,
    leadScoreId: SCORE_ID,
    scoringVersion: "lead-scoring-engine/v1",
    scoreContentHash: E64,
    qualificationPolicyVersion: "lead-qualification-policy/v1",
    evidenceSnapshotHash: F64,
    evidenceSnapshot: { assembledAt: NOW, entries: [] },
    decision: "REVIEW_REQUIRED",
    reasonCodes: ["REVIEW_TRIGGERED_BY_POLICY", "CONTRADICTING_EVIDENCE"],
    confidenceScore: 6400,
    reviewRequired: true,
    evaluatedAt: NOW,
    validUntil: "2026-07-05T12:00:00.000Z",
    createdAt: NOW,
    ...overrides,
  };
}

describe("buildReviewForDecision", () => {
  it("builds a deterministic pending review bound to the exact decision", () => {
    const q = qualificationRow();
    const review = buildReviewForDecision(q);

    const expectedBinding = deriveDecisionBindingHash({
      qualificationId: q.qualificationId,
      decision: q.decision,
      reasonCodes: [...q.reasonCodes as string[]],
      identityReference: q.identityReference,
      scoreContentHash: q.scoreContentHash,
      evidenceSnapshotHash: q.evidenceSnapshotHash,
      qualificationPolicyVersion: q.qualificationPolicyVersion,
      engineVersion: q.engineVersion,
    });
    const expectedReviewId = deriveReviewId({
      userId: q.userId,
      qualificationId: q.qualificationId,
      decisionBindingHash: expectedBinding,
    });

    expect(review).toEqual({
      reviewId: expectedReviewId,
      userId: 7,
      businessId: 3,
      leadId: LEAD_ID,
      qualificationId: QUALIFICATION_ID,
      decisionBindingHash: expectedBinding,
      status: "pending",
      triggerReasonCodes: ["REVIEW_TRIGGERED_BY_POLICY", "CONTRADICTING_EVIDENCE"],
      resolvedBy: null,
      resolvedAt: null,
      resolutionReason: null,
      version: 1,
      createdAt: NOW,
      updatedAt: NOW,
    });
    expect(review.reviewId).toMatch(/^lqr1:[a-f0-9]{64}$/);
  });

  it("is deterministic for the same decision row", () => {
    const a = buildReviewForDecision(qualificationRow());
    const b = buildReviewForDecision(qualificationRow());
    expect(a).toEqual(b);
  });

  it("rejects non-REVIEW_REQUIRED decisions", () => {
    expect(() => buildReviewForDecision(qualificationRow({ decision: "QUALIFIED" }))).toThrowError(
      expect.objectContaining({ name: "QualificationValidationError", code: "INVALID_DECISION" })
    );
    expect(() => buildReviewForDecision(qualificationRow({ decision: "INSUFFICIENT_EVIDENCE" }))).toThrowError(
      expect.objectContaining({ code: "INVALID_DECISION" })
    );
  });
});

describe("assertReviewDecisionBinding", () => {
  it("accepts a review bound to the current decision", () => {
    const q = qualificationRow();
    const review = buildReviewForDecision(q);
    expect(() => assertReviewDecisionBinding(review, q)).not.toThrow();
  });

  it("rejects when the decision drifted after review creation", () => {
    const q = qualificationRow();
    const review = buildReviewForDecision(q);
    const tampered = qualificationRow({ decision: "QUALIFIED" });
    expect(() => assertReviewDecisionBinding(review, tampered)).toThrowError(
      expect.objectContaining({ name: "QualificationStateConflictError", code: "REVIEW_STALE_BINDING" })
    );
    const driftedCodes = qualificationRow({ reasonCodes: ["LOW_SCORE_CONFIDENCE"] });
    expect(() => assertReviewDecisionBinding(review, driftedCodes)).toThrowError(
      expect.objectContaining({ code: "REVIEW_STALE_BINDING" })
    );
    const driftedHash = qualificationRow({ scoreContentHash: H64 });
    expect(() => assertReviewDecisionBinding(review, driftedHash)).toThrowError(
      expect.objectContaining({ code: "REVIEW_STALE_BINDING" })
    );
  });
});

describe("assertReviewResolvable", () => {
  function reviewWith(status: string): LeadQualificationReviewRow {
    return { ...buildReviewForDecision(qualificationRow()), status };
  }

  it("allows a pending review and rejects terminal states", () => {
    expect(() => assertReviewResolvable(reviewWith("pending"))).not.toThrow();
    expect(() => assertReviewResolvable(reviewWith("progress_authorized"))).toThrowError(
      expect.objectContaining({ name: "QualificationStateConflictError", code: "REVIEW_ALREADY_RESOLVED" })
    );
    expect(() => assertReviewResolvable(reviewWith("progression_rejected"))).toThrowError(
      expect.objectContaining({ code: "REVIEW_ALREADY_RESOLVED" })
    );
  });
});
