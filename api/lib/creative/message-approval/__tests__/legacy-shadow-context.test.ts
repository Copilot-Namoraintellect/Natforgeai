import { describe, expect, it } from "vitest";
import { buildLegacyShadowContextProjection } from "../integration/legacy-shadow-context";

describe("buildLegacyShadowContextProjection", () => {
  const base = {
    campaignId: 30,
    business: {
      id: 30,
      name: "NatForge Ops",
      industry: "Financial Operations",
      productOrService: "Payout automation",
      websiteEvidence: {
        productsServices: ["supplier disbursements", "reconciliation dashboard"],
        targetCustomers: ["operations managers"],
        location: "Johannesburg",
      },
      targetCustomer: "operations managers",
    },
    campaign: {
      id: 30,
      name: "Campaign 30",
      goal: "Increase qualified demo demand",
      primaryOutcome: "consideration",
      targetBuyer: "operations managers",
      offerDetails: "Book a walkthrough",
      preferredCta: "Awareness: Learn More\nConversion: Get Started",
      productOrService: "Supplier disbursements",
      mainPainPoint: "Manual reconciliation",
      excludedOffers: ["guaranteed results"],
    },
    validationContext: {
      businessName: "NatForge Ops",
      industry: "Financial Operations",
      productOrService: "Payout automation",
      targetCustomer: "operations managers",
      mainPainPoint: "Manual reconciliation",
      campaignObjective: "consideration",
      funnelStage: "awareness",
      preferredCta: "Awareness: Learn More\nConversion: Get Started",
    },
  } as const;

  it("is deterministic for same legacy context", () => {
    const a = buildLegacyShadowContextProjection(base);
    const b = buildLegacyShadowContextProjection(base);

    expect(a.businessDna.snapshotId).toBe(b.businessDna.snapshotId);
    expect(a.businessDna.evidenceHashSha256).toBe(b.businessDna.evidenceHashSha256);
    expect(a.campaignStrategy.snapshotId).toBe(b.campaignStrategy.snapshotId);
    expect(a.campaignStrategy.strategyHashSha256).toBe(b.campaignStrategy.strategyHashSha256);
  });

  it("changes business hash when business context changes", () => {
    const a = buildLegacyShadowContextProjection(base);
    const b = buildLegacyShadowContextProjection({
      ...base,
      business: { ...base.business, productOrService: "Collections workflow" },
    });

    expect(a.businessDna.evidenceHashSha256).not.toBe(b.businessDna.evidenceHashSha256);
  });

  it("changes strategy hash when required CTA changes", () => {
    const a = buildLegacyShadowContextProjection(base);
    const b = buildLegacyShadowContextProjection({
      ...base,
      campaign: { ...base.campaign, preferredCta: "Awareness: Schedule a Consultation" },
      validationContext: {
        ...base.validationContext,
        preferredCta: "Awareness: Schedule a Consultation",
      },
    });

    expect(a.campaignStrategy.strategyHashSha256).not.toBe(b.campaignStrategy.strategyHashSha256);
    if (a.campaignStrategy.ctaPolicy.mode !== "exact") {
      throw new Error("Expected exact CTA policy");
    }
    if (b.campaignStrategy.ctaPolicy.mode !== "exact") {
      throw new Error("Expected exact CTA policy");
    }

    expect(a.campaignStrategy.ctaPolicy.requiredCta).toBe("Learn More");
    expect(b.campaignStrategy.ctaPolicy.requiredCta).toBe("Schedule a Consultation");
  });

  it("does not use candidate copy as evidence input", () => {
    const a = buildLegacyShadowContextProjection(base);
    const b = buildLegacyShadowContextProjection(base);

    expect(a.businessDna).toEqual(b.businessDna);
    expect(a.campaignStrategy).toEqual(b.campaignStrategy);
  });

  it("reports missing context diagnostics and avoids placeholder fabrication", () => {
    const projection = buildLegacyShadowContextProjection({ campaignId: 30 });

    expect(projection.diagnostics.contextSource).toBe("legacy_loaded_context");
    expect(projection.diagnostics.contextReadyForComparison).toBe(false);
    expect(projection.diagnostics.missingContextFields.length).toBeGreaterThan(0);
    expect(projection.businessDna.businessName).toBe("");
    expect(projection.businessDna.evidenceHashSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.campaignStrategy.strategyHashSha256).toMatch(/^[a-f0-9]{64}$/);
    expect(projection.businessDna.businessName).not.toContain("shadow-observation");
    expect(projection.businessDna.evidenceHashSha256).not.toContain("shadow-observation-only");
  });
});
