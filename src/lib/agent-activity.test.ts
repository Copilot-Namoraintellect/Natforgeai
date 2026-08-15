import { describe, it, expect } from "vitest";
import { buildFailedCreativeMessage, getCreativeRetryState, groupCampaignActivity } from "./agent-activity";

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
    expect(insufficient.creditsImpact?.toLowerCase()).toContain("no credits were deducted");

    const provider = buildFailedCreativeMessage("OpenAI timeout");
    expect(provider.creditsImpact?.toLowerCase()).toContain("automatically refunded");
  });

  it("does not assert a credit deduction for default quality validation failures", () => {
    const quality = buildFailedCreativeMessage("quality validation failed");
    expect(quality.creditsImpact).toBeUndefined();
    expect(quality.message.toLowerCase()).toContain("retry from this campaign");
  });

  it("never claims credits were deducted at generation start", () => {
    const errors = [
      "quality validation failed",
      "unknown error",
      "",
      null,
      "content generation failed",
    ];
    for (const error of errors) {
      const result = buildFailedCreativeMessage(error);
      if (result.creditsImpact) {
        expect(result.creditsImpact.toLowerCase()).not.toContain("deducted credits when generation started");
      }
    }
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

describe("getCreativeRetryState", () => {
  const noPending = { strategy: false, creative: false, audience: false, distribution: false };

  const completeCampaign = {
    id: 30,
    userId: 22,
    businessId: 26,
    name: "Campaign 30",
    workflowState: "creatives_generating",
    productOrService: "B2B payment orchestration, prefunded merchant-account administration and controlled payment-instruction services.",
    targetBuyer: "delivery platforms, restaurants, marketplaces and fintech businesses managing partner payouts",
    mainPainPoint: "Manual reconciliation and delayed settlement of partner payouts",
    preferredCta: "Book a Zuto Hub Demo",
    primaryOutcome: "Book qualified demos",
    targetAudience: "delivery platforms, restaurants, marketplaces, fintech businesses",
    coreMessage: "Pay partners in minutes without manual reconciliation",
    offerDetails: "Free reconciliation health check",
    excludedOffers: "No upfront commitment",
    referenceStyle: "Stripe-style clarity",
    contentStyle: "premium_brand_ad",
  };

  it("enables retry for a complete failed campaign with no pending mutations", () => {
    expect(getCreativeRetryState(completeCampaign, noPending)).toEqual({ enabled: true, reason: null });
  });

  it("disables retry when the brief is incomplete", () => {
    const incomplete = { ...completeCampaign, preferredCta: "" };
    expect(getCreativeRetryState(incomplete, noPending)).toEqual({ enabled: false, reason: "incomplete" });
  });

  it("disables retry when campaign details have not loaded", () => {
    expect(getCreativeRetryState(undefined, noPending)).toEqual({ enabled: false, reason: "incomplete" });
  });

  it("disables retry while any retry mutation is pending", () => {
    expect(getCreativeRetryState(completeCampaign, { ...noPending, strategy: true })).toEqual({
      enabled: false,
      reason: "pending",
    });
    expect(getCreativeRetryState(completeCampaign, { ...noPending, creative: true })).toEqual({
      enabled: false,
      reason: "pending",
    });
    expect(getCreativeRetryState(completeCampaign, { ...noPending, audience: true })).toEqual({
      enabled: false,
      reason: "pending",
    });
    expect(getCreativeRetryState(completeCampaign, { ...noPending, distribution: true })).toEqual({
      enabled: false,
      reason: "pending",
    });
  });

  it("does not weaken validation by accepting placeholder values", () => {
    const placeholderCampaign = { ...completeCampaign, preferredCta: "TBD" };
    expect(getCreativeRetryState(placeholderCampaign, noPending)).toEqual({ enabled: false, reason: "incomplete" });
  });
});
