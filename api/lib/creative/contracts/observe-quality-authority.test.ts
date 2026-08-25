import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  observeIfEnabled,
  extractApprovedStrategyLineage,
  resolveExpectedApprovedStrategyFingerprint,
  type QualityAuthorityObservationInput,
} from "./observe-quality-authority";
import * as creativeContract from "./creative-contract";
import * as logger from "../../logger";

const baseInput: QualityAuthorityObservationInput = {
  campaignId: 30,
  userId: 22,
  businessId: 42,
  lineage: {
    campaignId: 30,
    userId: 22,
    strategyRunId: 253,
    approvalRequestId: 36,
    approvedStrategyFingerprint: "fp-253",
    approvedAt: "2026-07-01T08:00:00.000Z",
    status: "approved",
    strategyRunStatus: "completed",
  },
  funnelStage: "consideration",
  campaignInputCta: "Request a Consultation",
  targetAudience: "operations managers",
  offer: "Book a guided walkthrough",
  businessCapabilities: ["B2B payment orchestration"],
  legacySelectedCta: "Learn More",
};

describe("observe-quality-authority", () => {
  let originalMode: string | undefined;

  beforeEach(() => {
    originalMode = process.env.QUALITY_AUTHORITY_MODE;
    vi.restoreAllMocks();
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.QUALITY_AUTHORITY_MODE;
    } else {
      process.env.QUALITY_AUTHORITY_MODE = originalMode;
    }
  });

  it("does nothing in off mode", () => {
    process.env.QUALITY_AUTHORITY_MODE = "off";
    const spy = vi.spyOn(creativeContract, "observeCreativeContract");
    const result = observeIfEnabled("test", baseInput);
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("does nothing when enforce is requested (blocked in Slice 1)", () => {
    process.env.QUALITY_AUTHORITY_MODE = "enforce";
    const spy = vi.spyOn(creativeContract, "observeCreativeContract");
    const result = observeIfEnabled("test", baseInput);
    expect(result).toBeNull();
    expect(spy).not.toHaveBeenCalled();
  });

  it("runs observation in observe mode and returns the diagnostic result", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const result = observeIfEnabled("test", baseInput);
    expect(result).not.toBeNull();
    expect(result!.contractAuthoritativeCta).toBe("Request a Consultation");
    expect(result!.legacySelectedCta).toBe("Learn More");
  });

  it("does not mutate any input array", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    const original = [...baseInput.businessCapabilities];
    observeIfEnabled("test", baseInput);
    expect(baseInput.businessCapabilities).toEqual(original);
  });

  it("does not throw when observeCreativeContract throws", () => {
    process.env.QUALITY_AUTHORITY_MODE = "observe";
    vi.spyOn(creativeContract, "observeCreativeContract").mockImplementation(() => {
      throw new Error("unexpected");
    });
    const logSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
    expect(() => observeIfEnabled("test", baseInput)).not.toThrow();
    expect(logSpy).toHaveBeenCalled();
  });

  it("extracts an approved strategy lineage from workflowContext", () => {
    const lineage = extractApprovedStrategyLineage(
      {
        strategyApprovalLineage: {
          strategyRunId: 253,
          approvalRequestId: 36,
          approvedAt: "2026-07-01T08:00:00.000Z",
          status: "approved",
          creativeBriefFingerprint: "fp-253",
        },
        approvedStrategyFingerprint: "fp-active",
      },
      30,
      22
    );
    expect(lineage).not.toBeNull();
    expect(lineage!.strategyRunId).toBe(253);
    expect(lineage!.approvedStrategyFingerprint).toBe("fp-active");
  });

  it("returns null lineage when status is not approved", () => {
    const lineage = extractApprovedStrategyLineage(
      {
        strategyApprovalLineage: {
          strategyRunId: 253,
          approvalRequestId: 36,
          status: "pending",
        },
      },
      30,
      22
    );
    expect(lineage).toBeNull();
  });

  it("resolves expected approved strategy fingerprint from workflowContext", () => {
    const fp = resolveExpectedApprovedStrategyFingerprint({
      approvedStrategyFingerprint: "fp-active",
      strategyApprovalLineage: { creativeBriefFingerprint: "fp-lineage" },
    });
    expect(fp).toBe("fp-active");
  });

  it("falls back to lineage creativeBriefFingerprint when active fingerprint is absent", () => {
    const fp = resolveExpectedApprovedStrategyFingerprint({
      strategyApprovalLineage: { creativeBriefFingerprint: "fp-lineage" },
    });
    expect(fp).toBe("fp-lineage");
  });
});
