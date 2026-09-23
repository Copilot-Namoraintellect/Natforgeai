import { describe, expect, it } from "vitest";

import {
  VISUAL_DIMENSION_CONFIGS,
  VISUAL_DIMENSION_IDS,
  VISUAL_EVALUATION_CONTRACT_VERSION,
  contrastRatio,
  evaluateVisualQualityContract,
  getVisualDimensionConfig,
  type VisualEvaluationEvidenceInput,
} from "./visual-evaluation-contract";
import { adaptVisionCriticEvidence } from "./vision-critic-evidence-adapter";
import type { VisionCriticResult } from "../premium-v2/pipeline-types";
import type { V2RenderLayoutMetrics } from "../premium-v2/renderer";
import type { HybridBrandKit, HybridRenderMetrics, VisualDirection } from "../premium-v2/pipeline-types";

function strongEvidence(): VisualEvaluationEvidenceInput {
  return {
    renderMetrics: {
      width: 1080,
      height: 1350,
      ctaBoundingBox: { x: 160, y: 1118, w: 760, h: 72 },
      footerY: 1238,
      minFontSizeUsed: 20,
      didCrowd: false,
      usedContentHeight: 924,
      availableContentHeight: 942,
      primaryCardCount: 4,
      secondaryCardCount: 0,
    },
    brandRenderDiagnostics: {
      realLogoExpected: true,
      realLogoRendered: true,
      logoRenderMode: "image",
      logoRenderedHeight: 72,
      logoVisibleArea: 9000,
    },
    palette: {
      primary: "#0047AB",
      background: "#FFFFFF",
      text: "#0F172A",
      accent: "#F59E0B",
      source: "logo",
    },
    visualDirection: { density: "balanced", serviceLayout: "featured" },
  };
}

function strongVisionCritic(overrides: Partial<VisionCriticResult["scores"]> = {}): VisionCriticResult {
  return {
    scores: {
      brandFidelity: 95,
      readability: 92,
      premiumFeel: 94,
      visualHierarchy: 93,
      logoUsage: 96,
      CTAVisibility: 95,
      genericTemplateRisk: 10,
      ...overrides,
    },
    passed: true,
    criticalIssues: [],
    improvementSuggestions: [],
    unavailable: false,
    quotaError: false,
    realLogoPresent: true,
    logoMatchesBrand: true,
    fallbackBadgeUsed: false,
    logoDistortedOrCropped: false,
    brandFidelityPassed: true,
  };
}

describe("visual-evaluation-contract", () => {
  it("declares seven dimensions with explicit thresholds and weights summing to 1", () => {
    expect(VISUAL_DIMENSION_IDS).toHaveLength(7);
    expect(VISUAL_DIMENSION_IDS).toEqual([
      "visual_hierarchy",
      "layout_balance",
      "brand_consistency",
      "image_quality",
      "typography",
      "readability_contrast",
      "professional_finish",
    ]);
    const weightSum = VISUAL_DIMENSION_CONFIGS.reduce((sum, config) => sum + config.weight, 0);
    expect(weightSum).toBeCloseTo(1, 6);
    for (const config of VISUAL_DIMENSION_CONFIGS) {
      expect(config.threshold).toBeGreaterThan(0);
      expect(config.threshold).toBeLessThanOrEqual(100);
      expect(getVisualDimensionConfig(config.dimensionId)).toEqual(config);
    }
  });

  it("passes a fully-evidenced premium render with deterministic provenance only", () => {
    const result = evaluateVisualQualityContract(strongEvidence());
    expect(result.contractVersion).toBe(VISUAL_EVALUATION_CONTRACT_VERSION);
    expect(result.verdict).toBe("passed");
    expect(result.normalizedScore).not.toBeNull();
    expect(result.normalizedScore as number).toBeGreaterThanOrEqual(90);
    expect(result.failedDimensions).toHaveLength(0);
    expect(result.insufficientDimensions).toHaveLength(0);
    expect(result.dimensions.every((dimension) => dimension.provenance === "deterministic")).toBe(true);
    expect(result.dimensions.every((dimension) => dimension.evaluationStatus === "evaluated")).toBe(true);
    expect(result.reasonCodes).toContain("ALL_DIMENSIONS_MEET_THRESHOLDS");
  });

  it("is deterministic: identical evidence produces an identical result", () => {
    const first = evaluateVisualQualityContract(strongEvidence());
    const second = evaluateVisualQualityContract(strongEvidence());
    expect(first).toEqual(second);
  });

  it("reports an explicit failure dimension when typography falls below threshold", () => {
    const evidence = strongEvidence();
    evidence.renderMetrics = { ...evidence.renderMetrics!, minFontSizeUsed: 13 };
    const result = evaluateVisualQualityContract(evidence);
    expect(result.verdict).toBe("failed");
    expect(result.insufficientDimensions).toHaveLength(0);
    const failedIds = result.failedDimensions.map((dimension) => dimension.dimensionId);
    expect(failedIds).toEqual(["typography"]);
    const typography = result.failedDimensions[0];
    expect(typography.score).toBe(35);
    expect(typography.threshold).toBe(70);
    expect(typography.reasonCodes).toContain("TYPOGRAPHY_SCALE_TOO_SMALL");
    expect(result.normalizedScore).not.toBeNull();
    expect(result.reasonCodes).toContain("FAILED_DIMENSION_typography_35");
  });

  it("fails brand_consistency, image_quality and professional_finish when a fallback badge replaces a real logo", () => {
    const evidence = strongEvidence();
    evidence.brandRenderDiagnostics = {
      realLogoExpected: true,
      realLogoRendered: false,
      fallbackBadgeRendered: true,
      logoRenderMode: "fallback_badge",
      logoRenderedHeight: 48,
      logoVisibleArea: 3000,
    };
    const result = evaluateVisualQualityContract(evidence);
    expect(result.verdict).toBe("failed");
    const failedById = new Map(
      result.failedDimensions.map((dimension) => [dimension.dimensionId, dimension])
    );
    expect(failedById.get("brand_consistency")?.reasonCodes).toContain(
      "FALLBACK_BADGE_WHILE_REAL_LOGO_EXPECTED"
    );
    expect(failedById.get("image_quality")?.reasonCodes).toContain("IMAGE_FALLBACK_BADGE_RENDERED");
    expect(failedById.get("professional_finish")?.reasonCodes).toContain("FINISH_FALLBACK_BADGE");
    expect(failedById.has("visual_hierarchy")).toBe(false);
  });

  it("scores readability_contrast from WCAG ratios and fails low-contrast palettes", () => {
    expect(contrastRatio("#0F172A", "#FFFFFF")).toBeGreaterThan(15);
    expect(contrastRatio("#CCCCCC", "#FFFFFF")).toBeLessThan(2);

    const evidence = strongEvidence();
    evidence.palette = { ...evidence.palette!, text: "#CCCCCC" };
    const result = evaluateVisualQualityContract(evidence);
    expect(result.verdict).toBe("failed");
    const contrast = result.failedDimensions.find(
      (dimension) => dimension.dimensionId === "readability_contrast"
    );
    expect(contrast).toBeDefined();
    expect(contrast?.provenance).toBe("deterministic");
    expect(contrast?.reasonCodes.join(" ")).toMatch(/TEXT_ON_BACKGROUND_RATIO_\d+\.\d{2}/);
  });

  it("penalizes crowding across hierarchy, balance and finish", () => {
    const evidence = strongEvidence();
    evidence.renderMetrics = {
      ...evidence.renderMetrics!,
      didCrowd: true,
      usedContentHeight: 1000,
      availableContentHeight: 942,
    };
    const result = evaluateVisualQualityContract(evidence);
    expect(result.verdict).toBe("failed");
    const failedById = new Map(
      result.failedDimensions.map((dimension) => [dimension.dimensionId, dimension])
    );
    expect(failedById.get("visual_hierarchy")?.reasonCodes).toContain("RENDER_CROWDED");
    expect(failedById.get("layout_balance")?.reasonCodes).toContain("CONTENT_STACK_OVERFLOW");
    expect(failedById.get("professional_finish")?.reasonCodes).toContain("FINISH_RENDER_CROWDED");
  });

  it("fails closed with insufficient_evidence when no evidence is supplied", () => {
    const result = evaluateVisualQualityContract({});
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.normalizedScore).toBeNull();
    expect(result.insufficientDimensions).toEqual([...VISUAL_DIMENSION_IDS]);
    expect(result.failedDimensions).toHaveLength(0);
    expect(result.reasonCodes).toContain("INSUFFICIENT_EVIDENCE_FAIL_CLOSED");
  });

  it("refuses to fabricate scores for individual missing dimensions", () => {
    const evidence = strongEvidence();
    delete evidence.palette;
    const result = evaluateVisualQualityContract(evidence);
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.insufficientDimensions).toEqual(["readability_contrast"]);
  });

  it("lets deterministic evidence win while recording the vision score as corroboration", () => {
    const evidence = strongEvidence();
    evidence.vision = adaptVisionCriticEvidence(strongVisionCritic({ readability: 20 }));
    const result = evaluateVisualQualityContract(evidence);
    expect(result.verdict).toBe("passed");
    const contrast = result.dimensions.find(
      (dimension) => dimension.dimensionId === "readability_contrast"
    );
    expect(contrast?.provenance).toBe("deterministic");
    expect(contrast?.corroboratingVisionScore).toBe(20);
    expect(contrast?.score).toBe(100);
  });

  it("fills unobserved deterministic dimensions from adapted vision evidence", () => {
    const vision = adaptVisionCriticEvidence(strongVisionCritic());
    const result = evaluateVisualQualityContract({ vision });
    // image_quality is not observable by the critic, so the contract stays
    // fail-closed instead of passing on partial evidence.
    expect(result.verdict).toBe("insufficient_evidence");
    expect(result.insufficientDimensions).toEqual(["image_quality"]);
    const hierarchy = result.dimensions.find(
      (dimension) => dimension.dimensionId === "visual_hierarchy"
    );
    expect(hierarchy?.provenance).toBe("vision_critic");
    expect(hierarchy?.reasonCodes).toContain("DETERMINISTIC_EVIDENCE_UNAVAILABLE_VISION_OBSERVED");
  });

  it("does not inherit the critic's unavailable 50s: unavailable vision blocks passed verdicts", () => {
    const unavailableCritic: VisionCriticResult = {
      ...strongVisionCritic(),
      unavailable: true,
      criticalIssues: ["OpenAI quota error: quota exceeded"],
    };
    const result = evaluateVisualQualityContract({ vision: adaptVisionCriticEvidence(unavailableCritic) });
    expect(result.verdict).toBe("insufficient_evidence");
    expect(
      result.dimensions.every((dimension) => dimension.evaluationStatus === "insufficient_evidence")
    ).toBe(true);
    expect(
      result.dimensions.every((dimension) =>
        dimension.reasonCodes.some((code) => code.startsWith("VISION_EVIDENCE_UNAVAILABLE"))
      )
    ).toBe(true);
  });

  it("accepts existing pipeline evidence types structurally without conversion", () => {
    const v2Metrics: V2RenderLayoutMetrics = {
      width: 1080,
      height: 1350,
      ctaBoundingBox: { x: 160, y: 1118, w: 760, h: 72 },
      footerY: 1238,
      footerHeight: 112,
      minFontSizeUsed: 20,
      primaryCardCount: 4,
      secondaryCardCount: 3,
      layoutDensity: "premium_services",
      didCrowd: false,
      logoComposited: true,
      usedContentHeight: 924,
      availableContentHeight: 942,
      primaryWithDescriptionCount: 4,
    };
    const hybridMetrics: HybridRenderMetrics = {
      width: 1080,
      height: 1350,
      layoutPreset: "premium_services_brand_panel",
      realLogoExpected: true,
      realLogoRendered: true,
      logoRenderedHeight: 72,
      logoRenderedWidth: 220,
      logoVisibleArea: 9000,
      logoRenderMode: "image",
      fallbackBadgeRendered: false,
      logoMaskedOrCropped: false,
      logoDataUriUsed: true,
      logoFetchUsed: false,
    };
    const brandKit: HybridBrandKit = {
      primary: "#0047AB",
      secondary: "#1E40AF",
      accent: "#F59E0B",
      background: "#FFFFFF",
      text: "#0F172A",
      textMuted: "#475569",
      source: "logo",
      logoUrl: null,
      logoDescription: null,
      typographyNote: null,
    };
    const visualDirection: VisualDirection = {
      layoutPreset: "premium_services_brand_panel",
      density: "balanced",
      heroTreatment: "solid_brand_block",
      backgroundDirection: "abstract_brand_gradient",
      backgroundPrompt: "abstract brand gradient",
      ctaTreatment: "block_banner",
      serviceLayout: "featured",
      colourUsageNote: "primary panel, accent CTA",
    };

    const result = evaluateVisualQualityContract({
      renderMetrics: v2Metrics,
      brandRenderDiagnostics: hybridMetrics,
      palette: brandKit,
      visualDirection,
    });
    expect(result.verdict).toBe("passed");
    expect(result.insufficientDimensions).toHaveLength(0);
  });
});
