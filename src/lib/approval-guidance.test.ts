import { describe, expect, it } from "vitest";
import { buildApprovalGuidance } from "./approval-guidance";

describe("buildApprovalGuidance", () => {
  it("explains required decisions when approvals are pending", () => {
    const guidance = buildApprovalGuidance({
      pendingApprovals: [
        { id: 1, status: "pending", title: "Strategy Review" },
      ],
      campaigns: [],
    });

    expect(guidance.happeningNow.toLowerCase()).toContain("approval requires your review");
    expect(guidance.nextAction.toLowerCase()).toContain("approve");
  });

  it("does not imply approval wait when zero pending approvals", () => {
    const guidance = buildApprovalGuidance({
      pendingApprovals: [],
      campaigns: [],
    });

    expect(guidance.happeningNow.toLowerCase()).toContain("no approvals are required");
    expect(guidance.happeningNow.toLowerCase()).not.toContain("waiting for approval");
  });

  it("states campaign #30 is in creative generation when applicable", () => {
    const guidance = buildApprovalGuidance({
      pendingApprovals: [],
      campaigns: [{ id: 30, workflowState: "creatives_generating" }],
    });

    expect(guidance.happeningNow).toContain("Campaign #30 is currently in creative generation");
  });
});
