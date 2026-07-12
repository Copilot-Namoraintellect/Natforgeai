import { describe, expect, it } from "vitest";
import {
  calculateOnboardingReadiness,
  isLiveOrLaterWorkflowState,
  splitReadinessChecks,
} from "./onboarding-readiness";

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

  it("splits primary and secondary readiness checks for compact UI", () => {
    const readiness = calculateOnboardingReadiness({
      websiteAnalysed: true,
      businessProfileBuilt: true,
      brandVoiceDetected: false,
      productsServicesUnderstood: false,
      campaignGoalSelected: false,
      socialChannelsConnected: false,
      audienceIntelligenceActive: false,
      firstCampaignLaunched: false,
    });

    const { primary, secondary } = splitReadinessChecks(readiness.checkpoints);

    expect(primary.length).toBe(4);
    expect(secondary.length).toBe(4);
    expect(primary.map((item) => item.label)).toEqual([
      "Website analysed",
      "Business profile built",
      "Brand voice detected",
      "Campaign goal selected",
    ]);
  });
});
