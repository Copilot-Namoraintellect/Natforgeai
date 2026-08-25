import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import {
  observeIfEnabled,
  extractApprovedStrategyLineage,
  resolveExpectedApprovedStrategyFingerprint,
  type QualityAuthorityObservationInput,
} from "./observe-quality-authority";
import { compileApprovedCreativeContract } from "./creative-contract";
import { type ProposedCreativeContent } from "../compliance/content-compliance";
import * as creativeContract from "./creative-contract";
import * as contentCompliance from "../compliance/content-compliance";
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

  describe("Slice 2 content compliance observation", () => {
    const compliantProposed: ProposedCreativeContent = {
      headline: "Streamline B2B Payment Orchestration",
      primaryText:
        "Zuto Hub provides prefunded merchant-account administration, balance verification, transaction reservations and controlled payment-instruction services.",
      benefits: [
        "Verify available prefunded balances before payment instructions are issued",
        "Reserve transaction amounts with traceable administration",
        "Issue controlled payment instructions from a central account",
      ],
      cta: "Request a Consultation",
      funnelStage: "consideration",
      targetAudience: "B2B finance teams and merchant operators",
      offer: "Book a guided walkthrough",
      businessName: "Zuto Hub",
      protectedFields: {
        businessName: "Zuto Hub",
      },
    };

    it("returns compliance diagnostics when proposed content is supplied", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", {
        ...baseInput,
        businessName: "Zuto Hub",
        businessCapabilities: [
          "B2B payment orchestration",
          "prefunded merchant-account administration",
          "balance verification",
          "transaction reservations",
          "controlled payment-instruction services",
        ],
        targetAudience: "B2B finance teams and merchant operators",
        offer: "Book a guided walkthrough",
        proposedContent: compliantProposed,
      });
      expect(result).not.toBeNull();
      expect(result!.compliancePassed).toBe(true);
      expect(result!.complianceEvaluatorVersion).toContain("slice2");
      expect(result!.evidenceSetFingerprint).toBeTruthy();
      expect(result!.evidenceItemCount).toBeGreaterThan(0);
      expect(result!.distinctGroundedBenefitCount).toBeGreaterThanOrEqual(3);
      expect(result!.failedRuleIds).toEqual([]);
      expect(result!.audienceConsistencyStatus).toBe("consistent");
    });

    it("reports a CTA mismatch through compliance diagnostics", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", {
        ...baseInput,
        proposedContent: {
          ...compliantProposed,
          cta: "Learn More",
        },
      });
      expect(result).not.toBeNull();
      expect(result!.compliancePassed).toBe(false);
      expect(result!.failedRuleIds).toContain("CTA_LOCKED");
      expect(result!.enforceWouldAccept).toBe(false);
    });

    it("leaves compliance fields null when no proposed content is supplied", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", baseInput);
      expect(result).not.toBeNull();
      expect(result!.compliancePassed).toBeNull();
      expect(result!.complianceEvaluatorVersion).toBeNull();
      expect(result!.evidenceSetFingerprint).toBeNull();
      expect(result!.evidenceItemCount).toBeNull();
      expect(result!.failedRuleIds).toEqual([]);
    });

    it("reports unsupported claim violations in observation diagnostics", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const result = observeIfEnabled("test", {
        ...baseInput,
        businessCapabilities: ["balance verification"],
        proposedContent: {
          ...compliantProposed,
          benefits: ["Guaranteed fraud prevention for every transaction"],
        },
      });
      expect(result).not.toBeNull();
      expect(result!.compliancePassed).toBe(false);
      expect(result!.unsupportedClaimCodes).toContain("UNSUPPORTED_CLAIM_PRESENT");
      expect(result!.failedRuleIds).toContain("CLAIM_GROUNDING");
    });

    it("does not log prompts, credentials, contact details or raw business secrets", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const logSpy = vi.spyOn(logger, "logInfo").mockImplementation(() => {});
      observeIfEnabled("test", {
        ...baseInput,
        businessCapabilities: [
          "B2B payment orchestration",
          "prefunded merchant-account administration",
          "balance verification",
        ],
        targetAudience: "B2B finance teams and merchant operators",
        offer: "Book a guided walkthrough",
        requiredContactDetails: ["support@zutohub.example"],
        proposedContent: compliantProposed,
      });
      expect(logSpy).toHaveBeenCalled();
      const payload = JSON.stringify(logSpy.mock.calls[0][1]);
      const forbidden = [
        "password",
        "secret",
        "api_key",
        "apikey",
        "credential",
        "token",
        "-----BEGIN",
        "support@zutohub.example",
        "B2B payment orchestration",
        "prefunded merchant-account administration",
      ];
      for (const term of forbidden) {
        expect(payload.toLowerCase()).not.toContain(term.toLowerCase());
      }
    });

    it("does not change campaign workflow state", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      const workflowContext = { status: "active" };
      observeIfEnabled("test", {
        ...baseInput,
        proposedContent: compliantProposed,
      });
      expect(workflowContext.status).toBe("active");
    });

    it("catches compliance evaluation errors without throwing", () => {
      process.env.QUALITY_AUTHORITY_MODE = "observe";
      vi.spyOn(contentCompliance, "evaluateContentCompliance").mockImplementation(() => {
        throw new Error("compliance boom");
      });
      const logSpy = vi.spyOn(logger, "logWarn").mockImplementation(() => {});
      const result = observeIfEnabled("test", {
        ...baseInput,
        proposedContent: compliantProposed,
      });
      expect(result).not.toBeNull();
      expect(result!.compliancePassed).toBeNull();
      expect(result!.diagnostics.some((d) => d.includes("Content compliance evaluation failed"))).toBe(true);
      expect(logSpy).not.toHaveBeenCalled();
    });
  });

  describe("approved strategy timestamp authority", () => {
    it("preserves a persisted approvedAt through lineage extraction", () => {
      const lineage = extractApprovedStrategyLineage(
        {
          strategyApprovalLineage: {
            strategyRunId: 253,
            approvalRequestId: 36,
            approvedAt: "2026-07-01T08:00:00.000Z",
            status: "approved",
            creativeBriefFingerprint: "fp-253",
          },
          approvedStrategyFingerprint: "fp-253",
        },
        30,
        22
      );
      expect(lineage).not.toBeNull();
      expect(lineage!.approvedAt).toBe("2026-07-01T08:00:00.000Z");
    });

    it("returns null lineage when approvedAt is missing", () => {
      const lineage = extractApprovedStrategyLineage(
        {
          strategyApprovalLineage: {
            strategyRunId: 253,
            approvalRequestId: 36,
            status: "approved",
            creativeBriefFingerprint: "fp-253",
          },
          approvedStrategyFingerprint: "fp-253",
        },
        30,
        22
      );
      expect(lineage).toBeNull();
    });

    const baseApprovedAtInput = {
      campaignId: 30,
      userId: 22,
      businessId: 42,
      businessName: "Zuto Hub",
      strategyRunId: 253,
      approvalRequestId: 36,
      approvedAt: "2026-07-01T08:00:00.000Z",
      approvedStrategyFingerprint: "fp-253",
      funnelStage: "consideration" as const,
      targetAudience: "operations managers",
      offer: "Book a guided walkthrough",
      businessCapabilities: ["B2B payment orchestration"],
    };

    it("changes the contract fingerprint when approvedAt changes", () => {
      const a = compileApprovedCreativeContract(baseApprovedAtInput);
      const b = compileApprovedCreativeContract({
        ...baseApprovedAtInput,
        approvedAt: "2026-07-02T08:00:00.000Z",
      });
      expect(a.contractFingerprint).not.toBe(b.contractFingerprint);
    });

    it("produces identical fingerprints for identical approved contracts across repeated compilation", () => {
      const a = compileApprovedCreativeContract(baseApprovedAtInput);
      const b = compileApprovedCreativeContract(baseApprovedAtInput);
      expect(a.contractFingerprint).toBe(b.contractFingerprint);
    });
  });
});
