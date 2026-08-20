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
  validateStrategyRunForCampaign,
} from "./strategy-approval";

function buildCampaign(
  context?: Record<string, unknown>,
  targetBuyer?: string,
  workflowState?: string
) {
  return {
    id: 30,
    targetBuyer: targetBuyer ?? "current",
    workflowState: workflowState ?? "audience_ready",
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

  it("reports current when approved fingerprint and lineage match the current brief", () => {
    const campaign = buildCampaign({
      strategyFingerprint: "fp-current",
      approvedStrategyFingerprint: "fp-current",
      strategyApprovalLineage: {
        creativeBriefFingerprint: "fp-current",
        strategyRunId: 1,
        approvalRequestId: 33,
        status: "approved",
      },
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
        strategyApprovalLineage: {
          creativeBriefFingerprint: "fp-current",
          strategyRunId: 1,
          approvalRequestId: 33,
          status: "approved",
        },
      },
      "changed"
    );
    const status = getStrategyApprovalStatus(campaign);

    expect(status.isCurrent).toBe(false);
    expect(status.hasApprovedStrategy).toBe(false);
    expect(status.strategyGeneratedForCurrentBrief).toBe(false);
    expect(isApprovedStrategyCurrent(campaign)).toBe(false);
  });

  it("reports stale when a strategy was generated for an older brief", () => {
    const campaign = buildCampaign(
      {
        strategyFingerprint: "fp-old",
        approvedStrategyFingerprint: "fp-old",
        strategyApprovalLineage: {
          creativeBriefFingerprint: "fp-old",
          strategyRunId: 1,
          approvalRequestId: 33,
          status: "approved",
        },
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

  it("treats a legacy approved strategy without fingerprint/lineage as stale, not current", () => {
    // Production-shaped regression case: an older strategy_review approval exists
    // but the campaign has no creativeBriefFingerprint, approvedStrategyFingerprint,
    // or strategyApprovalLineage evidence. This must fail closed as stale.
    const campaign = buildCampaign(
      {
        // No strategyFingerprint, approvedStrategyFingerprint, or lineage.
      },
      "current",
      "audience_ready"
    );
    const status = getStrategyApprovalStatus(campaign);

    expect(status.isCurrent).toBe(false);
    expect(status.hasApprovedStrategy).toBe(false);
    expect(status.strategyGeneratedForCurrentBrief).toBe(false);
    expect(status.lineage).toBeNull();
    expect(isApprovedStrategyCurrent(campaign)).toBe(false);
  });

  it("treats matching approved fingerprint without lineage as stale", () => {
    const campaign = buildCampaign({
      strategyFingerprint: "fp-current",
      approvedStrategyFingerprint: "fp-current",
      // strategyApprovalLineage intentionally missing
    });
    const status = getStrategyApprovalStatus(campaign);

    expect(status.isCurrent).toBe(false);
    expect(status.hasApprovedStrategy).toBe(false);
    expect(isApprovedStrategyCurrent(campaign)).toBe(false);
  });

  it("treats non-approved lineage as stale even when fingerprints match", () => {
    const campaign = buildCampaign({
      strategyFingerprint: "fp-current",
      approvedStrategyFingerprint: "fp-current",
      strategyApprovalLineage: {
        creativeBriefFingerprint: "fp-current",
        strategyRunId: 1,
        approvalRequestId: 33,
        status: "pending",
      },
    });
    const status = getStrategyApprovalStatus(campaign);

    expect(status.isCurrent).toBe(false);
    expect(status.hasApprovedStrategy).toBe(false);
    expect(isApprovedStrategyCurrent(campaign)).toBe(false);
  });
});

describe("validateStrategyRunForCampaign", () => {
  it("rejects a failed evidence-envelope row", async () => {
    const campaign = buildCampaign(
      {
        strategyFingerprint: "fp-current",
        approvedStrategyFingerprint: "fp-current",
        strategyApprovalLineage: {
          creativeBriefFingerprint: "fp-current",
          strategyRunId: 249,
          approvalRequestId: 34,
          status: "approved",
        },
      },
      "current",
      "audience_ready"
    );

    const failedEnvelopeRow = {
      status: "failed",
      output: {
        evidenceVersion: 1,
        outcome: "failed_validation",
        creativeBriefFingerprint: "fp-current",
        rawOutput: {},
        groundedOutput: {},
        validationDiagnostics: { gate: "main pain point" },
      },
    };

    const result = await validateStrategyRunForCampaign(campaign, 1, failedEnvelopeRow);
    expect(result.valid).toBe(false);
    expect(result.reason).toMatch(/missing or not completed/i);
  });

  it("rejects a completed row whose output is an evidence envelope", async () => {
    const campaign = buildCampaign(
      {
        strategyFingerprint: "fp-current",
        approvedStrategyFingerprint: "fp-current",
        strategyApprovalLineage: {
          creativeBriefFingerprint: "fp-current",
          strategyRunId: 249,
          approvalRequestId: 34,
          status: "approved",
        },
      },
      "current",
      "audience_ready"
    );

    const completedEnvelopeRow = {
      status: "completed",
      output: {
        evidenceVersion: 1,
        outcome: "failed_validation",
        creativeBriefFingerprint: "fp-current",
        rawOutput: {},
        groundedOutput: {},
        validationDiagnostics: { gate: "main pain point" },
      },
    };

    const result = await validateStrategyRunForCampaign(campaign, 1, completedEnvelopeRow);
    expect(result.valid).toBe(false);
    expect(result.reason).toBeDefined();
  });
});
