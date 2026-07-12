import { describe, it, expect } from "vitest";
import { buildFailedCreativeMessage, groupCampaignActivity } from "./agent-activity";

describe("agent activity grouping and deduplication", () => {
  it("groups runs by campaign and keeps one active creative run with history", () => {
    const timelines = groupCampaignActivity([
      { id: 10, campaignId: 29, agentType: "strategy", status: "completed" },
      { id: 21, campaignId: 29, agentType: "creative", status: "failed", error: "network timeout" },
      { id: 22, campaignId: 29, agentType: "creative", status: "running" },
      { id: 23, campaignId: 30, agentType: "creative", status: "completed" },
    ]);

    const campaign29 = timelines.find((t) => t.campaignId === 29);
    expect(campaign29).toBeTruthy();
    expect(campaign29?.creativeRun?.id).toBe(22);
    expect(campaign29?.creativeRunHistory.length).toBe(1);
    expect(campaign29?.creativeRunHistory[0]?.id).toBe(21);
    expect(campaign29?.currentCampaignStage).toBe("Creative generation");
    expect(campaign29?.pendingWork.toLowerCase()).toContain("generating posts");
  });

  it("builds grouped ai operations timeline through audience stage", () => {
    const timelines = groupCampaignActivity([
      { id: 1, campaignId: 101, agentType: "strategy", status: "completed" },
      { id: 2, campaignId: 101, agentType: "creative", status: "completed" },
      { id: 3, campaignId: 101, agentType: "audience", status: "running" },
    ]);

    expect(timelines[0]?.currentCampaignStage).toBe("Audience intelligence");
    expect(timelines[0]?.completedSteps).toContain("Strategy Agent completed");
    expect(timelines[0]?.completedSteps).toContain("Creative Agent completed");
    expect(timelines[0]?.nextAction.toLowerCase()).toContain("audience generation");
  });

  it("returns clear credit messaging for failed creative errors", () => {
    const insufficient = buildFailedCreativeMessage("PAYMENT_REQUIRED: insufficient credits");
    expect(insufficient.creditsImpact.toLowerCase()).toContain("no credits were deducted");

    const provider = buildFailedCreativeMessage("OpenAI timeout");
    expect(provider.creditsImpact.toLowerCase()).toContain("automatically refunded");
  });
});
