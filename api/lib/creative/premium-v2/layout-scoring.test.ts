import { describe, it, expect } from "vitest";
import { scoreLayout } from "./layout-scoring";
import type { HybridRenderMetrics, PremiumCopyPack, VisualDirection } from "./pipeline-types";

const baseVisualDirection: VisualDirection = {
  layoutPreset: "premium_local_service",
  density: "balanced",
  heroTreatment: "solid_brand_block",
  backgroundDirection: "abstract_brand_gradient",
  backgroundPrompt: "",
  ctaTreatment: "solid_button",
  serviceLayout: "grid",
  colourUsageNote: "",
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

const baseMetrics: HybridRenderMetrics = {
  width: 1080,
  height: 1350,
  layoutPreset: "premium_local_service",
  realLogoExpected: true,
  realLogoRendered: true,
  fallbackBadgeRendered: false,
  logoMaskedOrCropped: false,
  logoRenderedHeight: 110,
  logoVisibleArea: 36740,
};

const baseContentFidelity = { contentFidelityPassed: true, inventedOfferDetected: false } as any;
const baseCopyQuality = { copyQualityPassed: true, copyQualityScore: 100, copyQualityIssues: [], cleanedVisibleText: "" };

function score(overrides: {
  visualDirection?: Partial<VisualDirection>;
  copyPack?: Partial<PremiumCopyPack>;
  metrics?: Partial<HybridRenderMetrics>;
  copyQuality?: any;
  contentFidelity?: any;
  realLogoExpected?: boolean;
}) {
  return scoreLayout({
    metrics: { ...baseMetrics, ...overrides.metrics },
    visualDirection: { ...baseVisualDirection, ...overrides.visualDirection },
    copyPack: { ...baseCopyPack, ...overrides.copyPack },
    copyQuality: overrides.copyQuality ?? baseCopyQuality,
    contentFidelity: overrides.contentFidelity ?? baseContentFidelity,
    realLogoExpected: overrides.realLogoExpected ?? true,
  });
}

describe("scoreLayout", () => {
  it("rewards a block-banner CTA and featured layout", () => {
    const s = score({ visualDirection: { ctaTreatment: "block_banner", serviceLayout: "featured", density: "minimal" } });
    expect(s.ctaDominanceScore).toBeGreaterThanOrEqual(90);
    expect(s.hierarchyScore).toBeGreaterThanOrEqual(85);
    expect(s.templateRiskScore).toBeLessThanOrEqual(30);
  });

  it("penalises a dense grid with many services", () => {
    const s = score({
      visualDirection: { serviceLayout: "grid", density: "dense" },
      copyPack: {
        services: [
          { title: "A", body: "Body A" },
          { title: "B", body: "Body B" },
          { title: "C", body: "Body C" },
        ],
      },
    });
    expect(s.templateRiskScore).toBeGreaterThanOrEqual(60);
    expect(s.layoutScore).toBeLessThan(80);
  });

  it("penalises missing real logo", () => {
    const s = score({ metrics: { realLogoRendered: false, fallbackBadgeRendered: true } });
    expect(s.brandScore).toBeLessThan(50);
  });

  it("lowers copy score when an invented offer is detected", () => {
    const s = score({ contentFidelity: { contentFidelityPassed: false, inventedOfferDetected: true } });
    expect(s.copyScore).toBeLessThan(80);
  });

  it("returns a balanced total score for a strong configuration", () => {
    const s = score({ visualDirection: { ctaTreatment: "block_banner", serviceLayout: "featured" } });
    expect(s.layoutScore).toBeGreaterThanOrEqual(80);
  });
});
