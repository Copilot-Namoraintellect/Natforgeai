import { describe, it, expect } from "vitest";
import { evaluatePremiumDesignContract } from "./premium-design-contract";
import type { HybridRenderMetrics, PremiumCopyPack, VisualDirection } from "./pipeline-types";

const baseMetrics: HybridRenderMetrics = {
  width: 1080,
  height: 1350,
  layoutPreset: "premium_local_service",
  realLogoExpected: true,
  realLogoRendered: true,
  fallbackBadgeRendered: false,
  logoMaskedOrCropped: false,
};

const baseCopyPack: PremiumCopyPack = {
  eyebrow: "Sparkle Cleaners",
  headline: "Spotless Home, Zero Stress",
  subheadline: "Professional cleaning you can trust.",
  featuredBenefit: { title: "Home Cleaning", body: "Top to bottom cleaning" },
  services: [{ title: "Office Cleaning", body: "Clean workspaces" }],
  proofPoints: ["Reliable", "Affordable"],
  cta: "Book Now",
  footer: "Auckland",
};

const baseVisualDirection: VisualDirection = {
  layoutPreset: "premium_local_service_featured",
  density: "minimal",
  heroTreatment: "shape_accent",
  backgroundDirection: "abstract_brand_gradient",
  backgroundPrompt: "",
  ctaTreatment: "block_banner",
  serviceLayout: "featured",
  colourUsageNote: "",
};

const baseLayoutScores = {
  layoutScore: 90,
  ctaDominanceScore: 95,
  hierarchyScore: 90,
  templateRiskScore: 15,
  copyScore: 95,
  brandScore: 95,
};

function evaluate(overrides: {
  metrics?: Partial<HybridRenderMetrics>;
  copyPack?: Partial<PremiumCopyPack>;
  visualDirection?: Partial<VisualDirection>;
  layoutScores?: Partial<typeof baseLayoutScores>;
  brandFidelity?: { structuralBrandFidelityPassed: boolean; visionBrandFidelityPassed: boolean };
  effectiveCriticPassed?: boolean;
  contentFidelity?: any;
  copyQuality?: any;
  usedDeterministicFallback?: boolean;
}) {
  return evaluatePremiumDesignContract({
    metadata: {},
    metrics: { ...baseMetrics, ...overrides.metrics },
    copyPack: { ...baseCopyPack, ...overrides.copyPack },
    visualDirection: { ...baseVisualDirection, ...overrides.visualDirection },
    layoutScores: { ...baseLayoutScores, ...overrides.layoutScores },
    brandFidelity: overrides.brandFidelity ?? { structuralBrandFidelityPassed: true, visionBrandFidelityPassed: true },
    effectiveCriticPassed: overrides.effectiveCriticPassed ?? true,
    usedDeterministicFallback: overrides.usedDeterministicFallback ?? false,
    contentFidelity: overrides.contentFidelity ?? { contentFidelityPassed: true, inventedOfferDetected: false },
    copyQuality: overrides.copyQuality ?? { copyQualityPassed: true, copyQualityIssues: [] },
  });
}

describe("evaluatePremiumDesignContract", () => {
  it("passes when all gates are green", () => {
    const result = evaluate({});
    expect(result.passed).toBe(true);
    expect(result.safeToChargePremiumCredits).toBe(true);
    expect(result.needsHumanReview).toBe(false);
  });

  it("fails when the real logo is not rendered", () => {
    const result = evaluate({ metrics: { realLogoRendered: false, fallbackBadgeRendered: true } });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /real logo not rendered/i.test(i))).toBe(true);
    expect(result.safeToRetainHybrid).toBe(false);
  });

  it("fails when a fallback badge is rendered while a real logo exists", () => {
    const result = evaluate({ metrics: { fallbackBadgeRendered: true } });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /fallback badge rendered/i.test(i))).toBe(true);
    expect(result.safeToRetainHybrid).toBe(false);
  });

  it("fails and is unsafe when an invented offer is detected", () => {
    const result = evaluate({ contentFidelity: { contentFidelityPassed: false, inventedOfferDetected: true } });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /invented offer/i.test(i))).toBe(true);
    expect(result.safeToRetainHybrid).toBe(false);
  });

  it("fails but retains for review when only the effective critic fails", () => {
    const result = evaluate({ effectiveCriticPassed: false });
    expect(result.passed).toBe(false);
    expect(result.safeToRetainHybrid).toBe(true);
    expect(result.needsHumanReview).toBe(true);
  });

  it("fails when layout scores are below thresholds", () => {
    const result = evaluate({ layoutScores: { ctaDominanceScore: 50 } });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /CTA dominance/i.test(i))).toBe(true);
  });

  it("fails when a uniform generic card grid is detected", () => {
    const result = evaluate({
      visualDirection: { serviceLayout: "grid" },
      copyPack: {
        services: [
          { title: "A", body: "Body A" },
          { title: "B", body: "Body B" },
          { title: "C", body: "Body C" },
        ],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /uniform generic card grid/i.test(i))).toBe(true);
  });

  it("never passes when deterministic fallback was used", () => {
    const result = evaluate({ usedDeterministicFallback: true });
    expect(result.passed).toBe(false);
  });
});
