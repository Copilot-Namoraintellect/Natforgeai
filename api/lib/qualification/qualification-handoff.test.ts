import { describe, expect, it } from "vitest";
import {
  buildHandoffProjection,
  QUALIFICATION_HANDOFF_PROJECTION_KEYS,
  type QualificationHandoffProjection,
} from "./qualification-handoff";
import type { LeadQualificationReviewRow, LeadQualificationRow } from "./qualification-store";
import type { NormalizedPrivacyState } from "./qualification-contract";

const H64 = "ab".repeat(32);
const G64 = "cd".repeat(32);
const E64 = "ef".repeat(32);
const F64 = "12".repeat(32);
const LEAD_ID = `lid1:${H64}`;
const SCORE_ID = `lsc1:${H64}`;
const QUALIFICATION_ID = `lqu1:${H64}`;
const REVIEW_ID = `lqr1:${H64}`;
const NOW = new Date("2026-06-28T12:00:00.000Z");
const VALID_UNTIL = "2026-07-05T12:00:00.000Z";
const EXPIRED_UNTIL = "2026-06-27T12:00:00.000Z";

const PRIVACY_ACTIONABLE: NormalizedPrivacyState = { state: "ACTIVE", actionable: true, blockedReason: null };
const PRIVACY_SUPPRESSED: NormalizedPrivacyState = {
  state: "SUPPRESSED",
  actionable: false,
  blockedReason: "PRIVACY_SUPPRESSED",
};

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
    evidenceSnapshot: { assembledAt: NOW.toISOString(), entries: [] },
    decision: "QUALIFIED",
    reasonCodes: ["POLICY_REQUIREMENTS_MET", "SCORE_BAND_SUFFICIENT"],
    confidenceScore: 10000,
    reviewRequired: false,
    evaluatedAt: NOW.toISOString(),
    validUntil: VALID_UNTIL,
    createdAt: NOW.toISOString(),
    ...overrides,
  };
}

function reviewRow(overrides: Partial<LeadQualificationReviewRow> = {}): LeadQualificationReviewRow {
  return {
    reviewId: REVIEW_ID,
    userId: 7,
    businessId: 3,
    leadId: LEAD_ID,
    qualificationId: QUALIFICATION_ID,
    decisionBindingHash: H64,
    status: "pending",
    triggerReasonCodes: ["REVIEW_TRIGGERED_BY_POLICY"],
    resolvedBy: null,
    resolvedAt: null,
    resolutionReason: null,
    pendingChallengeToken: null,
    challengeExpiresAt: null,
    version: 1,
    createdAt: NOW.toISOString(),
    updatedAt: NOW.toISOString(),
    ...overrides,
  };
}

function project(
  q: LeadQualificationRow,
  review: LeadQualificationReviewRow | null = null,
  privacy: NormalizedPrivacyState = PRIVACY_ACTIONABLE,
  isCurrentDecision = true,
  now: Date = NOW
): QualificationHandoffProjection {
  return buildHandoffProjection(q, review, privacy, isCurrentDecision, now);
}

describe("buildHandoffProjection — exact projection shape", () => {
  it("carries exactly the frozen top-level key set", () => {
    const projection = project(qualificationRow());
    expect(Object.keys(projection)).toEqual([...QUALIFICATION_HANDOFF_PROJECTION_KEYS]);
    expect(Object.keys(projection)).toHaveLength(QUALIFICATION_HANDOFF_PROJECTION_KEYS.length);
  });

  it("projects references, review and privacy without raw evidence", () => {
    const q = qualificationRow({ decision: "REVIEW_REQUIRED", reviewRequired: true });
    const projection = project(q, null);
    expect(projection).toMatchObject({
      qualificationId: QUALIFICATION_ID,
      businessId: 3,
      leadId: LEAD_ID,
      decision: "REVIEW_REQUIRED",
      reasonCodes: ["POLICY_REQUIREMENTS_MET", "SCORE_BAND_SUFFICIENT"],
      scoreReference: { leadScoreId: SCORE_ID, scoringVersion: "lead-scoring-engine/v1", scoreContentHash: E64 },
      evidenceSnapshotReference: { evidenceSnapshotHash: F64 },
      qualificationPolicyVersion: "lead-qualification-policy/v1",
      engineVersion: "lead-qualification-engine/v1",
      evaluatedAt: NOW.toISOString(),
      validUntil: VALID_UNTIL,
      review: null,
      privacy: { state: "ACTIVE", actionable: true },
      mayProgress: false,
      progressBlockedReason: "REVIEW_REQUIRED_PENDING",
    });
  });

  it("projects resolved reviews with their outcome and reviewedAt", () => {
    const q = qualificationRow({ decision: "REVIEW_REQUIRED", reviewRequired: true });
    const authorized = reviewRow({
      status: "progress_authorized",
      resolvedBy: 7,
      resolvedAt: "2026-06-29T12:00:00.000Z",
      resolutionReason: "ok",
      version: 2,
    });
    const projection = project(q, authorized);
    expect(projection.review).toEqual({
      reviewId: REVIEW_ID,
      status: "progress_authorized",
      outcome: "progress_authorized",
      reviewedAt: "2026-06-29T12:00:00.000Z",
    });
    const rejected = reviewRow({ status: "progression_rejected", resolvedBy: 7, resolvedAt: "2026-06-29T12:00:00.000Z" });
    expect(project(q, rejected).review?.outcome).toBe("progression_rejected");
  });
});

describe("buildHandoffProjection — mayProgress matrix", () => {
  it("QUALIFIED progresses when fresh, current and actionable", () => {
    const projection = project(qualificationRow());
    expect(projection.mayProgress).toBe(true);
    expect(projection.progressBlockedReason).toBeNull();
  });

  it("QUALIFIED ignores review state entirely", () => {
    const rejected = reviewRow({ status: "progression_rejected", resolvedAt: "2026-06-29T12:00:00.000Z" });
    const projection = project(qualificationRow(), rejected);
    expect(projection.mayProgress).toBe(true);
    expect(projection.progressBlockedReason).toBeNull();
  });

  it.each(["NOT_QUALIFIED", "INSUFFICIENT_EVIDENCE", "BLOCKED"] as const)(
    "decision %s never progresses with DECISION_NOT_QUALIFIED",
    (decision) => {
      // BLOCKED is superseded here by a non-actionable identity/privacy path in
      // the engine, but the projection only sees the durable decision string;
      // it maps every non-QUALIFIED/non-REVIEW_REQUIRED decision the same way.
      const projection = project(qualificationRow({ decision }));
      expect(projection.mayProgress).toBe(false);
      expect(projection.progressBlockedReason).toBe("DECISION_NOT_QUALIFIED");
    }
  );

  it("REVIEW_REQUIRED without a review stays pending", () => {
    const q = qualificationRow({ decision: "REVIEW_REQUIRED", reviewRequired: true });
    const projection = project(q, null);
    expect(projection.mayProgress).toBe(false);
    expect(projection.progressBlockedReason).toBe("REVIEW_REQUIRED_PENDING");
  });

  it("REVIEW_REQUIRED with a still-pending review does not progress", () => {
    const q = qualificationRow({ decision: "REVIEW_REQUIRED", reviewRequired: true });
    const projection = project(q, reviewRow());
    expect(projection.mayProgress).toBe(false);
    expect(projection.progressBlockedReason).toBe("REVIEW_REQUIRED_PENDING");
  });

  it("review authorization cannot substitute for a QUALIFIED decision", () => {
    const q = qualificationRow({ decision: "REVIEW_REQUIRED", reviewRequired: true });
    const authorized = project(q, reviewRow({ status: "progress_authorized", resolvedAt: "2026-06-29T12:00:00.000Z" }));
    expect(authorized.mayProgress).toBe(false);
    expect(authorized.progressBlockedReason).toBe("REVIEW_REQUIRED_PENDING");
  });

  it("REVIEW_REQUIRED stays blocked after progression_rejected", () => {
    const q = qualificationRow({ decision: "REVIEW_REQUIRED", reviewRequired: true });
    const rejected = project(q, reviewRow({ status: "progression_rejected", resolvedAt: "2026-06-29T12:00:00.000Z" }));
    expect(rejected.mayProgress).toBe(false);
    expect(rejected.progressBlockedReason).toBe("REVIEW_REJECTED");
  });

  it("an expired decision is stale even when QUALIFIED", () => {
    const q = qualificationRow({ validUntil: EXPIRED_UNTIL });
    const projection = project(q, null, PRIVACY_ACTIONABLE, true, new Date(NOW.getTime() + 1000));
    expect(projection.mayProgress).toBe(false);
    expect(projection.progressBlockedReason).toBe("STALE_DECISION");
  });

  it("a superseded decision is stale even when QUALIFIED", () => {
    const projection = project(qualificationRow(), null, PRIVACY_ACTIONABLE, false);
    expect(projection.mayProgress).toBe(false);
    expect(projection.progressBlockedReason).toBe("STALE_DECISION");
  });

  it("a non-actionable privacy state blocks everything, taking precedence", () => {
    const q = qualificationRow({ validUntil: EXPIRED_UNTIL }); // stale AND blocked
    const projection = project(q, null, PRIVACY_SUPPRESSED, false);
    expect(projection.mayProgress).toBe(false);
    expect(projection.progressBlockedReason).toBe("PRIVACY_BLOCKED");
    expect(projection.privacy).toEqual({ state: "SUPPRESSED", actionable: false });
  });

  it("expiry is evaluated against the injected clock", () => {
    const q = qualificationRow({ validUntil: VALID_UNTIL });
    expect(project(q, null, PRIVACY_ACTIONABLE, true, new Date(Date.parse(VALID_UNTIL))).mayProgress).toBe(true);
    expect(
      project(q, null, PRIVACY_ACTIONABLE, true, new Date(Date.parse(VALID_UNTIL) + 1)).progressBlockedReason
    ).toBe("STALE_DECISION");
  });
});
