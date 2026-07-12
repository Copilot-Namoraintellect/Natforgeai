import { describe, expect, it } from "vitest";
import { buildMissionCommandSummary } from "./mission-control";

describe("mission control next action summary", () => {
  it("returns approval-driven next action when launch approval is required", () => {
    const summary = buildMissionCommandSummary({
      campaigns: [
        {
          id: 29,
          name: "Campaign 29",
          workflowState: "launch_approval_required",
          workflowContext: { savedPosts: 6 },
        },
      ],
      approvals: [{ id: 1, campaignId: 29 }],
      runningRuns: [],
      completedRuns: [{ id: 2, campaignId: 29, agentType: "audience", status: "completed" }],
      leads: [{ id: 8, campaignId: 29, score: 85 }],
      queue: [
        { id: 1, campaignId: 29, status: "approved" },
        { id: 2, campaignId: 29, status: "published" },
      ],
    });

    expect(summary.activeCampaignId).toBe(29);
    expect(summary.nextRecommendedAction.toLowerCase()).toContain("approve");
    expect(summary.contentReadiness.toLowerCase()).toContain("generated");
  });
});
