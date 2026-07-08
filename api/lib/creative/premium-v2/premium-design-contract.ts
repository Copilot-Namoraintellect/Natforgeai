/**
 * Premium Leaflet Hybrid Pipeline – Premium Design Contract.
 *
 * Central gate that decides whether a paid premium asset is good enough to be
 * marked Premium Ready, auto-published and charged for. If the contract fails
 * but objective safety passes, the asset can still be retained for human review.
 */

import type { HybridPipelineMetadata, HybridRenderMetrics, PremiumCopyPack, VisualDirection } from "./pipeline-types";
import type { CopyQualityResult } from "./copy-quality";
import type { ContentFidelityResult } from "./content-fidelity";
import type { LayoutScoreResult } from "./layout-scoring";

export interface PremiumDesignContractResult {
  passed: boolean;
  issues: string[];
  safeToRetainHybrid: boolean;
  safeToAutoPublish: boolean;
  safeToChargePremiumCredits: boolean;
  needsHumanReview: boolean;
}

interface ContractInputs {
  metadata: Partial<HybridPipelineMetadata>;
  metrics: HybridRenderMetrics | undefined;
  copyPack: PremiumCopyPack;
  copyQuality: CopyQualityResult;
  contentFidelity: ContentFidelityResult | undefined;
  brandFidelity: { structuralBrandFidelityPassed: boolean; visionBrandFidelityPassed: boolean } | undefined;
  effectiveCriticPassed: boolean;
  usedDeterministicFallback: boolean;
  layoutScores: LayoutScoreResult;
  visualDirection: VisualDirection;
}

export function evaluatePremiumDesignContract(inputs: ContractInputs): PremiumDesignContractResult {
  const {
    metrics,
    copyPack,
    copyQuality,
    contentFidelity,
    brandFidelity,
    effectiveCriticPassed,
    usedDeterministicFallback,
    layoutScores,
    visualDirection,
  } = inputs;

  const issues: string[] = [];

  const realLogoExpected = metrics?.realLogoExpected ?? false;
  const realLogoRendered = metrics?.realLogoRendered ?? false;
  const fallbackBadgeRendered = metrics?.fallbackBadgeRendered ?? false;

  // 1. Brand / logo fidelity.
  if (realLogoExpected && !realLogoRendered) issues.push("Real logo not rendered");
  if (realLogoExpected && fallbackBadgeRendered) issues.push("Fallback badge rendered while real logo exists");
  if (!brandFidelity?.structuralBrandFidelityPassed) issues.push("Structural brand fidelity failed");
  if (!brandFidelity?.visionBrandFidelityPassed) issues.push("Vision brand fidelity failed");

  // 2. Content safety.
  if (!contentFidelity?.contentFidelityPassed) issues.push("Content fidelity failed");
  if (contentFidelity?.inventedOfferDetected) issues.push("Invented offer detected");

  // 3. Copy quality.
  if (!copyQuality.copyQualityPassed) issues.push(`Copy quality failed: ${copyQuality.copyQualityIssues.join("; ")}`);

  // 4. Critic.
  if (!effectiveCriticPassed) issues.push("Effective critic did not pass");

  // 5. No deterministic fallback.
  if (usedDeterministicFallback) issues.push("Deterministic fallback was used");

  // 6. Layout quality thresholds.
  if (layoutScores.ctaDominanceScore < 70) issues.push(`CTA dominance too low (${layoutScores.ctaDominanceScore})`);
  if (layoutScores.hierarchyScore < 70) issues.push(`Visual hierarchy too weak (${layoutScores.hierarchyScore})`);
  if (layoutScores.templateRiskScore > 40) issues.push(`Generic template risk too high (${layoutScores.templateRiskScore})`);
  if (layoutScores.copyScore < 80) issues.push(`Copy score too low (${layoutScores.copyScore})`);
  if (layoutScores.brandScore < 70) issues.push(`Brand score too low (${layoutScores.brandScore})`);

  // 7. No uniform generic card grid.
  if (visualDirection.serviceLayout === "grid" && copyPack.services.length >= 3) {
    issues.push("Uniform generic card grid detected");
  }

  // 8. No repeated identical service descriptions.
  const bodies = copyPack.services.map((s) => s.body.toLowerCase().trim());
  const unique = new Set(bodies);
  if (unique.size !== bodies.length) issues.push("Repeated identical service descriptions");

  // Safety gate: can we keep the hybrid output for review without it being harmful?
  const safetyIssues = issues.filter((i) =>
    /invented offer|fallback badge rendered while real logo exists|real logo not rendered|content fidelity failed|brand fidelity failed/i.test(i)
  );
  const safeToRetainHybrid = safetyIssues.length === 0;
  const passed = issues.length === 0;

  return {
    passed,
    issues,
    safeToRetainHybrid,
    safeToAutoPublish: passed,
    safeToChargePremiumCredits: passed,
    needsHumanReview: !passed && safeToRetainHybrid,
  };
}
