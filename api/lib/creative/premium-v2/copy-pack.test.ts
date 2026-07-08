import { describe, it, expect } from "vitest";
import { buildPremiumCopyPack } from "./copy-pack";
import type { AICreativeBrief, VisualDirection } from "./pipeline-types";

const visualDirection: VisualDirection = {
  layoutPreset: "premium_local_service",
  density: "balanced",
  heroTreatment: "solid_brand_block",
  backgroundDirection: "abstract_brand_gradient",
  backgroundPrompt: "soft gradient",
  ctaTreatment: "solid_button",
  serviceLayout: "grid",
  colourUsageNote: "",
};

function makeBrief(overrides?: Partial<AICreativeBrief>): AICreativeBrief {
  return {
    angle: "Fresh clean home",
    headline: "Spotless Home, Zero Stress",
    subheadline: "Professional cleaning you can trust.",
    primaryServices: [{ name: "Home Cleaning", description: "Top to bottom cleaning", isPrimary: true }],
    secondaryServices: [],
    benefits: ["Reliable", "Affordable"],
    cta: "Book Now",
    offerLine: null,
    ...overrides,
  } as AICreativeBrief;
}

const business = {
  displayName: "Sparkle Cleaners",
  name: "Sparkle Cleaners",
  phone: "123",
  website: "https://example.com",
  location: "Auckland",
  productOrService: "Cleaning",
};

describe("buildPremiumCopyPack", () => {
  it("cleans and structures copy from the brief", () => {
    const pack = buildPremiumCopyPack(business as any, {}, makeBrief(), visualDirection);
    expect(pack.headline).toMatch(/^Spotless Home, Zero Stress/);
    expect(pack.subheadline).toBe("Professional cleaning you can trust.");
    expect(pack.cta).toMatch(/Book Now/i);
    expect(pack.services.length).toBeLessThanOrEqual(2);
    expect(pack.proofPoints.length).toBeGreaterThanOrEqual(1);
    expect(pack.footer).toContain("Auckland");
  });

  it("repairs a broken one-word CTA", () => {
    const pack = buildPremiumCopyPack(business as any, {}, makeBrief({ cta: "Contact" }), visualDirection);
    expect(pack.cta.split(/\s+/).length).toBeGreaterThanOrEqual(2);
  });

  it("deduplicates repeated service descriptions", () => {
    const pack = buildPremiumCopyPack(
      business as any,
      {},
      makeBrief({
        primaryServices: [
          { name: "Home Cleaning", description: "Top to bottom cleaning", isPrimary: true },
          { name: "Office Cleaning", description: "Top to bottom cleaning", isPrimary: true },
          { name: "Window Cleaning", description: "Top to bottom cleaning", isPrimary: true },
        ],
      }),
      visualDirection
    );
    const titles = pack.services.map((s) => s.title);
    expect(new Set(titles).size).toBe(titles.length);
  });

  it("uses fallback service microcopy when the raw description is too short", () => {
    const pack = buildPremiumCopyPack(
      business as any,
      {},
      makeBrief({
        primaryServices: [{ name: "Home Cleaning", description: "We clean", isPrimary: true }],
      }),
      visualDirection
    );
    expect(pack.featuredBenefit.body.length).toBeGreaterThan(5);
  });
});
