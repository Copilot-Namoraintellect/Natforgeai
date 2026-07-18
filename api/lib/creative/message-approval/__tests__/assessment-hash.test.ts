import { describe, expect, it } from "vitest";
import { computeAssessmentHashSha256 } from "../hash";

const baseAssessment = {
  assessmentId: "assess-1",
  candidateId: "cand-1",
  copyHashSha256: "copy-hash",
  businessDnaSnapshotId: "biz-1",
  evidenceHashSha256: "evidence-hash",
  campaignStrategySnapshotId: "strategy-1",
  strategyHashSha256: "strategy-hash",
  policyId: "policy-1",
  policyVersion: 1,
  policyHashSha256: "policy-hash",
  decision: "rejected" as const,
  hardIssues: [
    { code: "B_CODE", message: "Second issue" },
    { code: "A_CODE", message: "First issue" },
  ],
  warnings: [
    { code: "W_B", message: "Warning two" },
    { code: "W_A", message: "Warning one" },
  ],
  score: 20,
  evaluatedAtIso: "2026-07-01T08:01:00.000Z",
};

describe("computeAssessmentHashSha256", () => {
  it("is invariant to finding discovery order", () => {
    const reversed = {
      ...baseAssessment,
      hardIssues: [...baseAssessment.hardIssues].reverse(),
      warnings: [...baseAssessment.warnings].reverse(),
    };

    expect(computeAssessmentHashSha256(baseAssessment)).toBe(computeAssessmentHashSha256(reversed));
  });

  it("changes when issue code or message changes", () => {
    const changedCode = {
      ...baseAssessment,
      hardIssues: [{ ...baseAssessment.hardIssues[0], code: "Z_CODE" }, ...baseAssessment.hardIssues.slice(1)],
    };
    const changedMessage = {
      ...baseAssessment,
      hardIssues: [{ ...baseAssessment.hardIssues[0], message: "Different message" }, ...baseAssessment.hardIssues.slice(1)],
    };

    const baseHash = computeAssessmentHashSha256(baseAssessment);
    expect(baseHash).not.toBe(computeAssessmentHashSha256(changedCode));
    expect(baseHash).not.toBe(computeAssessmentHashSha256(changedMessage));
  });
});
