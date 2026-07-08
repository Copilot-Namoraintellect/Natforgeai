import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";
import type { BrandAssetResolution } from "../brand-asset-resolver";
import type { AICreativeBrief, HybridBrandKit, VisualDirection } from "./pipeline-types";

const mockGenerateBackground = vi.fn();
const mockRenderHybridLeaflet = vi.fn();
const mockCritiqueRenderedLeaflet = vi.fn();
const mockCritiqueLogoCrop = vi.fn();

vi.mock("./background-generator", () => ({
  generateBackground: (...args: any[]) => mockGenerateBackground(...args),
}));

vi.mock("./html-renderer", () => ({
  renderHybridLeaflet: (...args: any[]) => mockRenderHybridLeaflet(...args),
}));

vi.mock("./vision-critic", () => ({
  critiqueRenderedLeaflet: (...args: any[]) => mockCritiqueRenderedLeaflet(...args),
  critiqueLogoCrop: (...args: any[]) => mockCritiqueLogoCrop(...args),
}));

import { selectBestHybridVariant } from "./variant-selector";

const business = {
  displayName: "Sparkle Cleaners",
  name: "Sparkle Cleaners",
  phone: "123",
  website: "https://example.com",
  location: "Auckland",
  productOrService: "Cleaning",
};

const campaign = { id: 10, mainPainPoint: "dirty house", preferredCta: "Book Now" };

const brandKit: HybridBrandKit = {
  primary: "#0047AB",
  secondary: "#F97316",
  accent: "#FACC15",
  background: "#FFFFFF",
  text: "#0F172A",
  textMuted: "#475569",
  source: "logo",
  logoUrl: "https://example.com/logo.png",
  logoDescription: "round logo",
  typographyNote: null,
  brandAsset: {
    logoSourceType: "uploaded",
    logoSourcePath: "/uploads/logo/test.png",
    logoSourceUrl: "https://example.com/logo.png",
    logoResolved: true,
    logoRenderMode: "image",
    realLogoExpected: true,
    realLogoRendered: true,
    fallbackReason: null,
    brandAssetWarnings: [],
    logoBuffer: Buffer.from("fake-logo"),
  } as BrandAssetResolution,
};

const brief: AICreativeBrief = {
  angle: "Fresh clean home",
  headline: "Spotless Home, Zero Stress",
  subheadline: "Professional cleaning you can trust.",
  primaryServices: [{ name: "Home Cleaning", description: "Top to bottom cleaning", isPrimary: true }],
  secondaryServices: [],
  benefits: ["Reliable", "Affordable"],
  cta: "Book Now",
  offerLine: null,
};

const visualDirection: VisualDirection = {
  layoutPreset: "premium_local_service",
  density: "balanced",
  heroTreatment: "solid_brand_block",
  backgroundDirection: "abstract_brand_gradient",
  backgroundPrompt: "soft gradient no text",
  ctaTreatment: "solid_button",
  serviceLayout: "grid",
  colourUsageNote: "brand colours",
};

const metrics = {
  width: 1080,
  height: 1350,
  layoutPreset: "premium_local_service",
  realLogoExpected: true,
  realLogoRendered: true,
  logoNaturalWidth: 1432,
  logoNaturalHeight: 472,
  logoRenderedWidth: 334,
  logoRenderedHeight: 110,
  logoVisibleArea: 334 * 110,
  logoRenderMode: "image",
  fallbackBadgeRendered: false,
  logoMaskedOrCropped: false,
  logoDataUriUsed: true,
  logoFetchUsed: false,
};

function makePassingCritic() {
  return {
    scores: { brandFidelity: 90, readability: 90, premiumFeel: 85, visualHierarchy: 90, logoUsage: 90, CTAVisibility: 90, genericTemplateRisk: 20 },
    passed: true,
    unavailable: false,
    quotaError: false,
    criticalIssues: [],
    improvementSuggestions: [],
    realLogoPresent: true,
    logoMatchesBrand: true,
    fallbackBadgeUsed: false,
    logoDistortedOrCropped: false,
    brandFidelityPassed: true,
  };
}

function makeRejectingCritic() {
  return {
    scores: { brandFidelity: 60, readability: 60, premiumFeel: 60, visualHierarchy: 60, logoUsage: 60, CTAVisibility: 60, genericTemplateRisk: 60 },
    passed: false,
    unavailable: false,
    quotaError: false,
    criticalIssues: ["Generic template risk too high"],
    improvementSuggestions: ["Improve hierarchy"],
    realLogoPresent: true,
    logoMatchesBrand: true,
    fallbackBadgeUsed: false,
    logoDistortedOrCropped: false,
    brandFidelityPassed: false,
  };
}

describe("selectBestHybridVariant", () => {
  async function makeLeafletBuffer(): Promise<Buffer> {
    return sharp({
      create: { width: 1080, height: 1350, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    mockGenerateBackground.mockResolvedValue(Buffer.from("background"));
    mockRenderHybridLeaflet.mockResolvedValue({
      buffer: await makeLeafletBuffer(),
      html: "<div>Spotless Home, Zero Stress</div><div>Book Now</div>",
      metrics,
    });
    mockCritiqueRenderedLeaflet.mockResolvedValue(makePassingCritic());
    mockCritiqueLogoCrop.mockResolvedValue({
      realLogoPresent: true,
      logoMatchesExpected: true,
      fallbackBadgeUsed: false,
      logoDistortedOrCropped: false,
      explanation: "Crop matches expected logo.",
    });
  });

  it("returns three variants and selects the best one", async () => {
    const result = await selectBestHybridVariant({
      business: business as any,
      campaign: campaign as any,
      brandKit,
      brief,
      brandAsset: brandKit.brandAsset,
      baseVisualDirection: visualDirection,
    });

    expect(result.variants.length).toBe(3);
    expect(result.selectedIndex).toBeGreaterThanOrEqual(0);
    expect(result.selectedIndex).toBeLessThan(3);
    expect(result.best.buffer).toBeInstanceOf(Buffer);
  });

  it("selects a premium-ready variant when all gates pass", async () => {
    const result = await selectBestHybridVariant({
      business: business as any,
      campaign: campaign as any,
      brandKit,
      brief,
      brandAsset: brandKit.brandAsset,
      baseVisualDirection: visualDirection,
    });

    expect(result.best.contract.passed).toBe(true);
  });

  it("selects the safest variant when no variant passes the contract", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue(makeRejectingCritic());

    const result = await selectBestHybridVariant({
      business: business as any,
      campaign: campaign as any,
      brandKit,
      brief,
      brandAsset: brandKit.brandAsset,
      baseVisualDirection: visualDirection,
    });

    expect(result.best.contract.passed).toBe(false);
    expect(result.variants.every((v) => !v.contract.passed)).toBe(true);
  });

  it("overrules full-image logo false positives when the logo-crop critic confirms the logo", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue({
      ...makePassingCritic(),
      passed: false,
      realLogoPresent: false,
      logoMatchesBrand: false,
      fallbackBadgeUsed: true,
      brandFidelityPassed: false,
      criticalIssues: ["Fallback badge used while a real logo exists"],
      improvementSuggestions: ["Replace the fallback badge with the real logo"],
    });

    const result = await selectBestHybridVariant({
      business: business as any,
      campaign: campaign as any,
      brandKit,
      brief,
      brandAsset: brandKit.brandAsset,
      baseVisualDirection: visualDirection,
    });

    expect(result.best.contract.passed).toBe(true);
  });

  it("treats a failed logo-crop critic as a brand fidelity failure", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue({
      ...makePassingCritic(),
      passed: false,
      realLogoPresent: false,
      logoMatchesBrand: false,
      fallbackBadgeUsed: true,
      brandFidelityPassed: false,
      criticalIssues: ["Fallback badge used while a real logo exists"],
    });
    mockCritiqueLogoCrop.mockResolvedValue({
      realLogoPresent: false,
      logoMatchesExpected: false,
      fallbackBadgeUsed: true,
      logoDistortedOrCropped: false,
      explanation: "Focused crop does not show the real logo.",
    });

    const result = await selectBestHybridVariant({
      business: business as any,
      campaign: campaign as any,
      brandKit,
      brief,
      brandAsset: brandKit.brandAsset,
      baseVisualDirection: visualDirection,
    });

    expect(result.best.contract.passed).toBe(false);
    expect(result.best.contract.safeToRetainHybrid).toBe(false);
  });

  it("throws when background generation fails", async () => {
    mockGenerateBackground.mockResolvedValue(null);

    await expect(
      selectBestHybridVariant({
        business: business as any,
        campaign: campaign as any,
        brandKit,
        brief,
        brandAsset: brandKit.brandAsset,
        baseVisualDirection: visualDirection,
      })
    ).rejects.toThrow("Background generation failed");
  });
});
