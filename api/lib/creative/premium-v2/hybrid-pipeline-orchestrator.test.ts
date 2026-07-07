import { describe, it, expect, vi, beforeEach } from "vitest";

const mockPlanCreativeWithAI = vi.fn();
const mockGenerateBackground = vi.fn();
const mockRenderHybridLeaflet = vi.fn();
const mockCritiqueRenderedLeaflet = vi.fn();
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
    campaign: { id: 10, mainPainPoint: "dirty house", preferredCta: "Book Now" },
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
  beforeEach(() => {
    vi.clearAllMocks();

    mockPlanCreativeWithAI.mockResolvedValue({ value: makePlan(), usedOpenAI: true });
    mockGenerateBackground.mockResolvedValue(Buffer.from("background"));
    mockRenderHybridLeaflet.mockResolvedValue({ buffer: Buffer.from("hybrid") });
    mockCritiqueRenderedLeaflet.mockResolvedValue(makePassingCritic());

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

  it("does not allow perfect scores when deterministic fallback is used", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue(makeRejectingCritic());

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.usedDeterministicFallback).toBe(true);
    expect(result.metadata.finalDecision).toBe("fallback_used");
    expect(result.critic.passed).toBe(false);
    expect(result.critic.scores.brandFidelity).toBeLessThanOrEqual(82);
    expect(result.critic.scores.genericTemplateRisk).toBeGreaterThanOrEqual(25);
  });

  it("records background success even when the final output falls back", async () => {
    mockCritiqueRenderedLeaflet.mockResolvedValue(makeRejectingCritic());

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.attemptedOpenAIBackground).toBe(true);
    expect(result.metadata.succeededOpenAIBackground).toBe(true);
    expect(result.metadata.finalUsedOpenAIBackground).toBe(false);
  });

  it("stores the rejection critic JSON in metadata", async () => {
    const critic = makeRejectingCritic();
    mockCritiqueRenderedLeaflet.mockResolvedValue(critic);

    const result = await runHybridPipeline(makeInput() as any);
    expect(result.metadata.rejectionCritic).not.toBeNull();
    expect(result.metadata.rejectionCritic?.criticalIssues).toEqual(critic.criticalIssues);
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
});
