import { describe, expect, it, vi } from "vitest";

vi.mock("../creative/brief-grounding", () => ({
  buildGroundedCreativeBrief: vi.fn(({ campaign }: { campaign?: Record<string, unknown> }) => {
    const ctx = (campaign?.workflowContext as Record<string, unknown> | undefined) || {};
    // Simulate a brief change by deriving the fingerprint from a marker in
    // the mocked campaign object, otherwise return a stable current fingerprint.
    const marker = (campaign?.targetBuyer as string) || "current";
    return {
      fingerprint: `fp-${marker}`,
      productOrService: "service",
      targetBuyer: "buyer",
      mainPainPoint: "pain",
      preferredCta: "cta",
      primaryOutcome: "outcome",
      targetAudience: "audience",
      coreMessage: "message",
      offerDetails: "",
      excludedOffers: "",
      referenceStyle: "",
      contentStyle: "",
      businessType: "B2B",
    };
  }),
}));

import {
  getStrategyApprovalStatus,
  isApprovedStrategyCurrent,
  isStrategyGeneratedForCurrentBrief,
} from "./strategy-approval";

function buildCampaign(context?: Record<string, unknown>, targetBuyer?: string) {
  return {
    id: 30,
    targetBuyer: targetBuyer ?? "current",
    workflowContext: context || null,
  };
}

describe("strategy-approval fingerprint helpers", () => {
  it("reports no current approval when no approved fingerprint exists", () => {
    const campaign = buildCampaign({ strategyFingerprint: "fp-current" });
    const status = getStrategyApprovalStatus(campaign);

    expect(status.hasApprovedStrategy).toBe(false);
    expect(status.isCurrent).toBe(false);
    expect(status.strategyGeneratedForCurrentBrief).toBe(true);
  });

  it("reports current when approved fingerprint matches the current brief", () => {
    const campaign = buildCampaign({
      strategyFingerprint: "fp-current",
      approvedStrategyFingerprint: "fp-current",
    });
    const status = getStrategyApprovalStatus(campaign);

    expect(status.isCurrent).toBe(true);
    expect(status.hasApprovedStrategy).toBe(true);
    expect(status.strategyGeneratedForCurrentBrief).toBe(true);
    expect(isApprovedStrategyCurrent(campaign)).toBe(true);
  });

  it("reports stale when the campaign brief changes after approval", () => {
    const campaign = buildCampaign(
      {
        strategyFingerprint: "fp-current",
        approvedStrategyFingerprint: "fp-current",
      },
      "changed"
    );
    const status = getStrategyApprovalStatus(campaign);

    expect(status.isCurrent).toBe(false);
    expect(status.hasApprovedStrategy).toBe(true);
    expect(status.strategyGeneratedForCurrentBrief).toBe(false);
    expect(isApprovedStrategyCurrent(campaign)).toBe(false);
  });

  it("reports stale when a strategy was generated for an older brief", () => {
    const campaign = buildCampaign(
      {
        strategyFingerprint: "fp-old",
        approvedStrategyFingerprint: "fp-old",
      },
      "changed"
    );

    expect(isStrategyGeneratedForCurrentBrief(campaign)).toBe(false);
    expect(isApprovedStrategyCurrent(campaign)).toBe(false);
  });

  it("treats missing strategy fingerprint as not generated for current brief", () => {
    const campaign = buildCampaign({ approvedStrategyFingerprint: "fp-current" });

    expect(isStrategyGeneratedForCurrentBrief(campaign)).toBe(false);
  });

  it("treats empty-string fingerprints as missing", () => {
    const campaign = buildCampaign({
      strategyFingerprint: "",
      approvedStrategyFingerprint: "",
    });

    expect(isApprovedStrategyCurrent(campaign)).toBe(false);
    expect(isStrategyGeneratedForCurrentBrief(campaign)).toBe(false);
  });
});
