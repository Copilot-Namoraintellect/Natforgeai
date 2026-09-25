import { describe, expect, it, vi, beforeEach } from "vitest";
import { TRPCError } from "@trpc/server";

vi.mock("../workflow/strategy-approval", () => ({
  assertApprovedStrategySemanticallyValid: vi.fn(async () => undefined),
  getStrategyApprovalStatus: vi.fn(() => ({
    currentFingerprint: "brief-fingerprint-001",
    strategyFingerprint: "brief-fingerprint-001",
    approvedStrategyFingerprint: "brief-fingerprint-001",
    isCurrent: true,
    hasApprovedStrategy: true,
    strategyGeneratedForCurrentBrief: true,
    lineage: {
      creativeBriefFingerprint: "brief-fingerprint-001",
      strategyRunId: 501,
      approvalRequestId: 77,
      status: "approved",
      strategySnapshotId: "strategy-snapshot-501",
      strategyVersion: 3,
      businessDnaSnapshotId: "bdna-snapshot-9",
      strategyHashSha256: "a".repeat(64),
    },
  })),
}));

vi.mock("./strategy-snapshot-input", () => ({
  resolveImmutableCreativeStrategyInput: vi.fn(),
}));

import { assertApprovedStrategySemanticallyValid } from "../workflow/strategy-approval";
import { resolveImmutableCreativeStrategyInput } from "./strategy-snapshot-input";
import { resolveCreativeEntryStrategyAuthority } from "./creative-entry-authority";

const immutableStrategyInput = Object.freeze({
  authority: Object.freeze({
    strategySnapshotId: "strategy-snapshot-501",
    strategyVersion: 3,
    businessDnaSnapshotId: "bdna-snapshot-9",
    strategyHashSha256: "a".repeat(64),
    strategyRunId: 501,
    approvalRequestId: 77,
    creativeBriefFingerprint: "brief-fingerprint-001",
  }),
  snapshot: Object.freeze({
    coreMessage: "Immutable core message",
  }),
  creativeContext: Object.freeze({
    coreMessage: "Immutable core message",
    valueProposition: "Immutable value proposition",
    positioning: null,
    campaignTheme: null,
    personas: Object.freeze([{ name: "Immutable buyer" }]),
  }),
});

function buildCampaign(overrides: Record<string, unknown> = {}) {
  return {
    id: 30,
    userId: 18,
    businessId: 24,
    // Mutable Strategy projections that must never be consulted as authority.
    coreMessage: "Mutable campaign core message",
    personas: [{ name: "Mutable persona" }],
    workflowContext: {
      strategyApprovalLineage: {
        creativeBriefFingerprint: "brief-fingerprint-001",
        strategyRunId: 501,
        approvalRequestId: 77,
        status: "approved",
        strategySnapshotId: "strategy-snapshot-501",
        strategyVersion: 3,
        businessDnaSnapshotId: "bdna-snapshot-9",
        strategyHashSha256: "a".repeat(64),
      },
    },
    ...overrides,
  };
}

describe("resolveCreativeEntryStrategyAuthority", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(resolveImmutableCreativeStrategyInput).mockResolvedValue(
      immutableStrategyInput as any
    );
  });

  it("runs the governed authority chain in order and returns the resolver result unchanged", async () => {
    const campaign = buildCampaign();

    const result = await resolveCreativeEntryStrategyAuthority({
      campaign,
      userId: 18,
      campaignId: 30,
    });

    expect(assertApprovedStrategySemanticallyValid).toHaveBeenCalledTimes(1);
    expect(assertApprovedStrategySemanticallyValid).toHaveBeenCalledWith(
      campaign,
      18,
      undefined
    );
    expect(resolveImmutableCreativeStrategyInput).toHaveBeenCalledTimes(1);

    const assertOrder = vi.mocked(assertApprovedStrategySemanticallyValid).mock
      .invocationCallOrder[0];
    const resolveOrder = vi.mocked(resolveImmutableCreativeStrategyInput).mock
      .invocationCallOrder[0];
    expect(assertOrder).toBeLessThan(resolveOrder);

    // The exact immutable snapshot input is passed through unchanged.
    expect(result).toBe(immutableStrategyInput);
  });

  it("captures the exact approved Strategy authority coordinates for the resolver", async () => {
    await resolveCreativeEntryStrategyAuthority({
      campaign: buildCampaign(),
      userId: 18,
      campaignId: 30,
    });

    expect(resolveImmutableCreativeStrategyInput).toHaveBeenCalledWith({
      authority: {
        strategySnapshotId: "strategy-snapshot-501",
        strategyVersion: 3,
        businessDnaSnapshotId: "bdna-snapshot-9",
        strategyHashSha256: "a".repeat(64),
        strategyRunId: 501,
        approvalRequestId: 77,
        creativeBriefFingerprint: "brief-fingerprint-001",
      },
      userId: 18,
      campaignId: 30,
      businessId: 24,
    });
  });

  it("forwards the linked business to the semantic assertion when provided", async () => {
    const campaign = buildCampaign();
    const business = { id: 24, name: "Test Business" };

    await resolveCreativeEntryStrategyAuthority({
      campaign,
      userId: 18,
      campaignId: 30,
      business,
    });

    expect(assertApprovedStrategySemanticallyValid).toHaveBeenCalledWith(
      campaign,
      18,
      business
    );
  });

  it("fails closed when the approved Strategy is stale or changed", async () => {
    vi.mocked(assertApprovedStrategySemanticallyValid).mockRejectedValueOnce(
      new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "The approved strategy is stale or missing. Regenerate the strategy for approval before creating content.",
      })
    );

    await expect(
      resolveCreativeEntryStrategyAuthority({
        campaign: buildCampaign(),
        userId: 18,
        campaignId: 30,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });

    expect(resolveImmutableCreativeStrategyInput).not.toHaveBeenCalled();
  });

  it("fails closed when the immutable Strategy snapshot is missing", async () => {
    vi.mocked(resolveImmutableCreativeStrategyInput).mockRejectedValueOnce(
      new TRPCError({
        code: "PRECONDITION_FAILED",
        message:
          "Immutable Strategy snapshot authority failed (snapshot missing). Regenerate and approve the Strategy before creating content.",
      })
    );

    await expect(
      resolveCreativeEntryStrategyAuthority({
        campaign: buildCampaign(),
        userId: 18,
        campaignId: 30,
      })
    ).rejects.toMatchObject({ code: "PRECONDITION_FAILED" });
  });

  it("fails closed when the campaign is not linked to a business", async () => {
    await expect(
      resolveCreativeEntryStrategyAuthority({
        campaign: buildCampaign({ businessId: null }),
        userId: 18,
        campaignId: 30,
      })
    ).rejects.toMatchObject({ code: "BAD_REQUEST" });

    expect(resolveImmutableCreativeStrategyInput).not.toHaveBeenCalled();
  });

  it("never falls back to mutable campaign Strategy fields", async () => {
    const campaign = buildCampaign({
      coreMessage: "Tampered mutable message",
      personas: [{ name: "Tampered persona" }],
    });

    const result = await resolveCreativeEntryStrategyAuthority({
      campaign,
      userId: 18,
      campaignId: 30,
    });

    // The resolved input is exactly the immutable snapshot product; mutable
    // campaign projections never contribute.
    expect(result).toBe(immutableStrategyInput);
    expect(result.creativeContext.coreMessage).toBe("Immutable core message");
    expect(result.creativeContext.personas).toEqual([
      { name: "Immutable buyer" },
    ]);
  });
});
