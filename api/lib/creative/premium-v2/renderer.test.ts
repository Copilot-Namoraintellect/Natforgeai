import { describe, it, expect } from "vitest";
import sharp from "sharp";
import { PremiumV2Renderer, renderV2FromBrief } from "./renderer";
import type { PremiumLeafletV2Brief } from "./types";

function makeBrief(overrides: Partial<PremiumLeafletV2Brief> = {}): PremiumLeafletV2Brief {
  return {
    businessName: "Test Biz",
    businessCategory: "local_services",
    headline: "Professional service you can trust",
    subheadline: "Fast, reliable help for your home.",
    primaryServices: [
      { name: "Repairs", isPrimary: true },
      { name: "Installations", isPrimary: true },
      { name: "Maintenance", isPrimary: true },
    ],
    secondaryServices: [{ name: "Consultations", isPrimary: false }],
    benefits: ["Fast", "Reliable", "Affordable"],
    cta: "Call Us Today",
    contact: { phone: "123 456 7890", website: "https://test.test" },
    visualStyle: "modern",
    layoutDensity: "premium_services",
    brandPalette: {
      primary: "#1E3A8A",
      secondary: "#F59E0B",
      accent: "#10B981",
      background: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#475569",
    },
    logoPlacement: "header",
    proofPoints: [{ label: "Serves", value: "Local homeowners" }],
    ...overrides,
  };
}

describe("renderV2FromBrief", () => {
  it("produces a 1080x1350 PNG", async () => {
    const { buffer, metrics } = await renderV2FromBrief(makeBrief());
    const meta = await sharp(buffer).metadata();
    expect(meta.format).toBe("png");
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
    expect(metrics.width).toBe(1080);
    expect(metrics.height).toBe(1350);
  });

  it("renders a catalogue layout for many services", async () => {
    const brief = makeBrief({
      layoutDensity: "catalogue_brochure",
      primaryServices: Array.from({ length: 12 }, (_, i) => ({ name: `Service ${i + 1}`, isPrimary: true })),
      secondaryServices: [],
    });
    const { buffer } = await renderV2FromBrief(brief);
    const meta = await sharp(buffer).metadata();
    expect(meta.width).toBe(1080);
    expect(meta.height).toBe(1350);
  });

  it("does not clip CTA or footer", async () => {
    const { metrics } = await renderV2FromBrief(makeBrief());
    const { ctaBoundingBox, footerY, footerHeight, height } = metrics;
    expect(ctaBoundingBox.y).toBeGreaterThanOrEqual(0);
    expect(ctaBoundingBox.y + ctaBoundingBox.h).toBeLessThanOrEqual(height);
    expect(footerY + footerHeight).toBeLessThanOrEqual(height);
  });

  it("reports layout metrics for the quality gate", async () => {
    const { metrics } = await renderV2FromBrief(makeBrief());
    expect(metrics.primaryCardCount).toBe(3);
    expect(metrics.secondaryCardCount).toBe(1);
    expect(metrics.minFontSizeUsed).toBeGreaterThanOrEqual(14);
  });
});

describe("PremiumV2Renderer", () => {
  it("requires a v2Brief on the request", async () => {
    const renderer = new PremiumV2Renderer();
    const result = await renderer.render({} as any);
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/v2Brief/);
  });

  it("renders successfully with a valid v2Brief", async () => {
    const renderer = new PremiumV2Renderer();
    const brief = makeBrief();
    const result = await renderer.render({ v2Brief: brief } as any);
    expect(result.success).toBe(true);
    expect(result.imageBase64).toBeTruthy();
    expect(result.extension).toBe("png");
    expect(result.metadata?.v2LayoutMetrics).toBeTruthy();
  });
});
