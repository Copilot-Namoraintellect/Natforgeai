import { describe, it, expect } from "vitest";
import { evaluatePremiumDesignContract } from "./premium-design-contract";
import type { HybridRenderMetrics, PremiumCopyPack, VisualDirection } from "./pipeline-types";
import { evaluateVisualQualityReleaseGate } from "../quality/visual-quality-release-gate";
import type { VisualEvaluationEvidenceInput } from "../quality/visual-evaluation-contract";
import type { VisualQualityReleaseGateDecision } from "../quality/visual-quality-release-gate";

const baseMetrics: HybridRenderMetrics = {
  width: 1080,
  height: 1350,
  layoutPreset: "premium_local_service",
  realLogoExpected: true,
  realLogoRendered: true,
  fallbackBadgeRendered: false,
  logoMaskedOrCropped: false,
};

const baseCopyPack: PremiumCopyPack = {
  eyebrow: "Sparkle Cleaners",
  headline: "Spotless Home, Zero Stress",
  subheadline: "Professional cleaning you can trust.",
  featuredBenefit: { title: "Home Cleaning", body: "Top to bottom cleaning" },
  services: [{ title: "Office Cleaning", body: "Clean workspaces" }],
  proofPoints: ["Reliable", "Affordable"],
  cta: "Book Now",
  footer: "Auckland",
};

const baseVisualDirection: VisualDirection = {
  layoutPreset: "premium_local_service_featured",
  density: "minimal",
  heroTreatment: "shape_accent",
  backgroundDirection: "abstract_brand_gradient",
  backgroundPrompt: "",
  ctaTreatment: "block_banner",
  serviceLayout: "featured",
  colourUsageNote: "",
};

const baseLayoutScores = {
  layoutScore: 90,
  ctaDominanceScore: 95,
  hierarchyScore: 90,
  templateRiskScore: 15,
  copyScore: 95,
  brandScore: 95,
};

function evaluate(overrides: {
  metrics?: Partial<HybridRenderMetrics>;
  copyPack?: Partial<PremiumCopyPack>;
  visualDirection?: Partial<VisualDirection>;
  layoutScores?: Partial<typeof baseLayoutScores>;
  brandFidelity?: { structuralBrandFidelityPassed: boolean; visionBrandFidelityPassed: boolean };
  effectiveCriticPassed?: boolean;
  contentFidelity?: any;
  copyQuality?: any;
  usedDeterministicFallback?: boolean;
  visualGate?: VisualQualityReleaseGateDecision | null;
}) {
  return evaluatePremiumDesignContract({
    metadata: {},
    metrics: { ...baseMetrics, ...overrides.metrics },
    copyPack: { ...baseCopyPack, ...overrides.copyPack },
    visualDirection: { ...baseVisualDirection, ...overrides.visualDirection },
    layoutScores: { ...baseLayoutScores, ...overrides.layoutScores },
    brandFidelity: overrides.brandFidelity ?? { structuralBrandFidelityPassed: true, visionBrandFidelityPassed: true },
    effectiveCriticPassed: overrides.effectiveCriticPassed ?? true,
    usedDeterministicFallback: overrides.usedDeterministicFallback ?? false,
    contentFidelity: overrides.contentFidelity ?? { contentFidelityPassed: true, inventedOfferDetected: false },
    copyQuality: overrides.copyQuality ?? { copyQualityPassed: true, copyQualityIssues: [] },
    visualGate: overrides.visualGate ?? null,
  });
}

describe("evaluatePremiumDesignContract", () => {
  it("passes when all gates are green", () => {
    const result = evaluate({});
    expect(result.passed).toBe(true);
    expect(result.safeToChargePremiumCredits).toBe(true);
    expect(result.needsHumanReview).toBe(false);
  });

  it("fails when the real logo is not rendered", () => {
    const result = evaluate({ metrics: { realLogoRendered: false, fallbackBadgeRendered: true } });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /real logo not rendered/i.test(i))).toBe(true);
    expect(result.safeToRetainHybrid).toBe(false);
  });

  it("fails when a fallback badge is rendered while a real logo exists", () => {
    const result = evaluate({ metrics: { fallbackBadgeRendered: true } });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /fallback badge rendered/i.test(i))).toBe(true);
    expect(result.safeToRetainHybrid).toBe(false);
  });

  it("fails and is unsafe when an invented offer is detected", () => {
    const result = evaluate({ contentFidelity: { contentFidelityPassed: false, inventedOfferDetected: true } });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /invented offer/i.test(i))).toBe(true);
    expect(result.safeToRetainHybrid).toBe(false);
  });

  it("fails but retains for review when only the effective critic fails", () => {
    const result = evaluate({ effectiveCriticPassed: false });
    expect(result.passed).toBe(false);
    expect(result.safeToRetainHybrid).toBe(true);
    expect(result.needsHumanReview).toBe(true);
  });

  it("fails when layout scores are below thresholds", () => {
    const result = evaluate({ layoutScores: { ctaDominanceScore: 50 } });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /CTA dominance/i.test(i))).toBe(true);
  });

  it("fails when a uniform generic card grid is detected", () => {
    const result = evaluate({
      visualDirection: { serviceLayout: "grid" },
      copyPack: {
        services: [
          { title: "A", body: "Body A" },
          { title: "B", body: "Body B" },
          { title: "C", body: "Body C" },
        ],
      },
    });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /uniform generic card grid/i.test(i))).toBe(true);
  });

  it("never passes when deterministic fallback was used", () => {
    const result = evaluate({ usedDeterministicFallback: true });
    expect(result.passed).toBe(false);
  });

  it("exposes a null visualGate and unchanged semantics when no gate decision was supplied", () => {
    const result = evaluate({});
    expect(result.visualGate).toBeNull();
    expect(result.passed).toBe(true);
    expect(result.safeToAutoPublish).toBe(true);
    expect(result.safeToChargePremiumCredits).toBe(true);
  });
});

describe("evaluatePremiumDesignContract with the WBS12F visual gate", () => {
  function strongVisualEvidence(): VisualEvaluationEvidenceInput {
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

  function failingVisualGate(mode: "observe" | "enforce"): VisualQualityReleaseGateDecision {
    const evidence = strongVisualEvidence();
    evidence.palette = { ...evidence.palette!, text: "#CCCCCC" };
    return evaluateVisualQualityReleaseGate({ mode, evidence });
  }

  function passingVisualGate(mode: "observe" | "enforce"): VisualQualityReleaseGateDecision {
    return evaluateVisualQualityReleaseGate({ mode, evidence: strongVisualEvidence() });
  }

  it("observe mode carries a would-block decision without altering the contract outcome", () => {
    const gate = failingVisualGate("observe");
    expect(gate.wouldBlock).toBe(true);
    expect(gate.blocked).toBe(false);

    const result = evaluate({ visualGate: gate });
    expect(result.visualGate).toBe(gate);
    expect(result.passed).toBe(true);
    expect(result.issues).toEqual([]);
    expect(result.safeToAutoPublish).toBe(true);
    expect(result.safeToChargePremiumCredits).toBe(true);
    expect(result.needsHumanReview).toBe(false);
  });

  it("enforce mode with a blocked gate fails the contract and blocks auto-publish and charging", () => {
    const gate = failingVisualGate("enforce");
    expect(gate.blocked).toBe(true);
    expect(gate.failedDimensions.map((d) => d.dimensionId)).toEqual(["readability_contrast"]);

    const result = evaluate({ visualGate: gate });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /Visual quality release gate blocked/.test(i))).toBe(true);
    expect(result.issues.some((i) => /readability_contrast/.test(i))).toBe(true);
    expect(result.safeToAutoPublish).toBe(false);
    expect(result.safeToChargePremiumCredits).toBe(false);
    expect(result.safeToRetainHybrid).toBe(true);
    expect(result.needsHumanReview).toBe(true);
  });

  it("enforce mode with insufficient evidence blocks fail-closed", () => {
    const gate = evaluateVisualQualityReleaseGate({ mode: "enforce", evidence: {} });
    expect(gate.evaluation.verdict).toBe("insufficient_evidence");
    expect(gate.blocked).toBe(true);

    const result = evaluate({ visualGate: gate });
    expect(result.passed).toBe(false);
    expect(result.issues.some((i) => /insufficient evidence:/.test(i))).toBe(true);
    expect(result.safeToAutoPublish).toBe(false);
    expect(result.safeToChargePremiumCredits).toBe(false);
    expect(result.needsHumanReview).toBe(true);
  });

  it("enforce mode with a passing gate preserves valid premium output semantics", () => {
    const gate = passingVisualGate("enforce");
    expect(gate.blocked).toBe(false);

    const result = evaluate({ visualGate: gate });
    expect(result.visualGate).toBe(gate);
    expect(result.passed).toBe(true);
    expect(result.safeToAutoPublish).toBe(true);
    expect(result.safeToChargePremiumCredits).toBe(true);
    expect(result.needsHumanReview).toBe(false);
  });

  it("safety issues still override retention when the enforce gate is also blocked", () => {
    const gate = failingVisualGate("enforce");

    const result = evaluate({
      visualGate: gate,
      metrics: { realLogoRendered: false, fallbackBadgeRendered: true },
    });
    expect(result.passed).toBe(false);
    expect(result.safeToRetainHybrid).toBe(false);
    expect(result.needsHumanReview).toBe(false);
  });

  it("never reads or rewrites semantic copy when the gate blocks", () => {
    const gate = failingVisualGate("enforce");
    // The gate decision carries no copy text at all.
    expect(JSON.stringify(gate)).not.toContain("Sparkle");
    expect(JSON.stringify(gate)).not.toContain("Book Now");

    // A frozen copy pack still evaluates: nothing mutates semantic copy.
    const frozenCopyPack = Object.freeze({
      ...baseCopyPack,
      services: Object.freeze([{ title: "Office Cleaning", body: "Clean workspaces" }]),
    }) as PremiumCopyPack;

    const result = evaluate({ visualGate: gate, copyPack: frozenCopyPack });
    expect(result.passed).toBe(false);
    expect(frozenCopyPack.services[0].title).toBe("Office Cleaning");
  });
});
