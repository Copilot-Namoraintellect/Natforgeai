import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, existsSync, readFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import {
  buildHybridLogEntry,
  saveHybridAttemptImages,
  writeHybridGenerationLog,
  decisionLabel,
} from "./hybrid-sample-writer";
import type { HybridPipelineResult } from "../../api/lib/creative/premium-v2/pipeline-types";

function makeHybridResult(overrides?: Partial<HybridPipelineResult["metadata"]> & { attempts?: any[] }): HybridPipelineResult {
  return {
    buffer: Buffer.from("final"),
    brandKit: {
      primary: "#000",
      secondary: "#fff",
      accent: "#f00",
      background: "#fff",
      text: "#000",
      textMuted: "#666",
      source: "default",
      logoUrl: null,
      logoDescription: null,
      typographyNote: null,
    },
    brief: {
      angle: "",
      headline: "",
      subheadline: "",
      primaryServices: [],
      secondaryServices: [],
      benefits: [],
      cta: "",
      offerLine: null,
    },
    visualDirection: {
      layoutPreset: "premium_local_service",
      density: "balanced",
      heroTreatment: "solid_brand_block",
      backgroundDirection: "abstract_brand_gradient",
      backgroundPrompt: "",
      ctaTreatment: "solid_button",
      colourUsageNote: "",
    },
    critic: {
      scores: { brandFidelity: 80, readability: 80, premiumFeel: 80, visualHierarchy: 80, logoUsage: 80, CTAVisibility: 80, genericTemplateRisk: 30 },
      passed: true,
      unavailable: false,
      quotaError: false,
      criticalIssues: [],
      improvementSuggestions: [],
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
      finalDecision: "premium_ready",
      rejectionCritic: null,
      ...overrides,
    },
    attempts: overrides?.attempts,
  } as HybridPipelineResult;
}

describe("hybrid sample writer", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "hybrid-writer-"));
  });

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true });
  });

  it("builds a log entry with attempt paths and final path", () => {
    const result = makeHybridResult();
    const entry = buildHybridLogEntry("3at1", result, ["attempt-0.png"], "final.png");
    expect(entry.fixture).toBe("3at1");
    expect(entry.label).toBe("Hybrid Premium Ready");
    expect(entry.passed).toBe(true);
    expect(entry.attemptPaths).toEqual(["attempt-0.png"]);
    expect(entry.finalPath).toBe("final.png");
  });

  it("saves attempt images from the hybrid result", () => {
    const result = makeHybridResult();
    result.attempts = [
      { buffer: Buffer.from("a0"), critic: result.critic, visualDirection: result.visualDirection },
    ];
    const paths = saveHybridAttemptImages(tempDir, "3at1", result);
    expect(paths.length).toBe(1);
    expect(existsSync(paths[0])).toBe(true);
    expect(paths[0]).toContain("3at1-hybrid-attempt-0.png");
  });

  it("writes a structured generation-log.txt", () => {
    const result = makeHybridResult();
    const entry = buildHybridLogEntry("3at1", result, [], "final.png");
    const logPath = writeHybridGenerationLog(tempDir, [entry]);
    expect(existsSync(logPath)).toBe(true);
    expect(logPath).toContain("generation-log.txt");
    const parsed = JSON.parse(readFileSync(logPath, "utf-8"));
    expect(parsed[0].fixture).toBe("3at1");
    expect(parsed[0].metadata.finalDecision).toBe("premium_ready");
  });

  it("labels fallback outputs honestly", () => {
    const result = makeHybridResult({ finalDecision: "fallback_used", usedDeterministicFallback: true });
    const entry = buildHybridLogEntry("3at1", result, [], "final.png");
    expect(entry.label).toBe("Fallback Used - Needs Review");
    expect(entry.passed).toBe(false);
  });
});
