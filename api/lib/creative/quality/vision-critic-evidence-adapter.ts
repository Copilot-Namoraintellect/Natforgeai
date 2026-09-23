/**
 * WBS12F – Narrow adapter from existing vision-critic evidence to the
 * normalized visual-evaluation contract.
 *
 * The premium-v2 vision critic (`../premium-v2/vision-critic`) already
 * observes the rendered leaflet with a vision model and returns a
 * `VisionCriticResult`. This module maps those existing scores onto the
 * contract's normalized dimensions so the contract can corroborate or, only
 * where deterministic evidence is unavailable, fill a dimension. It adds no
 * new observation of its own: mapping is pure, deterministic and read-only.
 *
 * Mapping (higher is always better; the contract's genericTemplateRisk is a
 * risk score, so it is inverted before entering the contract):
 * - visual_hierarchy      <- scores.visualHierarchy
 * - layout_balance        <- mean(scores.visualHierarchy, scores.CTAVisibility)
 * - brand_consistency     <- mean(scores.brandFidelity, scores.logoUsage)
 * - image_quality         <- not observed by the critic (unmapped)
 * - typography            <- scores.readability
 * - readability_contrast  <- scores.readability
 * - professional_finish   <- mean(scores.premiumFeel, 100 - genericTemplateRisk)
 *
 * When the critic is unavailable (OpenAI failure/quota), every dimension is
 * reported unobserved so the contract fails closed instead of inheriting the
 * critic's permissive 50s.
 */

import type { VisionCriticResult } from "../premium-v2/pipeline-types";
import {
  VISUAL_DIMENSION_IDS,
  type AdaptedVisionDimension,
  type AdaptedVisionEvidence,
  type VisualDimensionId,
} from "./visual-evaluation-contract";

export const VISION_CRITIC_ADAPTER_VERSION = "wbs12f.vision-critic-adapter.v1";

function clampScore(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value)));
}

function unobservedDimensions(): Record<VisualDimensionId, AdaptedVisionDimension> {
  const dimensions = {} as Record<VisualDimensionId, AdaptedVisionDimension>;
  for (const dimensionId of VISUAL_DIMENSION_IDS) {
    dimensions[dimensionId] = { score: null, observed: false };
  }
  return dimensions;
}

/**
 * Adapts an existing `VisionCriticResult` into contract-ready evidence.
 * Accepts null/undefined (treated as unavailable) and never throws.
 */
export function adaptVisionCriticEvidence(
  critic: VisionCriticResult | null | undefined
): AdaptedVisionEvidence {
  if (!critic || critic.unavailable === true) {
    return {
      version: VISION_CRITIC_ADAPTER_VERSION,
      available: false,
      unavailableReason: critic?.criticalIssues?.[0] ?? "vision_critic_result_missing",
      dimensions: unobservedDimensions(),
    };
  }

  const scores = critic.scores ?? ({} as VisionCriticResult["scores"]);
  const valueOf = (value: unknown): number | null =>
    typeof value === "number" && Number.isFinite(value) ? clampScore(value) : null;

  const visualHierarchy = valueOf(scores.visualHierarchy);
  const ctaVisibility = valueOf(scores.CTAVisibility);
  const brandFidelity = valueOf(scores.brandFidelity);
  const logoUsage = valueOf(scores.logoUsage);
  const readability = valueOf(scores.readability);
  const premiumFeel = valueOf(scores.premiumFeel);
  const genericTemplateRisk = valueOf(scores.genericTemplateRisk);

  const dimensions = unobservedDimensions();

  if (visualHierarchy !== null) {
    dimensions.visual_hierarchy = { score: visualHierarchy, observed: true };
  }

  if (visualHierarchy !== null && ctaVisibility !== null) {
    dimensions.layout_balance = {
      score: clampScore((visualHierarchy + ctaVisibility) / 2),
      observed: true,
    };
  }

  if (brandFidelity !== null && logoUsage !== null) {
    dimensions.brand_consistency = {
      score: clampScore((brandFidelity + logoUsage) / 2),
      observed: true,
    };
  } else if (brandFidelity !== null) {
    dimensions.brand_consistency = { score: brandFidelity, observed: true };
  }

  if (readability !== null) {
    dimensions.typography = { score: readability, observed: true };
    dimensions.readability_contrast = { score: readability, observed: true };
  }

  if (premiumFeel !== null && genericTemplateRisk !== null) {
    dimensions.professional_finish = {
      score: clampScore((premiumFeel + (100 - genericTemplateRisk)) / 2),
      observed: true,
    };
  } else if (premiumFeel !== null) {
    dimensions.professional_finish = { score: premiumFeel, observed: true };
  }

  return {
    version: VISION_CRITIC_ADAPTER_VERSION,
    available: true,
    unavailableReason: null,
    dimensions,
  };
}
