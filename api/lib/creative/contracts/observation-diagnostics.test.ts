import { describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  getQualityAuthorityMode,
  observeCreativeContract,
  type ApprovedStrategyLineage,
  type ObservationDiagnostics,
} from "./creative-contract";

const campaign30Lineage: ApprovedStrategyLineage = {
  campaignId: 30,
  userId: 22,
  strategyRunId: 253,
  approvalRequestId: 36,
  approvedStrategyFingerprint: "approved-fingerprint-campaign30",
  approvedAt: "2026-07-01T08:00:00.000Z",
  status: "approved",
  strategyRunStatus: "completed",
};

function baseObservationInput() {
  return {
    mode: "observe" as const,
    campaignId: 30,
    userId: 22,
    businessId: 42,
    lineage: campaign30Lineage,
    funnelStage: "consideration" as const,
    campaignInputCta: "Request a Consultation",
    targetAudience: "operations managers",
    offer: "Book a guided walkthrough",
    businessCapabilities: ["B2B payment orchestration", "balance verification"],
    legacySelectedCta: "Learn More",
  };
}

describe("observation-diagnostics", () => {
  let originalMode: string | undefined;

  beforeEach(() => {
    originalMode = process.env.QUALITY_AUTHORITY_MODE;
  });

  afterEach(() => {
    if (originalMode === undefined) {
      delete process.env.QUALITY_AUTHORITY_MODE;
    } else {
      process.env.QUALITY_AUTHORITY_MODE = originalMode;
    }
  });

  it("returns the complete required diagnostics shape", () => {
    const observation = observeCreativeContract(baseObservationInput());
    expect(observation).not.toBeNull();

    const requiredKeys: (keyof ObservationDiagnostics)[] = [
      "campaignId",
      "userId",
      "strategyRunId",
      "approvalRequestId",
      "contractVersion",
      "contractFingerprint",
      "legacySelectedCta",
      "contractAuthoritativeCta",
      "ctaAuthoritySource",
      "ctaLocked",
      "mismatchClassification",
      "enforceWouldAccept",
      "enforceWouldRejectReason",
      "diagnostics",
    ];
    for (const key of requiredKeys) {
      expect(observation).toHaveProperty(key);
    }
  });

  it("emits a configuration warning for an unknown mode without throwing", () => {
    process.env.QUALITY_AUTHORITY_MODE = "enforce-now";
    expect(() => getQualityAuthorityMode()).not.toThrow();
    const result = getQualityAuthorityMode();
    expect(result.effectiveMode).toBe("off");
    expect(result.requestedMode).toBe("enforce-now");
    expect(result.blocked).toBe(false);
    expect(result.warning).toContain("enforce-now");
  });

  it("does not mutate the input business capabilities array", () => {
    const input = baseObservationInput();
    const original = [...input.businessCapabilities];
    observeCreativeContract(input);
    expect(input.businessCapabilities).toEqual(original);
  });

  it("survives internal errors and returns a graceful failure diagnostic", () => {
    const observation = observeCreativeContract({
      ...baseObservationInput(),
      // Force an invalid lineage object that the authority check will reject.
      lineage: { status: "rejected" } as any,
    });

    expect(observation).not.toBeNull();
    expect(observation!.enforceWouldAccept).toBe(false);
    expect(observation!.mismatchClassification).toBe("unapproved_strategy");
  });

  it("produces consistent contract fingerprints across repeated observations", () => {
    const a = observeCreativeContract(baseObservationInput());
    const b = observeCreativeContract(baseObservationInput());
    expect(a!.contractFingerprint).toBe(b!.contractFingerprint);
  });

  it("classifies approved CTA override when legacy differs from locked CTA", () => {
    const observation = observeCreativeContract({
      ...baseObservationInput(),
      stageCtas: { consideration: "Request a Consultation" },
      legacySelectedCta: "Book a Demo",
    });

    expect(observation!.ctaAuthoritySource).toBe("strategy_stage");
    expect(observation!.ctaLocked).toBe(true);
    expect(observation!.mismatchClassification).toBe("approved_cta_overridden");
    expect(observation!.enforceWouldAccept).toBe(false);
  });

  it("classifies fallback used while an approved campaign-input CTA exists", () => {
    const observation = observeCreativeContract({
      ...baseObservationInput(),
      legacySelectedCta: "Learn More",
    });

    expect(observation!.contractAuthoritativeCta).toBe("Request a Consultation");
    expect(observation!.mismatchClassification).toBe(
      "fallback_used_while_approved_exists"
    );
  });

  it("classifies ambiguous source when multiple approved CTAs conflict", () => {
    const observation = observeCreativeContract({
      ...baseObservationInput(),
      stageCtas: { consideration: "Request a Consultation" },
      campaignInputCta: "Book a Demo",
      legacySelectedCta: "Book a Demo",
    });

    expect(observation!.mismatchClassification).toBe("approved_cta_overridden");
    expect(observation!.diagnostics.some((d) => d.includes("Ambiguous CTA authority"))).toBe(true);
  });

  it("reports unapproved strategy when lineage status is not approved", () => {
    const observation = observeCreativeContract({
      ...baseObservationInput(),
      lineage: { ...campaign30Lineage, status: "pending" as any },
      legacySelectedCta: "Request a Consultation",
    });

    expect(observation!.mismatchClassification).toBe("unapproved_strategy");
    expect(observation!.enforceWouldAccept).toBe(false);
  });

  it("reports invalid approved CTA when observation itself errors", () => {
    const observation = observeCreativeContract({
      ...baseObservationInput(),
      // Intentionally corrupt lineage with incompatible types to exercise catch path.
      lineage: {
        ...campaign30Lineage,
        approvedAt: { toISOString: () => "bad" } as any,
      },
    });

    expect(observation).not.toBeNull();
    expect(observation!.enforceWouldAccept).toBe(false);
  });

  it("never enables enforce mode from getQualityAuthorityMode in Slice 1", () => {
    process.env.QUALITY_AUTHORITY_MODE = "enforce";
    const result = getQualityAuthorityMode();
    expect(result.requestedMode).toBe("enforce");
    expect(result.effectiveMode).toBe("off");
    expect(result.blocked).toBe(true);
    expect(result.reason).toBe("QUALITY_AUTHORITY_ENFORCEMENT_NOT_AVAILABLE");
    expect(result.warning).toContain("blocked");
  });

  it("distinguishes blocked enforce mode from an invalid value", () => {
    process.env.QUALITY_AUTHORITY_MODE = "banana";
    const invalid = getQualityAuthorityMode();
    expect(invalid.requestedMode).toBe("banana");
    expect(invalid.effectiveMode).toBe("off");
    expect(invalid.blocked).toBe(false);
    expect(invalid.reason).toBeNull();
    expect(invalid.warning).toContain("Unknown");

    process.env.QUALITY_AUTHORITY_MODE = "enforce";
    const blocked = getQualityAuthorityMode();
    expect(blocked.requestedMode).toBe("enforce");
    expect(blocked.blocked).toBe(true);
    expect(blocked.reason).toBe("QUALITY_AUTHORITY_ENFORCEMENT_NOT_AVAILABLE");
    expect(blocked.warning).toContain("blocked");
  });
});
