import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildHybridLogEntry,
  writeHybridGenerationLog,
  readHybridGenerationLog,
  buildRenderDiagnostics,
} from "./hybrid-sample-writer";
import type { HybridPipelineResult, HybridPipelineAttempt } from "../../api/lib/creative/premium-v2/pipeline-types";

function makeHybridResult(overrides?: Partial<HybridPipelineResult>): HybridPipelineResult {
  const base = {
    buffer: Buffer.from("test"),
    brandKit: {
      primary: "#0047AB",
      secondary: "#FFD700",
      accent: "#DC143C",
      background: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#475569",
      source: "logo" as const,
      logoUrl: "/uploads/logo/14/logo.png",
      logoDescription: null,
      typographyNote: null,
      brandAsset: {
        logoSourceType: "uploaded" as const,
        logoSourcePath: "/uploads/logo/14/logo.png",
        logoSourceUrl: "https://example.com/logo.png",
        logoResolved: true,
        logoRenderMode: "image" as const,
        realLogoExpected: true,
        realLogoRendered: true,
        fallbackReason: null,
        brandAssetWarnings: [],
      },
    },
    brief: {
      angle: "Fast printing",
      headline: "Fast, Professional Printing",
      subheadline: "Business cards, flyers, banners and courier services.",
      primaryServices: [{ name: "Business Cards", description: "Premium card printing", isPrimary: true }],
      secondaryServices: [],
      benefits: ["Same-day service"],
      cta: "Request a Quote Today",
      offerLine: null,
    },
    visualDirection: {
      layoutPreset: "premium_local_service" as const,
      density: "balanced" as const,
      heroTreatment: "shape_accent" as const,
      backgroundDirection: "abstract_brand_gradient" as const,
      backgroundPrompt: "soft gradient no text",
      ctaTreatment: "solid_button" as const,
      colourUsageNote: "brand colours",
    },
    critic: {
      scores: {
        brandFidelity: 85,
        readability: 90,
        premiumFeel: 82,
        visualHierarchy: 88,
        logoUsage: 85,
        CTAVisibility: 90,
        genericTemplateRisk: 25,
      },
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
    },
    revisionCount: 0,
    usedFallback: false,
    metadata: {
      provider: "premium-v2-hybrid",
      layoutPreset: "premium_local_service",
      width: 1080,
      height: 1350,
      attemptedOpenAIBrandKit: true,
      succeededOpenAIBrandKit: true,
      attemptedOpenAIBrief: true,
      succeededOpenAIBrief: true,
      attemptedOpenAIVisualDirection: true,
      succeededOpenAIVisualDirection: true,
      attemptedOpenAIBackground: true,
      succeededOpenAIBackground: true,
      finalUsedOpenAIBackground: true,
      attemptedOpenAIVisionCritic: true,
      succeededOpenAIVisionCritic: true,
      finalUsedOpenAIVisionCritic: true,
      usedDeterministicFallback: false,
      fallbackReason: null,
      quotaError: false,
      openAICallCount: 3,
      revisionCount: 0,
      finalDecision: "premium_ready" as const,
      rejectionCritic: null,
      realLogoExpected: true,
      realLogoRendered: true,
      logoNaturalWidth: 1432,
      logoNaturalHeight: 472,
      logoRenderedWidth: 334,
      logoRenderedHeight: 110,
      logoVisibleArea: 334 * 110,
      logoRenderMode: "image" as const,
      fallbackBadgeRendered: false,
      logoMaskedOrCropped: false,
      logoDataUriUsed: true,
      logoFetchUsed: false,
    },
  };
  return { ...base, ...overrides } as HybridPipelineResult;
}

describe("hybrid-sample-writer", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hybrid-writer-test-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("buildHybridLogEntry includes renderDiagnostics from metadata", () => {
    const result = makeHybridResult();
    const entry = buildHybridLogEntry("3at1", result, [], "/tmp/final.png");

    expect(entry.renderDiagnostics).toBeDefined();
    expect(entry.renderDiagnostics.realLogoExpected).toBe(true);
    expect(entry.renderDiagnostics.realLogoRendered).toBe(true);
    expect(entry.renderDiagnostics.logoRenderedWidth).toBe(334);
    expect(entry.renderDiagnostics.logoRenderedHeight).toBe(110);
    expect(entry.renderDiagnostics.fallbackBadgeRendered).toBe(false);
  });

  it("buildHybridLogEntry includes attemptDiagnostics from attempts", () => {
    const attemptMetrics = {
      width: 1080,
      height: 1350,
      layoutPreset: "premium_local_service",
      realLogoExpected: true,
      realLogoRendered: true,
      logoRenderedWidth: 334,
      logoRenderedHeight: 110,
      logoRenderMode: "image" as const,
      fallbackBadgeRendered: false,
    };
    const attempts: HybridPipelineAttempt[] = [
      { buffer: Buffer.from("attempt1"), critic: makeHybridResult().critic, visualDirection: makeHybridResult().visualDirection, metrics: attemptMetrics },
    ];
    const result = makeHybridResult({ attempts });
    const entry = buildHybridLogEntry("3at1", result, [], "/tmp/final.png");

    expect(entry.attemptDiagnostics).toHaveLength(1);
    expect(entry.attemptDiagnostics[0].realLogoRendered).toBe(true);
    expect(entry.attemptDiagnostics[0].fallbackBadgeRendered).toBe(false);
  });

  it("writes and reads renderDiagnostics in generation-log.txt", () => {
    const result = makeHybridResult();
    const entry = buildHybridLogEntry("3at1", result, [], "/tmp/final.png");
    writeHybridGenerationLog(tempDir, [entry]);

    const parsed = readHybridGenerationLog(tempDir);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].renderDiagnostics.logoRenderedWidth).toBe(334);
    expect(parsed[0].renderDiagnostics.logoRenderedHeight).toBe(110);
    expect(parsed[0].renderDiagnostics.fallbackBadgeRendered).toBe(false);
  });

  it("preserves renderDiagnostics in the log even when finalDecision is fallback_used", () => {
    const result = makeHybridResult({
      metadata: {
        ...makeHybridResult().metadata,
        finalDecision: "fallback_used",
        usedDeterministicFallback: true,
        finalUsedOpenAIBackground: false,
        finalUsedOpenAIVisionCritic: false,
      },
      critic: {
        ...makeHybridResult().critic,
        passed: false,
        realLogoPresent: false,
        fallbackBadgeUsed: true,
      },
    });
    const entry = buildHybridLogEntry("3at1", result, [], "/tmp/final.png");
    writeHybridGenerationLog(tempDir, [entry]);

    const parsed = readHybridGenerationLog(tempDir);
    expect(parsed[0].metadata.finalDecision).toBe("fallback_used");
    expect(parsed[0].renderDiagnostics.realLogoRendered).toBe(true);
    expect(parsed[0].renderDiagnostics.fallbackBadgeRendered).toBe(false);
  });
});

describe("buildRenderDiagnostics", () => {
  it("never returns an empty object when metadata has diagnostics", () => {
    const metadata = makeHybridResult().metadata;
    const diagnostics = buildRenderDiagnostics(metadata);
    expect(Object.keys(diagnostics).length).toBeGreaterThan(0);
    expect(diagnostics.logoRenderedWidth).toBeDefined();
  });

  it("returns an empty object when metadata is undefined", () => {
    expect(buildRenderDiagnostics(undefined)).toEqual({});
  });
});
