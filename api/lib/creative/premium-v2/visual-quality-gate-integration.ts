/**
 * WBS12F3 – Visual-quality release gate integration helpers (premium-v2 seam).
 *
 * Maps evidence that is already in scope at the premium hybrid decision seam
 * (variant-selector / premium-design-contract) onto the WBS12F
 * visual-evaluation contract input. This adds no rendering pipeline, no
 * provider call and no new observation: the hybrid renderer's brand-asset
 * diagnostics, the resolved brand kit palette and the chosen visual direction
 * are simply restructured into contract evidence.
 *
 * Evidence boundaries:
 * - render geometry (ctaBoundingBox, font sizes, content heights) is NOT
 *   fabricated: the hybrid HTML renderer does not emit geometry metrics, so
 *   geometry-backed dimensions stay unevaluated unless the existing vision
 *   critic (adapted via adaptVisionCriticEvidence) can fill them;
 * - semantic copy (headlines, body, CTA wording, claims) is never read,
 *   copied or evaluated here — semantic fidelity belongs to WBS12E;
 * - the vision critic is never invoked from this module; callers pass the
 *   already-fetched VisionCriticResult to the release gate, which adapts it
 *   through adaptVisionCriticEvidence only.
 */

import type {
  HybridBrandKit,
  HybridRenderMetrics,
  VisualDirection,
} from "./pipeline-types";
import type { VisualEvaluationEvidenceInput } from "../quality/visual-evaluation-contract";
import {
  evaluateVisualQualityReleaseGate,
  type VisualQualityReleaseGateDecision,
  type VisualQualityReleaseGateMode,
} from "../quality/visual-quality-release-gate";
import { getConfiguredVisualQualityGateMode } from "../quality/visual-quality-gate-mode";
import type { VisionCriticResult } from "./pipeline-types";

/**
 * Build WBS12F contract evidence from the evidence already in scope at the
 * premium hybrid seam. Pure and deterministic; never reads semantic copy and
 * never calls providers.
 */
export function buildVisualQualityEvidenceInput(input: {
  metrics: HybridRenderMetrics | undefined;
  brandKit: HybridBrandKit | undefined;
  visualDirection: VisualDirection | undefined;
}): VisualEvaluationEvidenceInput {
  return {
    // The hybrid renderer emits brand-asset render diagnostics, not geometry.
    brandRenderDiagnostics: input.metrics ?? null,
    palette: input.brandKit ?? null,
    visualDirection: input.visualDirection ?? null,
    renderMetrics: null,
  };
}

export interface EvaluateVisualQualityGateAtSeamInput {
  /**
   * Optional explicit mode override. When omitted, the configured
   * VISUAL_QUALITY_GATE_MODE is resolved at call time (default "observe").
   */
  mode?: VisualQualityReleaseGateMode;
  metrics: HybridRenderMetrics | undefined;
  brandKit: HybridBrandKit | undefined;
  visualDirection: VisualDirection | undefined;
  /** Already-fetched vision critic result; adapted, never re-invoked. */
  critic: VisionCriticResult | null;
}

/**
 * Evaluate the WBS12F visual-quality release gate at the premium hybrid seam
 * using only evidence already in scope. The vision critic result is passed
 * through to the gate, which adapts it via adaptVisionCriticEvidence; no
 * additional provider call is made here.
 */
export function evaluateVisualQualityGateAtSeam(
  input: EvaluateVisualQualityGateAtSeamInput
): VisualQualityReleaseGateDecision {
  const mode = input.mode ?? getConfiguredVisualQualityGateMode();
  return evaluateVisualQualityReleaseGate({
    mode,
    evidence: buildVisualQualityEvidenceInput({
      metrics: input.metrics,
      brandKit: input.brandKit,
      visualDirection: input.visualDirection,
    }),
    critic: input.critic,
  });
}
