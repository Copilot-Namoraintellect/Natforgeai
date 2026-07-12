import { describe, expect, it } from "vitest";
import { calculateOnboardingReadiness, isLiveOrLaterWorkflowState } from "./onboarding-readiness";

describe("onboarding readiness", () => {
  it("calculates readiness percentage from completed checkpoints", () => {
    const result = calculateOnboardingReadiness({
      websiteAnalysed: true,
      businessProfileBuilt: true,
      brandVoiceDetected: true,
      productsServicesUnderstood: true,
      campaignGoalSelected: false,
      socialChannelsConnected: false,
      audienceIntelligenceActive: false,
      firstCampaignLaunched: false,
    });

    expect(result.completedCount).toBe(4);
    expect(result.totalCount).toBe(8);
    expect(result.percentage).toBe(50);
  });

  it("detects live-or-later states", () => {
    expect(isLiveOrLaterWorkflowState("campaign_live")).toBe(true);
    expect(isLiveOrLaterWorkflowState("optimisation_active")).toBe(true);
    expect(isLiveOrLaterWorkflowState("strategy_pending")).toBe(false);
  });
});
