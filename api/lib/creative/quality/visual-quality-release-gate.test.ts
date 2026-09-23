import { describe, expect, it } from "vitest";

import {
  VISUAL_QUALITY_RELEASE_GATE_VERSION,
  evaluateVisualQualityReleaseGate,
} from "./visual-quality-release-gate";
import {
  VISUAL_DIMENSION_IDS,
  VISUAL_EVALUATION_CONTRACT_VERSION,
  type VisualEvaluationEvidenceInput,
} from "./visual-evaluation-contract";
import { adaptVisionCriticEvidence } from "./vision-critic-evidence-adapter";
import type { VisionCriticResult } from "../premium-v2/pipeline-types";

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

function criticWithScores(scores: Partial<VisionCriticResult["scores"]>): VisionCriticResult {
  return {
    scores: {
      brandFidelity: 95,
      readability: 92,
      premiumFeel: 94,
      visualHierarchy: 93,
      logoUsage: 96,
      CTAVisibility: 95,
      genericTemplateRisk: 10,
      ...scores,
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

function deepFreeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      deepFreeze((value as Record<string, unknown>)[key]);
    }
    Object.freeze(value);
  }
  return value;
}

describe("visual-quality-release-gate", () => {
  it("passes strong deterministic evidence in enforce mode without blocking", () => {
    const decision = evaluateVisualQualityReleaseGate({
      mode: "enforce",
      evidence: deepFreeze(strongEvidence()),
    });
    expect(decision.gateVersion).toBe(VISUAL_QUALITY_RELEASE_GATE_VERSION);
    expect(decision.evaluatorVersion).toBe(VISUAL_EVALUATION_CONTRACT_VERSION);
    expect(decision.mode).toBe("enforce");
    expect(decision.evaluation.verdict).toBe("passed");
    expect(decision.wouldBlock).toBe(false);
    expect(decision.blocked).toBe(false);
    expect(decision.failedDimensions).toHaveLength(0);
    expect(decision.insufficientDimensions).toHaveLength(0);
    expect(decision.totalScore).not.toBeNull();
    expect(decision.totalScore as number).toBeGreaterThanOrEqual(90);
    for (const dimensionId of VISUAL_DIMENSION_IDS) {
      expect(decision.evidenceProvenance[dimensionId]).toBe("deterministic");
    }
    expect(decision.reasonCodes).toContain("GATE_MODE_ENFORCE");
    expect(decision.reasonCodes).toContain("GATE_WOULD_PASS");
    expect(decision.reasonCodes).toContain("GATE_NOT_BLOCKED");
    expect(Object.isFrozen(decision)).toBe(true);
  });

  it("observe mode records but never blocks a visual failure", () => {
    const evidence = strongEvidence();
    evidence.palette = { ...evidence.palette!, text: "#CCCCCC" };
    const decision = evaluateVisualQualityReleaseGate({ mode: "observe", evidence });
    expect(decision.mode).toBe("observe");
    expect(decision.evaluation.verdict).toBe("failed");
    expect(decision.wouldBlock).toBe(true);
    expect(decision.blocked).toBe(false);
    expect(decision.failedDimensions.map((dimension) => dimension.dimensionId)).toEqual([
      "readability_contrast",
    ]);
    expect(decision.reasonCodes).toContain("GATE_MODE_OBSERVE");
    expect(decision.reasonCodes).toContain("GATE_WOULD_BLOCK");
    expect(decision.reasonCodes).toContain("GATE_NOT_BLOCKED");
  });

  it("enforce mode blocks a visual failure and preserves exact contract details", () => {
    const evidence = strongEvidence();
    evidence.brandRenderDiagnostics = {
      realLogoExpected: true,
      realLogoRendered: false,
      fallbackBadgeRendered: true,
      logoRenderMode: "fallback_badge",
      logoRenderedHeight: 48,
      logoVisibleArea: 3000,
    };
    const decision = evaluateVisualQualityReleaseGate({ mode: "enforce", evidence });
    expect(decision.wouldBlock).toBe(true);
    expect(decision.blocked).toBe(true);
    expect(decision.reasonCodes).toContain("GATE_ENFORCE_BLOCKED");

    // Failed-dimension and reason-code information is the contract's own,
    // not a gate-side reimplementation.
    expect(decision.failedDimensions).toEqual(decision.evaluation.failedDimensions);
    expect(decision.failedDimensions.map((dimension) => dimension.dimensionId)).toEqual([
      "brand_consistency",
      "image_quality",
      "professional_finish",
    ]);
    const contractReasonStart = decision.reasonCodes.length - decision.evaluation.reasonCodes.length;
    expect(decision.reasonCodes.slice(contractReasonStart)).toEqual(
      decision.evaluation.reasonCodes
    );
  });

  it("insufficient evidence fails closed in enforce mode but only observes in observe mode", () => {
    const enforceDecision = evaluateVisualQualityReleaseGate({ mode: "enforce", evidence: {} });
    expect(enforceDecision.evaluation.verdict).toBe("insufficient_evidence");
    expect(enforceDecision.wouldBlock).toBe(true);
    expect(enforceDecision.blocked).toBe(true);
    expect(enforceDecision.totalScore).toBeNull();
    expect(enforceDecision.insufficientDimensions).toEqual([...VISUAL_DIMENSION_IDS]);

    const observeDecision = evaluateVisualQualityReleaseGate({ mode: "observe", evidence: {} });
    expect(observeDecision.wouldBlock).toBe(true);
    expect(observeDecision.blocked).toBe(false);
    expect(observeDecision.evaluation).toEqual(enforceDecision.evaluation);
  });

  it("blocks on an unavailable critic instead of inheriting its permissive 50s", () => {
    const unavailableCritic: VisionCriticResult = {
      ...criticWithScores({}),
      unavailable: true,
      quotaError: true,
      criticalIssues: ["OpenAI quota error: insufficient quota"],
    };
    const decision = evaluateVisualQualityReleaseGate({
      mode: "enforce",
      evidence: {},
      critic: unavailableCritic,
    });
    expect(decision.evaluation.verdict).toBe("insufficient_evidence");
    expect(decision.wouldBlock).toBe(true);
    expect(decision.blocked).toBe(true);
    expect(
      decision.evaluation.dimensions.every((dimension) =>
        dimension.reasonCodes.some((code) => code.startsWith("VISION_EVIDENCE_UNAVAILABLE"))
      )
    ).toBe(true);
  });

  it("deterministic evidence overrides conflicting vision evidence", () => {
    const conflictingCritic = criticWithScores({
      readability: 5,
      visualHierarchy: 10,
      brandFidelity: 8,
      logoUsage: 8,
      premiumFeel: 6,
      CTAVisibility: 12,
      genericTemplateRisk: 92,
    });
    const decision = evaluateVisualQualityReleaseGate({
      mode: "enforce",
      evidence: strongEvidence(),
      critic: conflictingCritic,
    });
    expect(decision.evaluation.verdict).toBe("passed");
    expect(decision.blocked).toBe(false);
    for (const dimensionId of VISUAL_DIMENSION_IDS) {
      expect(decision.evidenceProvenance[dimensionId]).toBe("deterministic");
    }
    const contrast = decision.evaluation.dimensions.find(
      (dimension) => dimension.dimensionId === "readability_contrast"
    );
    expect(contrast?.corroboratingVisionScore).toBe(5);
    expect(contrast?.score).toBe(100);
  });

  it("blocks on a low individual dimension despite a high overall average", () => {
    const evidence = strongEvidence();
    evidence.renderMetrics = { ...evidence.renderMetrics!, minFontSizeUsed: 15 };
    const decision = evaluateVisualQualityReleaseGate({ mode: "enforce", evidence });
    expect(decision.totalScore).not.toBeNull();
    expect(decision.totalScore as number).toBeGreaterThanOrEqual(90);
    expect(decision.evaluation.verdict).toBe("failed");
    expect(decision.wouldBlock).toBe(true);
    expect(decision.blocked).toBe(true);
    expect(decision.failedDimensions.map((dimension) => dimension.dimensionId)).toEqual([
      "typography",
    ]);
    expect(decision.failedDimensions[0].score).toBe(55);
    expect(decision.failedDimensions[0].threshold).toBe(70);
  });

  it("is deterministically replayable: identical inputs produce an identical decision", () => {
    const critic = criticWithScores({ readability: 60 });
    const evidence = strongEvidence();
    const first = evaluateVisualQualityReleaseGate({ mode: "enforce", evidence, critic });
    const second = evaluateVisualQualityReleaseGate({ mode: "enforce", evidence, critic });
    expect(first).toEqual(second);
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
  });

  it("adapts a raw critic only when adapted vision evidence is not supplied", () => {
    const supplied = adaptVisionCriticEvidence(criticWithScores({ readability: 88 }));
    const decision = evaluateVisualQualityReleaseGate({
      mode: "enforce",
      evidence: { ...strongEvidence(), vision: supplied },
      critic: criticWithScores({ readability: 5 }),
    });
    const contrast = decision.evaluation.dimensions.find(
      (dimension) => dimension.dimensionId === "readability_contrast"
    );
    expect(contrast?.corroboratingVisionScore).toBe(88);
  });

  it("rejects an invalid mode deterministically", () => {
    expect(() =>
      evaluateVisualQualityReleaseGate({ mode: "shadow" as never, evidence: strongEvidence() })
    ).toThrow(/Invalid visual-quality release gate mode/);
  });
});
