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
import { fixtureRestaurant } from "./fixtures";

describe("Hybrid pipeline AI modules", () => {
  it("brand-kit-ai falls back to deterministic brand kit when mocked", async () => {
    const { business } = fixtureRestaurant();
    const brandKit = await resolveBrandKitWithAI(business as any);
    expect(brandKit.primary).toBeTruthy();
    expect(brandKit.accent).toBeTruthy();
    expect(brandKit.logoUrl).toBe(business.logo);
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
      logoUrl: business.logo,
      logoDescription: null,
      typographyNote: null,
    };
    const brief = await buildAICreativeBrief(business as any, campaign as any, brandKit);
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
      logoUrl: business.logo,
      logoDescription: null,
      typographyNote: null,
    };
    const brief = await buildAICreativeBrief(business as any, campaign as any, brandKit);
    const direction = await buildVisualDirection(business as any, campaign as any, brandKit, brief);
    expect(direction.layoutPreset).toBeTruthy();
    expect(direction.backgroundPrompt.length).toBeGreaterThan(10);
  });

  it("vision-critic returns a structured scorecard", async () => {
    const buffer = Buffer.from("fake-image");
    const critic = await critiqueRenderedLeaflet(buffer, "Test Business", true);
    expect(critic.scores.brandFidelity).toBeGreaterThan(0);
    expect(critic.scores.readability).toBeGreaterThan(0);
    expect(typeof critic.passed).toBe("boolean");
  });
});
