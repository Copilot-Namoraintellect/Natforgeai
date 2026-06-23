import { describe, it, expect, vi } from "vitest";

vi.mock("ai", () => ({
  generateText: vi.fn(async () => ({
    text: JSON.stringify({ hasText: false, hasLogo: false, hasBusinessName: false, details: "No fake branding detected." }),
  })),
}));
import sharp from "sharp";
import {
  validateLeafletPrompt,
  validateBrandFidelity,
  validateLeafletComposition,
  computeQualityTier,
  qualityTierLabel,
  sanitizePromptForValidator,
} from "./quality";

function business(category?: string) {
  return {
    name: "Test Biz",
    websiteEvidence: { businessCategory: category },
    industry: category,
  };
}

describe("computeQualityTier", () => {
  it("caps fallback outputs to draft", () => {
    expect(computeQualityTier(95, true)).toBe("draft");
  });

  it("maps non-fallback scores to premium/acceptable/draft/failed", () => {
    expect(computeQualityTier(85, false)).toBe("premium");
    expect(computeQualityTier(70, false)).toBe("acceptable");
    expect(computeQualityTier(50, false)).toBe("draft");
    expect(computeQualityTier(0, false)).toBe("failed");
  });
});

describe("qualityTierLabel", () => {
  it("returns customer-facing labels", () => {
    expect(qualityTierLabel("premium")).toBe("Premium");
    expect(qualityTierLabel("draft")).toBe("Basic Draft");
    expect(qualityTierLabel("failed")).toBe("Failed");
  });
});

describe("validateLeafletPrompt", () => {
  it("passes for a relevant, safe prompt", () => {
    const prompt = "Premium print shop workspace with printer, paper and business cards, no text";
    const result = validateLeafletPrompt(prompt, business("print and copy"));
    expect(result.passed).toBe(true);
    expect(result.criticalFailures).toHaveLength(0);
  });

  it("fails when prompt references unsupported services", () => {
    const prompt = "Marketing agency leaflet with SEO and social media management icons";
    const result = validateLeafletPrompt(prompt, business("retail"));
    expect(result.passed).toBe(false);
    expect(result.criticalFailures.some((f) => f.includes("unsupported services"))).toBe(true);
  });

  it("fails when prompt requests a generic icon grid", () => {
    const prompt = "Create a simple icon grid of services";
    const result = validateLeafletPrompt(prompt, business("service"));
    expect(result.criticalFailures.some((f) => f.includes("icon-grid"))).toBe(true);
  });

  it("allows icon-grid language when it is negated", () => {
    const prompt = "Do NOT use a simple icon grid layout";
    const result = validateLeafletPrompt(prompt, business("service"));
    expect(result.criticalFailures.some((f) => f.includes("icon-grid"))).toBe(false);
  });

  it("fails when visuals do not match the business category", () => {
    const prompt = "Delicious burger and fries photography";
    const result = validateLeafletPrompt(prompt, business("beauty salon"));
    expect(result.criticalFailures.some((f) => f.includes("business category"))).toBe(true);
  });
});

describe("sanitizePromptForValidator", () => {
  it("rephrases icon-grid wording without changing intent", () => {
    const sanitized = sanitizePromptForValidator("Use an icon grid layout");
    expect(sanitized).not.toContain("icon grid");
    expect(sanitized).toContain("icon arrangement");
  });
});

describe("validateBrandFidelity", () => {
  it("penalises missing logo", () => {
    const result = validateBrandFidelity({ hasLogo: false, palette: { source: "saved" }, businessName: "Test" });
    expect(result.scorePenalty).toBeGreaterThan(0);
    expect(result.issues.some((i) => i.includes("logo"))).toBe(true);
  });

  it("penalises generic default palette", () => {
    const result = validateBrandFidelity({ hasLogo: true, logoOverlayApplied: true, palette: { source: "default" }, businessName: "Test" });
    expect(result.issues.some((i) => i.includes("generic"))).toBe(true);
  });

  it("penalises informal Rand wording", () => {
    const result = validateBrandFidelity({ hasLogo: true, headline: "Save 500 rands today" });
    expect(result.issues.some((i) => i.includes("rands"))).toBe(true);
  });

  it("passes when brand assets are present", () => {
    const result = validateBrandFidelity({
      hasLogo: true,
      logoOverlayApplied: true,
      palette: { source: "saved" },
      businessName: "Test Biz",
      headline: "Big Sale — R500 off",
    });
    expect(result.issues).toHaveLength(0);
    expect(result.scorePenalty).toBe(0);
  });
});

describe("validateLeafletComposition", () => {
  it("penalises long headline and CTA", () => {
    const result = validateLeafletComposition({
      hasLogo: true,
      headline: "a".repeat(80),
      cta: "a".repeat(40),
      serviceBullets: ["a", "b", "c", "d", "e", "f", "g"],
    });
    expect(result.issues.length).toBeGreaterThan(0);
    expect(result.scorePenalty).toBeGreaterThan(0);
  });

  it("passes for compact, balanced inputs", () => {
    const result = validateLeafletComposition({
      hasLogo: true,
      headline: "Big Sale",
      cta: "Shop now",
      serviceBullets: ["a", "b", "c"],
    });
    expect(result.issues).toHaveLength(0);
    expect(result.scorePenalty).toBe(0);
  });
});

describe("validateAiLeafletQuality integration", () => {
  it("rejects a corrupt final buffer", async () => {
    const { validateAiLeafletQuality } = await import("./quality");
    const result = await validateAiLeafletQuality({
      finalBuffer: Buffer.from("not an image"),
      business: business("retail"),
      campaign: {},
      prompt: "Premium retail display, no text",
      hasLogo: true,
      logoOverlayApplied: true,
      palette: { source: "saved" },
      headline: "Big Sale",
      cta: "Shop now",
    });
    expect(result.passed).toBe(false);
    expect(result.score).toBe(0);
    expect(result.criticalFailures[0]).toContain("corrupt");
  });

  it("accepts a clean composed image", async () => {
    const { validateAiLeafletQuality } = await import("./quality");
    const background = await sharp({
      create: { width: 1024, height: 1536, channels: 3, background: { r: 80, g: 90, b: 110 } },
    })
      .png()
      .toBuffer();

    const result = await validateAiLeafletQuality({
      backgroundBuffer: background,
      finalBuffer: background,
      business: business("retail"),
      campaign: {},
      prompt: "Premium retail product display, no text, no logos, no people",
      hasLogo: true,
      logoOverlayApplied: true,
      palette: { source: "saved" },
      headline: "Big Sale",
      cta: "Shop now",
    });
    expect(result.passed).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(60);
  });
});
