import { describe, it, expect, vi, beforeEach } from "vitest";
import sharp from "sharp";

const mockPlanCreativeWithAI = vi.fn();
const mockGenerateBackground = vi.fn();
const mockRenderHybridLeaflet = vi.fn();
const mockCritiqueRenderedLeaflet = vi.fn();
const mockCritiqueLogoCrop = vi.fn();
const mockRenderV2FromBrief = vi.fn();
const mockValidatePremiumV2Quality = vi.fn();
const mockBuildPremiumV2Brief = vi.fn();

vi.mock("./plan-ai", () => ({
  planCreativeWithAI: (...args: any[]) => mockPlanCreativeWithAI(...args),
}));

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

vi.mock("./renderer", () => ({
  renderV2FromBrief: (...args: any[]) => mockRenderV2FromBrief(...args),
}));

vi.mock("./quality", () => ({
  validatePremiumV2Quality: (...args: any[]) => mockValidatePremiumV2Quality(...args),
}));

vi.mock("./brief", () => ({
  buildPremiumV2Brief: (...args: any[]) => mockBuildPremiumV2Brief(...args),
}));

vi.mock("../../env", () => ({
  env: {
    openaiApiKey: "test-key",
    enableHybridLeafletPipeline: true,
    hybridLeafletTextModel: "gpt-4o-mini",
    hybridLeafletVisionModel: "gpt-4o-mini",
    hybridLeafletMaxRevisions: 1,
  },
}));

import { runHybridPipeline } from "./hybrid-pipeline";

function makeInput(overrides?: { sampleMode?: boolean }) {
  return {
    business: {
      id: 1,
      name: "Test Business",
      displayName: "Test Business",
      industry: "Services",
      productOrService: "Cleaning",
      phone: "123",
      website: "https://example.com",
      location: "Auckland",
      logo: "https://example.com/logo.png",
    },
    campaign: { id: 10, mainPainPoint: "dirty house", preferredCta: "Book Now" } as any,
    post: { id: 100, campaignId: 10, title: "Test promo" },
    sampleMode: overrides?.sampleMode ?? false,
  };
}

function makePlan() {
  return {
    brandKit: {
      primary: "#0047AB",
      secondary: "#F97316",
      accent: "#FACC15",
      background: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#475569",
      source: "logo" as const,
      logoUrl: "https://example.com/logo.png",
      logoDescription: "round logo",
      typographyNote: null,
      brandAsset: {
        logoSourceType: "uploaded" as const,
        logoSourcePath: "/uploads/logo/test.png",
        logoSourceUrl: "https://example.com/logo.png",
        logoResolved: true,
        logoRenderMode: "image" as const,
        realLogoExpected: true,
        realLogoRendered: true,
        fallbackReason: null,
        brandAssetWarnings: [],
        logoBuffer: Buffer.from("fake-logo"),
      },
    },
    brief: {
      angle: "Fresh clean home",
      headline: "Spotless Home, Zero Stress",
      subheadline: "Professional cleaning you can trust.",
      primaryServices: [{ name: "Home Cleaning", description: "Top to bottom", isPrimary: true }],
      secondaryServices: [],
      benefits: ["Reliable", "Affordable"],
      cta: "Book Now",
      offerLine: null,
    },
    visualDirection: {
      layoutPreset: "premium_local_service" as const,
      density: "balanced" as const,
      heroTreatment: "solid_brand_block" as const,
      backgroundDirection: "abstract_brand_gradient" as const,
      backgroundPrompt: "soft gradient no text",
      ctaTreatment: "solid_button" as const,
      colourUsageNote: "brand colours",
    },
  };
}

async function makeLeafletBuffer(): Promise<Buffer> {
  return sharp({
    create: {
      width: 1080,
      height: 1350,
      channels: 4,
      background: { r: 255, g: 255, b: 255, alpha: 1 },
    },
  })
    .png()
    .toBuffer();
}

function makeNoLogoPlan() {
  const plan = makePlan();
  return {
    ...plan,
    brandKit: {
      ...plan.brandKit,
      source: "default" as const,
      logoUrl: null,
      logoDescription: null,
      brandAsset: {
        logoSourceType: "fallback" as const,
        logoSourcePath: null,
        logoSourceUrl: null,
        logoResolved: false,
        logoRenderMode: "fallback_badge" as const,
        realLogoExpected: false,
        realLogoRendered: false,
        fallbackReason: "No logo source found on business or campaign",
        brandAssetWarnings: ["Using fallback monogram because no brand logo exists."],
      },
    },
  };
}

function makePassingCritic(): any {
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

function makeFailingLogoCropCritic(): any {
  return {
    realLogoPresent: false,
    logoMatchesExpected: false,
    fallbackBadgeUsed: true,
    logoDistortedOrCropped: false,
    explanation: "Focused crop does not show the real logo.",
  };
}

function makeRejectingCritic(): any {
  return {
    scores: { brandFidelity: 60, readability: 60, premiumFeel: 60, visualHierarchy: 60, logoUsage: 60, CTAVisibility: 60, genericTemplateRisk: 60 },
    passed: false,
    unavailable: false,
    quotaError: false,
    criticalIssues: ["Generic"],
    improvementSuggestions: ["Improve hierarchy"],
    realLogoPresent: true,
    logoMatchesBrand: true,
    fallbackBadgeUsed: false,
    logoDistortedOrCropped: false,
    brandFidelityPassed: false,
  };
}

describe("Hybrid pipeline orchestrator", () => {
  beforeEach(async () => {
    vi.clearAllMocks();

    mockPlanCreativeWithAI.mockResolvedValue({ value: makePlan(), usedOpenAI: true });
    mockGenerateBackground.mockResolvedValue(Buffer.from("background"));
    mockRenderHybridLeaflet.mockResolvedValue({
      buffer: await makeLeafletBuffer(),
      html: "<div>Spotless Home, Zero Stress</div><div>Book Now</div>",
      metrics: {
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
      },
    });
    mockCritiqueRenderedLeaflet.mockResolvedValue(makePassingCritic());
    mockCritiqueLogoCrop.mockResolvedValue({
      realLogoPresent: true,
      logoMatchesExpected: true,
      fallbackBadgeUsed: false,
      logoDistortedOrCropped: false,
      explanation: "Crop matches expected logo.",
    });

    mockBuildPremiumV2Brief.mockResolvedValue({
      headline: "Fallback headline",
      subheadline: "Fallback subheadline",
      primaryServices: [],
      secondaryServices: [],
      benefits: [],
      cta: "Call",
      offer: null,
      brandPalette: { primary: "#000", secondary: "#fff", accent: "#f00", background: "#fff", text: "#000", textMuted: "#666" },
      logoUrl: null,
      layoutDensity: "balanced",
    });
    mockRenderV2FromBrief.mockResolvedValue({ buffer: Buffer.from("fallback"), metrics: { width: 1080, height: 1350 } });
    mockValidatePremiumV2Quality.mockReturnValue({ passed: true, score: 95, label: "Good", warnings: [], criticalFailures: [] });
  });

  it("reports premium_ready when the real hybrid path passes", async () => {
    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.usedDeterministicFallback).toBe(false);
    expect(result.metadata.attemptedOpenAIBrandKit).toBe(true);
    expect(result.metadata.succeededOpenAIBrandKit).toBe(true);
    expect(result.metadata.attemptedOpenAIBrief).toBe(true);
    expect(result.metadata.succeededOpenAIBrief).toBe(true);
    expect(result.metadata.attemptedOpenAIVisualDirection).toBe(true);
    expect(result.metadata.succeededOpenAIVisualDirection).toBe(true);
    expect(result.metadata.finalUsedOpenAIBackground).toBe(true);
    expect(result.metadata.finalUsedOpenAIVisionCritic).toBe(true);
    expect(result.metadata.finalDecision).toBe("premium_ready");
    expect(result.metadata.fallbackReason).toBeNull();
    expect(result.metadata.rejectionCritic).toBeNull();
    expect(result.metadata.openAICallCount).toBeGreaterThan(0);
  });

  it("retains the hybrid output as hybrid_review_required when only non-logo design issues remain", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue(makeRejectingCritic());

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.usedDeterministicFallback).toBe(false);
    expect(result.metadata.finalDecision).toBe("hybrid_review_required");
    expect(result.metadata.finalUsedOpenAIBackground).toBe(true);
    expect(result.metadata.finalUsedOpenAIVisionCritic).toBe(true);
    expect(result.critic.passed).toBe(false);
    expect(result.metadata.effectiveCriticPassed).toBe(false);
    expect(result.metadata.fallbackReason).toMatch(/Design quality review required/i);
  });

  it("retains the AI-generated background when the hybrid output is kept for review", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue(makeRejectingCritic());

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.attemptedOpenAIBackground).toBe(true);
    expect(result.metadata.succeededOpenAIBackground).toBe(true);
    expect(result.metadata.finalUsedOpenAIBackground).toBe(true);
    expect(result.metadata.usedDeterministicFallback).toBe(false);
  });

  it("stores the rejection critic JSON in metadata when falling back for content reasons", async () => {
    const critic = makePassingCritic();
    mockCritiqueRenderedLeaflet.mockResolvedValue(critic);
    mockRenderHybridLeaflet.mockResolvedValue({
      buffer: await makeLeafletBuffer(),
      html: "<div>Get 10% off your first order!</div><div>Book Now</div>",
      metrics: {
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
      },
    });

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.rejectionCritic).not.toBeNull();
    expect(result.metadata.finalDecision).toBe("content_review_required");
    expect(result.metadata.usedDeterministicFallback).toBe(true);
  });

  it("marks hybrid_review_required when the vision critic returns an unavailable result", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue({
      scores: { brandFidelity: 50, readability: 50, premiumFeel: 50, visualHierarchy: 50, logoUsage: 50, CTAVisibility: 50, genericTemplateRisk: 50 },
      passed: false,
      unavailable: true,
      quotaError: true,
      criticalIssues: ["OpenAI quota error"],
      improvementSuggestions: ["Re-render with deterministic fallback and queue for manual review."],
      realLogoPresent: false,
      logoMatchesBrand: false,
      fallbackBadgeUsed: true,
      logoDistortedOrCropped: false,
      brandFidelityPassed: false,
    });

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.usedDeterministicFallback).toBe(true);
    expect(result.metadata.finalDecision).toBe("hybrid_review_required");
    expect(result.metadata.quotaError).toBe(true);
    expect(result.critic.passed).toBe(false);
    expect(result.critic.scores.brandFidelity).toBeLessThanOrEqual(82);
  });

  it("respects maxHybridRevisions and does not loop forever", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue({
      ...makeRejectingCritic(),
      improvementSuggestions: ["background looks bland and plain"],
    });

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.revisionCount).toBeLessThanOrEqual(1);
    expect(mockGenerateBackground).toHaveBeenCalledTimes(2); // initial + one revision (background issue triggers regeneration)
    expect(mockCritiqueRenderedLeaflet).toHaveBeenCalledTimes(2);
  });

  it("reuses background for layout/text revisions instead of regenerating", async () => {
    const layoutCritic = {
      ...makeRejectingCritic(),
      improvementSuggestions: ["Increase text contrast and CTA size"],
    };
    mockCritiqueRenderedLeaflet.mockResolvedValue(layoutCritic);

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.revisionCount).toBeLessThanOrEqual(1);
    expect(mockGenerateBackground).toHaveBeenCalledTimes(1);
    expect(result.metadata.attemptedOpenAIBackground).toBe(true);
  });

  it("returns attempt buffers in sampleMode so rejected hybrid images can be inspected", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue(makeRejectingCritic());

    const result = await runHybridPipeline(makeInput({ sampleMode: true }) as any);
    expect(result.attempts).toBeDefined();
    expect(result.attempts!.length).toBeGreaterThanOrEqual(1);
    expect(result.attempts![0].buffer).toBeInstanceOf(Buffer);
    expect(result.attempts![0].critic.passed).toBe(false);
  });

  it("passes the resolved brandAsset and logo buffer into the hybrid HTML renderer", async () => {
    const plan = makePlan();
    mockPlanCreativeWithAI.mockResolvedValue({ value: plan, usedOpenAI: true });
    mockCritiqueRenderedLeaflet.mockResolvedValue(makePassingCritic());

    await runHybridPipeline(makeInput() as any);

    const renderCall = mockRenderHybridLeaflet.mock.calls[0];
    const passedBrandKit = renderCall[1];
    const passedLogoBuffer = renderCall[4];
    const passedBrandAsset = renderCall[5];

    expect(passedBrandKit.brandAsset).toBeDefined();
    expect(passedBrandKit.brandAsset.realLogoRendered).toBe(true);
    expect(passedLogoBuffer).toBeInstanceOf(Buffer);
    expect(passedBrandAsset?.realLogoExpected).toBe(true);
  });

  it("does not allow premium_ready when the critic reports a fallback badge while a real logo exists", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue({
      ...makePassingCritic(),
      realLogoPresent: false,
      logoMatchesBrand: false,
      fallbackBadgeUsed: true,
      logoDistortedOrCropped: false,
      brandFidelityPassed: false,
    });
    mockCritiqueLogoCrop.mockResolvedValue(makeFailingLogoCropCritic());

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.finalDecision).not.toBe("premium_ready");
    expect(result.metadata.usedDeterministicFallback).toBe(true);
    expect(result.critic.passed).toBe(false);
  });

  it("does not allow premium_ready when the critic reports a distorted logo while a real logo exists", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue({
      ...makePassingCritic(),
      realLogoPresent: true,
      logoMatchesBrand: true,
      fallbackBadgeUsed: false,
      logoDistortedOrCropped: true,
      brandFidelityPassed: false,
    });
    mockCritiqueLogoCrop.mockResolvedValue(makeFailingLogoCropCritic());

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.finalDecision).not.toBe("premium_ready");
    expect(result.metadata.usedDeterministicFallback).toBe(true);
  });

  it("includes render diagnostics in metadata on a successful hybrid path", async () => {
    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.realLogoExpected).toBe(true);
    expect(result.metadata.realLogoRendered).toBe(true);
    expect(result.metadata.logoRenderedWidth).toBeGreaterThan(200);
    expect(result.metadata.logoRenderedHeight).toBeGreaterThanOrEqual(55);
    expect(result.metadata.fallbackBadgeRendered).toBe(false);
    expect(result.metadata.logoRenderMode).toBe("image");
  });

  it("preserves the last hybrid attempt render diagnostics when falling back for content reasons", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue(makePassingCritic());
    mockRenderHybridLeaflet.mockResolvedValue({
      buffer: await makeLeafletBuffer(),
      html: "<div>Get 10% off your first order!</div><div>Book Now</div>",
      metrics: {
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
      },
    });

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.usedDeterministicFallback).toBe(true);
    expect(result.metadata.realLogoExpected).toBe(true);
    expect(result.metadata.realLogoRendered).toBe(true);
    expect(result.metadata.logoRenderedWidth).toBeGreaterThan(200);
    expect(result.metadata.logoRenderMode).toBe("image");
    expect(result.metadata.fallbackBadgeRendered).toBe(false);
  });

  it("stores render diagnostics on every sampleMode attempt", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue(makeRejectingCritic());

    const result = await runHybridPipeline(makeInput({ sampleMode: true }) as any);
    expect(result.attempts).toBeDefined();
    expect(result.attempts!.length).toBeGreaterThanOrEqual(1);
    const attemptMetrics = result.attempts![0].metrics;
    expect(attemptMetrics).toBeDefined();
    expect(attemptMetrics!.realLogoExpected).toBe(true);
    expect(attemptMetrics!.realLogoRendered).toBe(true);
    expect(attemptMetrics!.fallbackBadgeRendered).toBe(false);
  });

  it("detects critic conflict when renderer reports real logo but critic rejects it", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue({
      ...makePassingCritic(),
      realLogoPresent: false,
      logoMatchesBrand: false,
      fallbackBadgeUsed: true,
      logoDistortedOrCropped: false,
      brandFidelityPassed: false,
    });
    mockCritiqueLogoCrop.mockResolvedValue(makeFailingLogoCropCritic());

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.finalDecision).not.toBe("premium_ready");
    expect(result.metadata.criticConflict).toBe(true);
    expect(result.metadata.structuralBrandFidelityPassed).toBe(true);
    expect(result.metadata.visionBrandFidelityPassed).toBe(false);
    expect(result.metadata.criticConflictReason).toMatch(/Vision .*critic contradicted renderer logo diagnostics/i);
    expect(result.metadata.fallbackReason).toMatch(/Vision .*critic contradicted renderer logo diagnostics/i);
  });

  it("overrules a full-image logo false positive when the logo-crop critic confirms the real logo", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue({
      ...makePassingCritic(),
      passed: false,
      realLogoPresent: false,
      logoMatchesBrand: false,
      fallbackBadgeUsed: true,
      logoDistortedOrCropped: false,
      brandFidelityPassed: false,
      criticalIssues: ["Brand fidelity below threshold", "Logo usage below threshold", "Fallback badge used while a real logo exists"],
      improvementSuggestions: ["Replace the fallback badge with the real logo"],
    });
    mockCritiqueLogoCrop.mockResolvedValue({
      realLogoPresent: true,
      logoMatchesExpected: true,
      fallbackBadgeUsed: false,
      logoDistortedOrCropped: false,
      explanation: "Focused crop clearly shows the real logo.",
    });

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.finalDecision).toBe("premium_ready");
    expect(result.metadata.finalDecisionSource).toBe("adjudicated_effective_critic");
    expect(result.metadata.structuralBrandFidelityPassed).toBe(true);
    expect(result.metadata.visionBrandFidelityPassed).toBe(true);
    expect(result.metadata.criticConflict).toBe(false);
    expect(result.metadata.fullImageVsCropConflict).toBe(true);
    expect(result.metadata.fullImageVsCropConflictReason).toMatch(/Full-image critic reported logo issues/i);
    expect(result.metadata.rawFullImageCriticPassed).toBe(false);
    expect(result.metadata.effectiveCriticPassed).toBe(true);
    expect(result.metadata.effectiveCriticalIssues).toEqual([]);
    expect(result.metadata.overruledFullImageLogoIssues?.length).toBeGreaterThan(0);
    expect(result.metadata.logoCropRealLogoPresent).toBe(true);
    expect(result.metadata.logoCropFallbackBadgeUsed).toBe(false);
    expect(result.metadata.revisionCount).toBe(0);
    expect(result.metadata.fallbackReason).toBeNull();
  });

  it("removes logo-related issues and suggestions from the effective critic when the crop overrules them", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue({
      ...makePassingCritic(),
      passed: false,
      realLogoPresent: false,
      logoMatchesBrand: false,
      fallbackBadgeUsed: true,
      logoDistortedOrCropped: false,
      brandFidelityPassed: false,
      criticalIssues: ["Readability below threshold", "Logo usage below threshold", "Fallback badge used while a real logo exists"],
      improvementSuggestions: ["Increase text contrast", "Replace the fallback badge with the real logo"],
    });
    mockCritiqueLogoCrop.mockResolvedValue({
      realLogoPresent: true,
      logoMatchesExpected: true,
      fallbackBadgeUsed: false,
      logoDistortedOrCropped: false,
      explanation: "Focused crop shows the real logo clearly.",
    });

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.fullImageVsCropConflict).toBe(true);
    expect(result.metadata.overruledFullImageLogoIssues).toEqual(
      expect.arrayContaining(["Logo usage below threshold", "Fallback badge used while a real logo exists"])
    );
    expect(result.metadata.effectiveCriticalIssues).toEqual(["Readability below threshold"]);
    expect(result.critic.improvementSuggestions).not.toEqual(
      expect.arrayContaining([expect.stringMatching(/fallback badge/i)])
    );
    expect(result.critic.improvementSuggestions).toEqual(expect.arrayContaining(["Increase text contrast"]));
  });

  it("passes content fidelity when no offer is provided and no promotional language is rendered", async () => {
    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.offerExpected).toBe(false);
    expect(result.metadata.offerRendered).toBe(false);
    expect(result.metadata.inventedOfferDetected).toBe(false);
    expect(result.metadata.contentFidelityPassed).toBe(true);
  });

  it("blocks premium_ready and sets content_review_required when an invented offer is detected", async () => {
    mockRenderHybridLeaflet.mockResolvedValue({
      buffer: Buffer.from("hybrid"),
      html: "<div>Get 10% off your first order!</div><div>Book Now</div>",
      metrics: {
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
      },
    });

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.finalDecision).toBe("content_review_required");
    expect(result.metadata.inventedOfferDetected).toBe(true);
    expect(result.metadata.contentFidelityPassed).toBe(false);
    expect(result.metadata.fallbackReason).toMatch(/10% off/i);
    expect(result.metadata.usedDeterministicFallback).toBe(true);
  });

  it("allows an approved campaign offer to render without flagging it as invented", async () => {
    const input = makeInput();
    input.campaign = { ...input.campaign, offerDetails: "10% off your first order" };
    mockRenderHybridLeaflet.mockResolvedValue({
      buffer: Buffer.from("hybrid"),
      html: "<div>10% off your first order</div><div>Book Now</div>",
      metrics: {
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
      },
    });

    const result = await runHybridPipeline(input as any);
    expect(result.metadata.offerExpected).toBe(true);
    expect(result.metadata.offerSource).toBe("campaign");
    expect(result.metadata.offerRendered).toBe(true);
    expect(result.metadata.inventedOfferDetected).toBe(false);
    expect(result.metadata.contentFidelityPassed).toBe(true);
  });

  it("passes brand fidelity for a business with no logo without requiring a real logo", async () => {
    mockPlanCreativeWithAI.mockResolvedValue({ value: makeNoLogoPlan(), usedOpenAI: true });
    mockRenderHybridLeaflet.mockResolvedValue({
      buffer: Buffer.from("hybrid"),
      html: "<div>Spotless Home, Zero Stress</div><div>Book Now</div>",
      metrics: {
        width: 1080,
        height: 1350,
        layoutPreset: "premium_local_service",
        realLogoExpected: false,
        realLogoRendered: false,
        logoRenderMode: "fallback_badge",
        fallbackBadgeRendered: true,
        logoMaskedOrCropped: false,
        logoDataUriUsed: false,
        logoFetchUsed: false,
      },
    });
    mockCritiqueRenderedLeaflet.mockResolvedValue({
      ...makePassingCritic(),
      realLogoPresent: false,
      logoMatchesBrand: false,
      fallbackBadgeUsed: true,
      logoDistortedOrCropped: false,
      brandFidelityPassed: true,
    });

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.realLogoExpected).toBe(false);
    expect(result.metadata.structuralBrandFidelityPassed).toBe(true);
    expect(result.metadata.visionBrandFidelityPassed).toBe(true);
    expect(result.metadata.criticConflict).toBe(false);
    expect(result.metadata.finalDecision).toBe("premium_ready");
  });
});
