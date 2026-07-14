import { describe, expect, it } from "vitest";
import { createMessagePackCandidate } from "../candidate";
import { createApprovedMessagePack } from "../approve";
import { evaluateMessageCandidate } from "../evaluator";
import { campaign30BusinessDna, campaign30Policy, campaign30Strategy } from "../fixtures/campaign30";

function buildCandidate() {
  return createMessagePackCandidate({
    candidateId: "cand-approve",
    campaignId: 30,
    createdAtIso: "2026-07-01T08:00:00.000Z",
    source: "ai_refined",
    copy: {
      copySchemaVersion: campaign30Policy.copySchemaVersion,
      headline: "Reduce payout delays for operations managers",
      subheadline: "Automate supplier disbursements and manual reconciliation workflows.",
      benefitBulletsOrdered: [
        "Payout automation cuts manual reconciliation by 2 hours per day.",
        "Supplier settlement tracking keeps audit records clear.",
        "Restaurant team payouts process faster with automated disbursements.",
      ],
      cta: "Learn More",
      footer: null,
    },
    businessDnaSnapshotId: campaign30BusinessDna.snapshotId,
    campaignStrategySnapshotId: campaign30Strategy.snapshotId,
    qualityPolicyId: campaign30Policy.policyId,
    qualityPolicyVersion: campaign30Policy.policyVersion,
    provenance: {
      adaptedFromLegacy: false,
      originSource: "ai_refined_pack",
      modelName: null,
      diagnostics: {
        legacyIsGeneric: null,
        legacyValidationPassed: null,
        legacyValidationScore: null,
        legacyValidationRejections: [],
      },
    },
  });
}

function buildApprovedAssessment(candidate = buildCandidate()) {
  return evaluateMessageCandidate({
    assessmentId: "assess-approve",
    evaluatedAtIso: "2026-07-01T08:01:00.000Z",
    candidate,
    businessDna: campaign30BusinessDna,
    campaignStrategy: campaign30Strategy,
    policy: campaign30Policy,
  });
}

describe("createApprovedMessagePack", () => {
  it("fails on each guard mismatch and succeeds for valid approval", () => {
    const candidate = buildCandidate();
    const approved = buildApprovedAssessment(candidate);

    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "rev-1",
        approvedAtIso: "2026-07-01T08:02:00.000Z",
        candidate: { ...candidate, candidateId: "other" },
        assessment: approved,
        policy: campaign30Policy,
      })
    ).toThrow(/Candidate ID mismatch/);

    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "rev-1",
        approvedAtIso: "2026-07-01T08:02:00.000Z",
        candidate: { ...candidate, copyHashSha256: "x" },
        assessment: approved,
        policy: campaign30Policy,
      })
    ).toThrow(/Copy hash mismatch/);

    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "rev-1",
        approvedAtIso: "2026-07-01T08:02:00.000Z",
        candidate: { ...candidate, businessDnaSnapshotId: "other" },
        assessment: approved,
        policy: campaign30Policy,
      })
    ).toThrow(/Business DNA snapshot mismatch/);

    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "rev-1",
        approvedAtIso: "2026-07-01T08:02:00.000Z",
        candidate: { ...candidate, campaignStrategySnapshotId: "other" },
        assessment: approved,
        policy: campaign30Policy,
      })
    ).toThrow(/Campaign strategy snapshot mismatch/);

    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "rev-1",
        approvedAtIso: "2026-07-01T08:02:00.000Z",
        candidate: { ...candidate, qualityPolicyId: "other" },
        assessment: approved,
        policy: campaign30Policy,
      })
    ).toThrow(/Policy ID mismatch/);

    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "rev-1",
        approvedAtIso: "2026-07-01T08:02:00.000Z",
        candidate: { ...candidate, qualityPolicyVersion: 2 },
        assessment: approved,
        policy: campaign30Policy,
      })
    ).toThrow(/Policy version mismatch/);

    const rejected = {
      ...approved,
      decision: "rejected" as const,
      hardIssues: [{ code: "X", message: "x" }],
      score: 100,
    };
    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "rev-1",
        approvedAtIso: "2026-07-01T08:02:00.000Z",
        candidate,
        assessment: rejected,
        policy: campaign30Policy,
      })
    ).toThrow(/rejected assessment/i);

    const belowThreshold = { ...approved, score: campaign30Policy.minScoreForApproval - 1 };
    expect(() =>
      createApprovedMessagePack({
        approvedRevisionId: "rev-1",
        approvedAtIso: "2026-07-01T08:02:00.000Z",
        candidate,
        assessment: belowThreshold,
        policy: campaign30Policy,
      })
    ).toThrow(/below approval threshold/i);

    const result = createApprovedMessagePack({
      approvedRevisionId: "rev-1",
      approvedAtIso: "2026-07-01T08:02:00.000Z",
      candidate,
      assessment: approved,
      policy: campaign30Policy,
    });
    expect(result.approvedRevisionId).toBe("rev-1");
  });
});
