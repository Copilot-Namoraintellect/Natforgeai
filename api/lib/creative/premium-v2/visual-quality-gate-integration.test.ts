import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
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
import { buildVisualQualityEvidenceInput } from "./visual-quality-gate-integration";
import { VISUAL_QUALITY_GATE_MODE_ENV_VAR } from "../quality/visual-quality-gate-mode";
import type { HybridRenderMetrics } from "./pipeline-types";

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

/**
 * Discriminator palette: the legacy premium contract never evaluates palette
 * contrast, so a passing critic still yields a passing legacy contract. The
 * WBS12F gate scores readability_contrast deterministically from this palette
 * (worst ratio ~2.85 < 3 → score 40 < 70) and fails closed on it.
 */
const weakContrastBrandKit: HybridBrandKit = {
  ...brandKit,
  accent: "#0047AB",
  text: "#999999",
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

const metrics: HybridRenderMetrics = {
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

/** Strong critic: legacy contract passes and the visual gate passes. */
function makeStrongCritic() {
  return {
    scores: { brandFidelity: 90, readability: 90, premiumFeel: 90, visualHierarchy: 90, logoUsage: 90, CTAVisibility: 90, genericTemplateRisk: 20 },
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

/** Unavailable critic: must fail closed, never produce a permissive pass. */
function makeUnavailableCritic() {
  return {
    scores: { brandFidelity: 50, readability: 50, premiumFeel: 50, visualHierarchy: 50, logoUsage: 50, CTAVisibility: 50, genericTemplateRisk: 50 },
    passed: false,
    unavailable: true,
    quotaError: true,
    criticalIssues: ["OpenAI quota error: insufficient quota"],
    improvementSuggestions: ["Re-render with deterministic fallback and queue for manual review."],
    realLogoPresent: false,
    logoMatchesBrand: false,
    fallbackBadgeUsed: true,
    logoDistortedOrCropped: true,
    brandFidelityPassed: false,
  };
}

/** Contradictory critic: claims terrible readability while the palette is fine. */
function makeContradictoryCritic() {
  return {
    ...makeStrongCritic(),
    scores: { brandFidelity: 90, readability: 5, premiumFeel: 90, visualHierarchy: 90, logoUsage: 90, CTAVisibility: 90, genericTemplateRisk: 20 },
    passed: false,
    criticalIssues: ["Readability below threshold"],
  };
}

function selectVariant(overrides?: {
  brandKit?: HybridBrandKit;
  openAICallCountRef?: { value: number };
}) {
  const kit = overrides?.brandKit ?? brandKit;
  return selectBestHybridVariant({
    business: business as any,
    campaign: campaign as any,
    brandKit: kit,
    brief,
    brandAsset: kit.brandAsset,
    baseVisualDirection: visualDirection,
    openAICallCountRef: overrides?.openAICallCountRef,
  });
}

describe("WBS12F3 visual quality gate integration at the premium seam", () => {
  async function makeLeafletBuffer(): Promise<Buffer> {
    return sharp({
      create: { width: 1080, height: 1350, channels: 4, background: { r: 255, g: 255, b: 255, alpha: 1 } },
    })
      .png()
      .toBuffer();
  }

  beforeEach(async () => {
    vi.clearAllMocks();
    delete process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR];
    mockGenerateBackground.mockResolvedValue(Buffer.from("background"));
    mockRenderHybridLeaflet.mockResolvedValue({
      buffer: await makeLeafletBuffer(),
      html: "<div>Spotless Home, Zero Stress</div><div>Book Now</div>",
      metrics,
    });
    mockCritiqueRenderedLeaflet.mockResolvedValue(makeStrongCritic());
    mockCritiqueLogoCrop.mockResolvedValue({
      realLogoPresent: true,
      logoMatchesExpected: true,
      fallbackBadgeUsed: false,
      logoDistortedOrCropped: false,
      explanation: "Crop matches expected logo.",
    });
  });

  afterEach(() => {
    delete process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR];
  });

  it("1. observe mode records a would-block decision without changing selection behaviour", async () => {
    process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = "observe";

    const result = await selectVariant({ brandKit: weakContrastBrandKit });

    const gate = result.best.visualGate;
    expect(gate.mode).toBe("observe");
    expect(gate.evaluation.verdict).toBe("failed");
    expect(gate.wouldBlock).toBe(true);
    expect(gate.blocked).toBe(false);
    expect(gate.failedDimensions.map((d) => d.dimensionId)).toEqual(["readability_contrast"]);
    expect(gate.failedDimensions[0].provenance).toBe("deterministic");
    expect(gate.totalScore as number).toBeGreaterThanOrEqual(85);
    expect(gate.insufficientDimensions).toEqual([]);

    // Legacy behaviour is untouched: the variant still passes the premium
    // contract, is auto-publishable and chargeable.
    expect(result.best.contract.passed).toBe(true);
    expect(result.best.contract.visualGate).toBe(gate);
    expect(result.best.contract.safeToAutoPublish).toBe(true);
    expect(result.best.contract.safeToChargePremiumCredits).toBe(true);
    expect(result.best.contract.needsHumanReview).toBe(false);
    expect(result.best.contract.issues).toEqual([]);
  });

  it("2. enforce mode with passing visual evidence behaves as current valid premium output", async () => {
    process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = "enforce";

    const result = await selectVariant();

    const gate = result.best.visualGate;
    expect(gate.mode).toBe("enforce");
    expect(gate.evaluation.verdict).toBe("passed");
    expect(gate.blocked).toBe(false);
    expect(gate.wouldBlock).toBe(false);
    expect(result.best.contract.passed).toBe(true);
    expect(result.best.contract.safeToAutoPublish).toBe(true);
    expect(result.best.contract.safeToChargePremiumCredits).toBe(true);
    expect(result.best.contract.needsHumanReview).toBe(false);
    expect(result.best.contract.issues).toEqual([]);
  });

  it("3+4. enforce visual failure blocks auto-publish and premium charging and routes to human review", async () => {
    process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = "enforce";

    const result = await selectVariant({ brandKit: weakContrastBrandKit });

    const contract = result.best.contract;
    const gate = result.best.visualGate;
    expect(gate.blocked).toBe(true);
    expect(gate.mode).toBe("enforce");
    expect(contract.passed).toBe(false);
    expect(contract.issues.some((i) => /Visual quality release gate blocked/.test(i))).toBe(true);
    expect(contract.issues.some((i) => /readability_contrast/.test(i))).toBe(true);
    expect(contract.safeToAutoPublish).toBe(false);
    expect(contract.safeToChargePremiumCredits).toBe(false);
    // Non-safety quality failure: retained for human review, not discarded.
    expect(contract.safeToRetainHybrid).toBe(true);
    expect(contract.needsHumanReview).toBe(true);
  });

  it("5+6. insufficient evidence blocks in enforce mode and an unavailable critic cannot create a pass", async () => {
    process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = "enforce";
    mockCritiqueRenderedLeaflet.mockResolvedValue(makeUnavailableCritic());

    const result = await selectVariant();

    const gate = result.best.visualGate;
    expect(gate.evaluation.verdict).toBe("insufficient_evidence");
    expect(gate.wouldBlock).toBe(true);
    expect(gate.blocked).toBe(true);
    expect(gate.totalScore).toBeNull();
    // Deterministic streams still evaluate; only critic-filled dimensions are
    // missing — and their absence fails closed instead of passing.
    expect(gate.insufficientDimensions).toEqual([
      "visual_hierarchy",
      "layout_balance",
      "typography",
    ]);
    expect(
      gate.evaluation.dimensions.every((d) => d.provenance !== "vision_critic")
    ).toBe(true);
    expect(result.best.contract.passed).toBe(false);
  });

  it("7. deterministic evidence wins over contradictory critic evidence", async () => {
    process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = "enforce";
    mockCritiqueRenderedLeaflet.mockResolvedValue(makeContradictoryCritic());

    const result = await selectVariant();

    const contrast = result.best.visualGate.evaluation.dimensions.find(
      (d) => d.dimensionId === "readability_contrast"
    );
    // The palette-derived deterministic contrast is authoritative even though
    // the critic claims readability is terrible.
    expect(contrast?.provenance).toBe("deterministic");
    expect(contrast?.score).toBe(100);
    expect(contrast?.corroboratingVisionScore).toBe(5);
    expect(contrast?.passed).toBe(true);
  });

  it("8. one failed dimension blocks even when the weighted total score is high", async () => {
    process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = "enforce";

    const result = await selectVariant({ brandKit: weakContrastBrandKit });

    const gate = result.best.visualGate;
    expect(gate.totalScore as number).toBeGreaterThanOrEqual(85);
    expect(gate.failedDimensions).toHaveLength(1);
    expect(gate.failedDimensions[0].dimensionId).toBe("readability_contrast");
    expect(gate.failedDimensions[0].score).toBe(40);
    expect(gate.failedDimensions[0].threshold).toBe(70);
    expect(gate.blocked).toBe(true);
    expect(result.best.contract.passed).toBe(false);
  });

  it("9. semantic copy is untouched by the visual gate in both modes", async () => {
    process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = "observe";
    const observeRun = await selectVariant({ brandKit: weakContrastBrandKit });
    process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = "enforce";
    const enforceRun = await selectVariant({ brandKit: weakContrastBrandKit });

    const observeBrief = mockRenderHybridLeaflet.mock.calls[0][0];
    const enforceBrief = mockRenderHybridLeaflet.mock.calls[3][0];
    expect(observeBrief.headline).toBe(observeRun.best.copyPack.headline);
    expect(observeBrief.cta).toBe("Book Now");
    expect(enforceBrief.headline).toBe(observeBrief.headline);
    expect(enforceBrief.cta).toBe(observeBrief.cta);
    expect(enforceRun.best.copyPack.headline).toBe(observeRun.best.copyPack.headline);
    expect(enforceRun.best.html).toBe(observeRun.best.html);

    // The evidence fed to the visual contract contains no copy text at all,
    // and no geometry is fabricated for the hybrid renderer.
    const evidence = buildVisualQualityEvidenceInput({
      metrics,
      brandKit,
      visualDirection,
    });
    expect(evidence.renderMetrics).toBeNull();
    expect(JSON.stringify(evidence)).not.toContain("Spotless Home");
    expect(JSON.stringify(evidence)).not.toContain("Book Now");
    expect(Object.keys(evidence).sort()).toEqual(
      ["brandRenderDiagnostics", "palette", "renderMetrics", "visualDirection"].sort()
    );
  });

  it("10. no second vision/provider invocation occurs in either mode", async () => {
    const observeRef = { value: 0 };
    await selectVariant({ brandKit: weakContrastBrandKit, openAICallCountRef: observeRef });

    // 1 background generation + 3 vision critic calls per run.
    expect(mockCritiqueRenderedLeaflet).toHaveBeenCalledTimes(3);
    expect(mockGenerateBackground).toHaveBeenCalledTimes(1);
    expect(observeRef.value).toBe(4);

    process.env[VISUAL_QUALITY_GATE_MODE_ENV_VAR] = "enforce";
    const enforceRef = { value: 0 };
    await selectVariant({ brandKit: weakContrastBrandKit, openAICallCountRef: enforceRef });

    expect(mockCritiqueRenderedLeaflet).toHaveBeenCalledTimes(6);
    expect(mockGenerateBackground).toHaveBeenCalledTimes(2);
    expect(enforceRef.value).toBe(4);
  });

  it("defaults to observe/shadow behaviour when the mode is not configured", async () => {
    const result = await selectVariant({ brandKit: weakContrastBrandKit });

    expect(result.best.visualGate.mode).toBe("observe");
    expect(result.best.visualGate.wouldBlock).toBe(true);
    expect(result.best.visualGate.blocked).toBe(false);
    expect(result.best.contract.passed).toBe(true);
  });
});
