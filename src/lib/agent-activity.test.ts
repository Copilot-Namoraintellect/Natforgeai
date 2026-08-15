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

  it("selects failed controlling creative run over later completed inner runs", () => {
    const timelines = groupCampaignActivity([
      { id: 10, campaignId: 30, agentType: "strategy", status: "completed" },
      {
        id: 231,
        campaignId: 30,
        agentType: "creative",
        status: "failed",
        error: "quality validation failed",
        input: { jobType: "content_generation_job" },
      },
      { id: 233, campaignId: 30, agentType: "creative", status: "completed", input: { prompt: "inner" } },
      { id: 234, campaignId: 30, agentType: "creative", status: "completed", input: { prompt: "inner" } },
    ]);

    const campaign30 = timelines.find((t) => t.campaignId === 30);
    expect(campaign30?.creativeRun?.id).toBe(231);
    expect(campaign30?.creativeRunHistory.map((r) => r.id)).toEqual([234, 233]);
    expect(campaign30?.currentStatus).toBe("failed");
    expect(campaign30?.currentCampaignStage).toBe("Creative generation");
    expect(campaign30?.nextAction.toLowerCase()).toContain("retry");
  });

  it("shows Creative review when controlling creative run completed with saved posts", () => {
    const timelines = groupCampaignActivity([
      { id: 1, campaignId: 31, agentType: "strategy", status: "completed" },
      {
        id: 2,
        campaignId: 31,
        agentType: "creative",
        status: "completed",
        input: { jobType: "content_generation_job" },
        output: { savedPosts: 3 },
      },
    ]);

    const campaign31 = timelines.find((t) => t.campaignId === 31);
    expect(campaign31?.currentStatus).toBe("completed");
    expect(campaign31?.currentCampaignStage).toBe("Creative review");
    expect(campaign31?.completedSteps).toContain("Creative Agent completed");
  });

  it("treats completed controlling run with zero saved posts as failed/retryable", () => {
    const timelines = groupCampaignActivity([
      { id: 1, campaignId: 32, agentType: "strategy", status: "completed" },
      {
        id: 2,
        campaignId: 32,
        agentType: "creative",
        status: "completed",
        input: { jobType: "content_generation_job" },
        output: { savedPosts: 0 },
      },
    ]);

    const campaign32 = timelines.find((t) => t.campaignId === 32);
    expect(campaign32?.currentStatus).toBe("failed");
    expect(campaign32?.currentCampaignStage).toBe("Creative generation");
    expect(campaign32?.nextAction.toLowerCase()).toContain("retry");
    expect(campaign32?.errorMessage).toBeTruthy();
    expect(campaign32?.completedSteps).not.toContain("Creative Agent completed");
  });

  it("lets a newer completed controlling run supersede an older failed controlling run", () => {
    const timelines = groupCampaignActivity([
      { id: 1, campaignId: 33, agentType: "strategy", status: "completed" },
      {
        id: 100,
        campaignId: 33,
        agentType: "creative",
        status: "failed",
        error: "old failure",
        input: { jobType: "content_generation_job" },
      },
      {
        id: 200,
        campaignId: 33,
        agentType: "creative",
        status: "completed",
        input: { jobType: "content_generation_job" },
        output: { savedPosts: 2 },
      },
    ]);

    const campaign33 = timelines.find((t) => t.campaignId === 33);
    expect(campaign33?.creativeRun?.id).toBe(200);
    expect(campaign33?.creativeRunHistory.map((r) => r.id)).toEqual([100]);
    expect(campaign33?.currentStatus).toBe("completed");
    expect(campaign33?.currentCampaignStage).toBe("Creative review");
  });

  it("falls back to latest creative run when no controlling operation exists", () => {
    const timelines = groupCampaignActivity([
      { id: 1, campaignId: 34, agentType: "strategy", status: "completed" },
      { id: 50, campaignId: 34, agentType: "creative", status: "failed", error: "legacy failure" },
      { id: 60, campaignId: 34, agentType: "creative", status: "completed" },
    ]);

    const campaign34 = timelines.find((t) => t.campaignId === 34);
    expect(campaign34?.creativeRun?.id).toBe(60);
    expect(campaign34?.creativeRunHistory.map((r) => r.id)).toEqual([50]);
    expect(campaign34?.currentStatus).toBe("completed");
    expect(campaign34?.currentCampaignStage).toBe("Creative review");
  });

  it("keeps non-controlling creative runs in history", () => {
    const timelines = groupCampaignActivity([
      {
        id: 231,
        campaignId: 30,
        agentType: "creative",
        status: "failed",
        input: { jobType: "content_generation_job" },
      },
      { id: 233, campaignId: 30, agentType: "creative", status: "completed", input: { prompt: "inner" } },
    ]);

    const campaign30 = timelines.find((t) => t.campaignId === 30);
    expect(campaign30?.creativeRun?.id).toBe(231);
    expect(campaign30?.creativeRunHistory.some((r) => r.id === 233)).toBe(true);
  });
});
