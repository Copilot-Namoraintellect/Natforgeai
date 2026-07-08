/**
 * Premium Leaflet Hybrid Pipeline – Deterministic Layout Scoring.
 *
 * Computes local design-quality metrics from the rendered diagnostics, visual
 * direction and cleaned copy pack before relying on the OpenAI vision critic.
 */

import type { HybridRenderMetrics, PremiumCopyPack, VisualDirection } from "./pipeline-types";
import type { CopyQualityResult } from "./copy-quality";
import type { ContentFidelityResult } from "./content-fidelity";

export interface LayoutScoreResult {
  layoutScore: number;
  ctaDominanceScore: number;
  hierarchyScore: number;
  templateRiskScore: number;
  copyScore: number;
  brandScore: number;
}

interface ScoreInputs {
  metrics: HybridRenderMetrics | undefined;
  visualDirection: VisualDirection;
  copyPack: PremiumCopyPack;
  copyQuality: CopyQualityResult;
  contentFidelity: ContentFidelityResult | undefined;
  realLogoExpected: boolean;
}

function clamp(n: number): number {
  return Math.max(0, Math.min(100, Math.round(n)));
}

function scoreBrand({ metrics, realLogoExpected }: ScoreInputs): number {
  if (!realLogoExpected) return 80;
  if (!metrics) return 40;
  if (!metrics.realLogoRendered || metrics.fallbackBadgeRendered) return 30;
  if (metrics.logoMaskedOrCropped) return 50;
  const logoHeight = metrics.logoRenderedHeight ?? 0;
  const logoArea = metrics.logoVisibleArea ?? 0;
  const sizeScore = logoHeight >= 70 ? 100 : logoHeight >= 55 ? 90 : logoHeight >= 40 ? 70 : 40;
  const areaScore = logoArea >= 8000 ? 100 : logoArea >= 4000 ? 85 : 60;
  return clamp((sizeScore + areaScore) / 2);
}

function scoreCopy({ copyQuality, contentFidelity }: ScoreInputs): number {
  let score = copyQuality.copyQualityScore ?? 100;
  if (contentFidelity?.inventedOfferDetected) score -= 40;
  if (!contentFidelity?.contentFidelityPassed) score -= 20;
  return clamp(score);
}

function scoreCtaDominance({ visualDirection, copyPack }: ScoreInputs): number {
  let score = 60;
  switch (visualDirection.ctaTreatment) {
    case "block_banner":
      score = 100;
      break;
    case "solid_button":
      score = 80;
      break;
    case "rounded_pill":
      score = 70;
      break;
    case "outline_button":
      score = 55;
      break;
  }
  switch (visualDirection.density) {
    case "minimal":
      score += 5;
      break;
    case "dense":
      score -= 10;
      break;
  }
  if (/^(get in touch|contact today|request a quote|visit us today|book a consultation)/i.test(copyPack.cta)) {
    score += 5;
  }
  return clamp(score);
}

function scoreHierarchy({ visualDirection, copyPack }: ScoreInputs): number {
  let score = 70;
  switch (visualDirection.heroTreatment) {
    case "shape_accent":
    case "solid_brand_block":
      score += 10;
      break;
    case "minimal_centered":
      score -= 10;
      break;
  }
  if (visualDirection.serviceLayout === "featured" || visualDirection.serviceLayout === "split") {
    score += 15;
  } else if (visualDirection.serviceLayout === "grid") {
    score -= 10;
  }
  if (visualDirection.density === "minimal") score += 10;
  if (visualDirection.density === "dense") score -= 15;
  if (copyPack.headline.split(/\s+/).length >= 3 && copyPack.headline.split(/\s+/).length <= 10) score += 5;
  if (copyPack.services.length <= 2) score += 10;
  if (copyPack.proofPoints.length >= 2) score += 5;
  return clamp(score);
}

function scoreTemplateRisk({ visualDirection, copyPack, copyQuality }: ScoreInputs): number {
  let risk = 50;
  if (visualDirection.serviceLayout === "grid" && copyPack.services.length >= 3) risk += 30;
  if (visualDirection.serviceLayout === "featured" || visualDirection.serviceLayout === "split") risk -= 25;
  if (visualDirection.density === "dense") risk += 15;
  if (visualDirection.density === "minimal") risk -= 10;
  if (copyPack.services.length <= 2) risk -= 15;
  if (copyQuality.copyQualityIssues.some((i) => /repeated|generic|orphan/i.test(i))) risk += 15;
  return clamp(risk);
}

export function scoreLayout(inputs: ScoreInputs): LayoutScoreResult {
  const brandScore = scoreBrand(inputs);
  const copyScore = scoreCopy(inputs);
  const ctaDominanceScore = scoreCtaDominance(inputs);
  const hierarchyScore = scoreHierarchy(inputs);
  const templateRiskScore = scoreTemplateRisk(inputs);
  const layoutScore = clamp(
    (brandScore + copyScore + ctaDominanceScore + hierarchyScore + (100 - templateRiskScore)) / 5
  );
  return { layoutScore, ctaDominanceScore, hierarchyScore, templateRiskScore, copyScore, brandScore };
}
