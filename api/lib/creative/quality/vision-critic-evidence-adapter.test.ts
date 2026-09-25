import { describe, expect, it } from "vitest";

import {
  VISION_CRITIC_ADAPTER_VERSION,
  adaptVisionCriticEvidence,
} from "./vision-critic-evidence-adapter";
import { evaluateVisualQualityContract } from "./visual-evaluation-contract";
import { VISUAL_DIMENSION_IDS } from "./visual-evaluation-contract";
import type { VisionCriticResult } from "../premium-v2/pipeline-types";

function fullCritic(overrides: Partial<VisionCriticResult["scores"]> = {}): VisionCriticResult {
  return {
    scores: {
      brandFidelity: 88,
      readability: 82,
      premiumFeel: 90,
      visualHierarchy: 85,
      logoUsage: 92,
      CTAVisibility: 86,
      genericTemplateRisk: 30,
      ...overrides,
    },
    passed: true,
    criticalIssues: [],
    improvementSuggestions: ["Tighten footer spacing"],
    unavailable: false,
    quotaError: false,
    realLogoPresent: true,
    logoMatchesBrand: true,
    fallbackBadgeUsed: false,
    logoDistortedOrCropped: false,
    brandFidelityPassed: true,
  };
}

describe("vision-critic-evidence-adapter", () => {
  it("maps every critic score onto the normalized dimensions deterministically", () => {
    const adapted = adaptVisionCriticEvidence(fullCritic());
    expect(adapted.version).toBe(VISION_CRITIC_ADAPTER_VERSION);
    expect(adapted.available).toBe(true);
    expect(adapted.unavailableReason).toBeNull();

    expect(adapted.dimensions.visual_hierarchy).toEqual({ score: 85, observed: true });
    expect(adapted.dimensions.layout_balance).toEqual({ score: Math.round((85 + 86) / 2), observed: true });
    expect(adapted.dimensions.brand_consistency).toEqual({ score: Math.round((88 + 92) / 2), observed: true });
    expect(adapted.dimensions.typography).toEqual({ score: 82, observed: true });
    expect(adapted.dimensions.readability_contrast).toEqual({ score: 82, observed: true });
    // genericTemplateRisk is inverted before entering the contract.
    expect(adapted.dimensions.professional_finish).toEqual({
      score: Math.round((90 + (100 - 30)) / 2),
      observed: true,
    });
    // The critic does not observe raw image quality.
    expect(adapted.dimensions.image_quality).toEqual({ score: null, observed: false });
  });

  it("is deterministic: same critic result, same adapted evidence", () => {
    const critic = fullCritic();
    expect(adaptVisionCriticEvidence(critic)).toEqual(adaptVisionCriticEvidence(critic));
  });

  it("marks every dimension unobserved when the critic is unavailable", () => {
    const unavailable: VisionCriticResult = {
      ...fullCritic(),
      unavailable: true,
      quotaError: true,
      criticalIssues: ["OpenAI quota error: insufficient quota"],
    };
    const adapted = adaptVisionCriticEvidence(unavailable);
    expect(adapted.available).toBe(false);
    expect(adapted.unavailableReason).toContain("quota");
    for (const dimensionId of VISUAL_DIMENSION_IDS) {
      expect(adapted.dimensions[dimensionId]).toEqual({ score: null, observed: false });
    }
  });

  it("treats a missing critic result as unavailable evidence", () => {
    const adapted = adaptVisionCriticEvidence(null);
    expect(adapted.available).toBe(false);
    expect(adapted.unavailableReason).toBe("vision_critic_result_missing");
  });

  it("clamps out-of-range scores and drops non-finite ones", () => {
    const adapted = adaptVisionCriticEvidence(
      fullCritic({
        readability: 140,
        premiumFeel: Number.NaN,
        visualHierarchy: -12,
      })
    );
    expect(adapted.dimensions.typography).toEqual({ score: 100, observed: true });
    expect(adapted.dimensions.readability_contrast).toEqual({ score: 100, observed: true });
    expect(adapted.dimensions.visual_hierarchy).toEqual({ score: 0, observed: true });
    // premiumFeel unusable -> professional_finish falls back to nothing.
    expect(adapted.dimensions.professional_finish).toEqual({ score: null, observed: false });
  });

  it("falls back to brandFidelity alone when logoUsage is missing", () => {
    const scores = fullCritic().scores as Partial<VisionCriticResult["scores"]>;
    delete scores.logoUsage;
    const adapted = adaptVisionCriticEvidence({ ...fullCritic(), scores: scores as VisionCriticResult["scores"] });
    expect(adapted.dimensions.brand_consistency).toEqual({ score: 88, observed: true });
  });

  it("feeds the contract as gap-filling evidence end to end", () => {
    const adapted = adaptVisionCriticEvidence(fullCritic());
    const result = evaluateVisualQualityContract({ vision: adapted });
    const byId = new Map(result.dimensions.map((dimension) => [dimension.dimensionId, dimension]));

    expect(byId.get("visual_hierarchy")?.provenance).toBe("vision_critic");
    expect(byId.get("brand_consistency")?.passed).toBe(true);
    expect(byId.get("image_quality")?.evaluationStatus).toBe("insufficient_evidence");
    expect(result.verdict).toBe("insufficient_evidence");
  });
});
