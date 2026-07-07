import { describe, it, expect, vi } from "vitest";

vi.mock("ai", () => ({
  generateObject: vi.fn(async () => {
    throw new Error("Mocked OpenAI failure to test deterministic fallback");
  }),
  generateText: vi.fn(async () => ({
    text: JSON.stringify({
      scores: { brandFidelity: 85, readability: 85, premiumFeel: 80, visualHierarchy: 85, logoUsage: 85, CTAVisibility: 90, genericTemplateRisk: 25 },
      passed: true,
      criticalIssues: [],
      improvementSuggestions: [],
    }),
  })),
}));

vi.mock("../../env", () => ({
  env: {
    openaiApiKey: "test-key",
    enableHybridLeafletPipeline: true,
    hybridLeafletTextModel: "gpt-4o-mini",
    hybridLeafletVisionModel: "gpt-4o-mini",
    hybridLeafletMaxRevisions: 2,
  },
}));

import { resolveBrandKitWithAI } from "./brand-kit-ai";
import { buildAICreativeBrief } from "./brief-ai";
import { buildVisualDirection } from "./visual-direction";
import { critiqueRenderedLeaflet } from "./vision-critic";
import { VisionCriticResultSchema } from "./pipeline-types";
import { fixtureRestaurant } from "./fixtures";

describe("Hybrid pipeline AI modules", () => {
  it("brand-kit-ai falls back to deterministic brand kit when mocked", async () => {
    const { business } = fixtureRestaurant();
    const result = await resolveBrandKitWithAI(business as any);
    expect(result.usedOpenAI).toBe(false);
    expect(result.fallbackReason).toContain("Mocked OpenAI failure");
    expect(result.value.primary).toBeTruthy();
    expect(result.value.accent).toBeTruthy();
    expect(result.value.logoUrl).toBe(business.logo);
  });

  it("brief-ai never returns the raw pain point as subheadline", async () => {
    const { business, campaign } = fixtureRestaurant();
    const brandKit = {
      primary: "#B91C1C",
      secondary: "#F97316",
      accent: "#FACC15",
      background: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#475569",
      source: "brandColors" as const,
      logoUrl: business.logo || null,
      logoDescription: null,
      typographyNote: null,
    };
    const result = await buildAICreativeBrief(business as any, campaign as any, brandKit);
    expect(result.usedOpenAI).toBe(false);
    const brief = result.value;
    expect(brief.subheadline.toLowerCase().trim()).not.toBe(campaign.mainPainPoint.toLowerCase().trim());
    expect(brief.subheadline.length).toBeGreaterThan(20);
  });

  it("visual-direction returns a supported layout preset", async () => {
    const { business, campaign } = fixtureRestaurant();
    const brandKit = {
      primary: "#B91C1C",
      secondary: "#F97316",
      accent: "#FACC15",
      background: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#475569",
      source: "brandColors" as const,
      logoUrl: business.logo || null,
      logoDescription: null,
      typographyNote: null,
    };
    const briefResult = await buildAICreativeBrief(business as any, campaign as any, brandKit);
    const directionResult = await buildVisualDirection(business as any, campaign as any, brandKit, briefResult.value);
    expect(directionResult.usedOpenAI).toBe(false);
    expect(directionResult.value.layoutPreset).toBeTruthy();
    expect(directionResult.value.backgroundPrompt.length).toBeGreaterThan(10);
  });

  it("vision-critic returns a structured scorecard", async () => {
    const buffer = Buffer.from("fake-image");
    const critic = await critiqueRenderedLeaflet(buffer, "Test Business", true);
    expect(critic.scores.brandFidelity).toBeGreaterThan(0);
    expect(critic.scores.readability).toBeGreaterThan(0);
    expect(typeof critic.passed).toBe("boolean");
  });

  it("vision-critic marks unavailable result on OpenAI failure", async () => {
    const buffer = Buffer.from("fake-image");
    const critic = await critiqueRenderedLeaflet(buffer, "Test Business", true);
    expect(critic.unavailable).toBe(true);
    expect(critic.passed).toBe(false);
    expect(critic.scores.genericTemplateRisk).toBe(50);
  });

  it("vision-critic detects quota errors from OpenAI failures", async () => {
    const { generateObject } = await import("ai");
    (generateObject as any).mockRejectedValueOnce(new Error("You exceeded your current quota"));

    const buffer = Buffer.from("fake-image");
    const critic = await critiqueRenderedLeaflet(buffer, "Test Business", true);
    expect(critic.unavailable).toBe(true);
    expect(critic.quotaError).toBe(true);
    expect(critic.passed).toBe(false);
  });

  it("VisionCriticResultSchema requires all declared keys including unavailable and quotaError", () => {
    const valid = {
      scores: { brandFidelity: 80, readability: 80, premiumFeel: 80, visualHierarchy: 80, logoUsage: 80, CTAVisibility: 80, genericTemplateRisk: 30 },
      passed: false,
      criticalIssues: ["test"],
      improvementSuggestions: ["improve"],
      unavailable: false,
      quotaError: false,
    };
    expect(() => VisionCriticResultSchema.parse(valid)).not.toThrow();

    const missing = { ...valid };
    delete (missing as any).unavailable;
    delete (missing as any).quotaError;
    expect(() => VisionCriticResultSchema.parse(missing)).toThrow();
  });
});
