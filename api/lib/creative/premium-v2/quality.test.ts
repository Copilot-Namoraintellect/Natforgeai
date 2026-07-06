import { describe, it, expect } from "vitest";
import { validatePremiumV2Quality, assertV2LayoutGuarantees } from "./quality";
import type { PremiumLeafletV2Brief } from "./types";

function makeBrief(overrides: Partial<PremiumLeafletV2Brief> = {}): PremiumLeafletV2Brief {
  return {
    businessName: "Test Biz",
    businessCategory: "local_services",
    headline: "Professional service you can trust",
    subheadline: "We help homeowners fix urgent problems fast.",
    primaryServices: [{ name: "Service A", isPrimary: true }, { name: "Service B", isPrimary: true }],
    secondaryServices: [],
    benefits: ["Fast", "Reliable", "Affordable"],
    cta: "Call Us Today",
    contact: { phone: "123", website: "https://test.test" },
    visualStyle: "modern",
    layoutDensity: "premium_services",
    brandPalette: {
      primary: "#000",
      secondary: "#333",
      accent: "#F00",
      background: "#FFF",
      text: "#000",
      textMuted: "#666",
    },
    logoPlacement: "header",
    logoUrl: "https://example.com/logo.png",
    proofPoints: [],
    ...overrides,
  };
}

describe("validatePremiumV2Quality", () => {
  it("passes a clean premium brief", () => {
    const result = validatePremiumV2Quality(makeBrief());
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.label).not.toBe("Failed Premium Standard");
  });

  it("fails when too many primary services exceed layout limit", () => {
    const brief = makeBrief({
      layoutDensity: "premium_services",
      primaryServices: Array.from({ length: 8 }, (_, i) => ({ name: `Service ${i + 1}`, isPrimary: true })),
    });
    const result = validatePremiumV2Quality(brief);
    expect(result.passed).toBe(false);
    expect(result.criticalFailures.some((f) => f.includes("Too many primary services"))).toBe(true);
    expect(result.label).toBe("Failed Premium Standard");
  });

  it("allows many services in catalogue mode", () => {
    const brief = makeBrief({
      layoutDensity: "catalogue_brochure",
      primaryServices: Array.from({ length: 10 }, (_, i) => ({ name: `Service ${i + 1}`, isPrimary: true })),
    });
    const result = validatePremiumV2Quality(brief);
    expect(result.passed).toBe(true);
  });

  it("flags generic copy phrases", () => {
    const brief = makeBrief({
      headline: "Your business needs our professional team",
      benefits: ["Quality service", "Great results"],
    });
    const result = validatePremiumV2Quality(brief);
    expect(result.warnings.some((w) => w.includes("Generic phrases"))).toBe(true);
  });

  it("fails when CTA is missing", () => {
    const brief = makeBrief({ cta: "" });
    const result = validatePremiumV2Quality(brief);
    expect(result.passed).toBe(false);
    expect(result.criticalFailures.some((f) => f.includes("CTA"))).toBe(true);
  });

  it("fails when headline is too short", () => {
    const brief = makeBrief({ headline: "Hi" });
    const result = validatePremiumV2Quality(brief);
    expect(result.passed).toBe(false);
    expect(result.criticalFailures.some((f) => f.includes("Headline"))).toBe(true);
  });
});

describe("assertV2LayoutGuarantees", () => {
  it("detects a clipped CTA", () => {
    const { ctaClipped } = assertV2LayoutGuarantees(1080, 1350, { x: 900, y: 1300, w: 300, h: 80 }, 1280);
    expect(ctaClipped).toBe(true);
  });

  it("detects a clipped footer", () => {
    const { footerClipped } = assertV2LayoutGuarantees(1080, 1350, { x: 400, y: 1200, w: 280, h: 64 }, 1345);
    expect(footerClipped).toBe(true);
  });

  it("accepts a safe CTA and footer", () => {
    const { ctaClipped, footerClipped } = assertV2LayoutGuarantees(1080, 1350, { x: 400, y: 1180, w: 280, h: 64 }, 1240);
    expect(ctaClipped).toBe(false);
    expect(footerClipped).toBe(false);
  });
});
