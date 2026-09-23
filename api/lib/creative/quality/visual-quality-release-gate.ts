/**
 * WBS12F2 – Integration-ready Visual-Quality Release Gate.
 *
 * Narrow integration layer over the WBS12F deterministic visual-evaluation
 * contract. It adds only lifecycle semantics (observe vs enforce) on top of
 * the existing contract evaluation — no scoring is reimplemented here:
 * failed dimensions, reason codes, total score and provenance are passed
 * through verbatim from `evaluateVisualQualityContract`.
 *
 * Semantics:
 * - "observe": never blocks the production lifecycle; records whether
 *   enforcement would have blocked (`wouldBlock`) for shadow rollout.
 * - "enforce": blocks whenever the visual contract verdict is not "passed",
 *   including "insufficient_evidence" (fail-closed).
 *
 * Guarantees:
 * - pure and deterministic: identical inputs produce an identical decision
 *   (no clock, no randomness, no I/O); the decision object is frozen;
 * - never reads, modifies or rewrites approved semantic copy (no copy-text
 *   inputs exist at the type level);
 * - never calls OpenAI, the database, the filesystem or providers;
 * - deterministic render evidence stays authoritative; vision evidence is
 *   consumed only through the existing adapter/merge policy. A raw
 *   `VisionCriticResult` may be passed for convenience and is adapted via
 *   `adaptVisionCriticEvidence`; caller-supplied adapted vision evidence
 *   takes precedence over the raw critic.
 *
 * Later production wiring (premium-design-contract.ts / variant-selector.ts /
 * hybrid-pipeline.ts) only needs to call `evaluateVisualQualityReleaseGate`
 * with evidence already in scope at those seams.
 */

import {
  VISUAL_EVALUATION_CONTRACT_VERSION,
  evaluateVisualQualityContract,
  type VisualDimensionEvaluation,
  type VisualDimensionEvidenceProvenance,
  type VisualDimensionId,
  type VisualEvaluationEvidenceInput,
  type VisualQualityContractResult,
} from "./visual-evaluation-contract";
import { adaptVisionCriticEvidence } from "./vision-critic-evidence-adapter";
import type { VisionCriticResult } from "../premium-v2/pipeline-types";

export const VISUAL_QUALITY_RELEASE_GATE_VERSION =
  "wbs12f2.visual-quality-release-gate.v1";

export type VisualQualityReleaseGateMode = "observe" | "enforce";

export interface VisualQualityReleaseGateInput {
  mode: VisualQualityReleaseGateMode;
  /** Existing WBS12F contract evidence (deterministic streams + adapted vision). */
  evidence: VisualEvaluationEvidenceInput;
  /**
   * Optional raw vision-critic result, adapted through
   * `adaptVisionCriticEvidence` only when `evidence.vision` is not supplied.
   */
  critic?: VisionCriticResult | null;
}

export interface VisualQualityReleaseGateDecision {
  gateVersion: string;
  mode: VisualQualityReleaseGateMode;
  /** Version of the visual evaluation contract that produced `evaluation`. */
  evaluatorVersion: string;
  /** Full, unmodified WBS12F contract result. */
  evaluation: VisualQualityContractResult;
  /** True whenever the contract verdict is not "passed" (failed or insufficient evidence). */
  wouldBlock: boolean;
  /** True only in enforce mode when the gate blocks the release. */
  blocked: boolean;
  /** Exact failed-dimension evaluations from the visual contract (below-threshold dimensions). */
  failedDimensions: VisualDimensionEvaluation[];
  /** Dimensions that had no usable evidence (fail-closed in enforce mode). */
  insufficientDimensions: VisualDimensionId[];
  /**
   * Deterministic reason codes: gate semantics first
   * (GATE_VERSION / GATE_MODE_* / GATE_WOULD_* / GATE_*_BLOCKED), followed by
   * the visual contract's reason codes verbatim.
   */
  reasonCodes: string[];
  /** Weighted normalized score from the visual contract; null while evidence is insufficient. */
  totalScore: number | null;
  /** Per-dimension provenance exactly as exposed by the visual contract. */
  evidenceProvenance: Record<VisualDimensionId, VisualDimensionEvidenceProvenance>;
}

const VALID_MODES: readonly VisualQualityReleaseGateMode[] = ["observe", "enforce"];

function buildEvidenceProvenance(
  evaluation: VisualQualityContractResult
): Record<VisualDimensionId, VisualDimensionEvidenceProvenance> {
  const provenance = {} as Record<VisualDimensionId, VisualDimensionEvidenceProvenance>;
  for (const dimension of evaluation.dimensions) {
    provenance[dimension.dimensionId] = dimension.provenance;
  }
  return provenance;
}

/**
 * Evaluates the visual-quality release gate. Pure and deterministic:
 * identical inputs always produce an identical (deep-equal) decision.
 */
export function evaluateVisualQualityReleaseGate(
  input: VisualQualityReleaseGateInput
): VisualQualityReleaseGateDecision {
  const mode = input?.mode;
  if (!VALID_MODES.includes(mode)) {
    throw new Error(
      `Invalid visual-quality release gate mode: ${String(mode)}. Expected "observe" or "enforce".`
    );
  }

  const evidence: VisualEvaluationEvidenceInput = {
    ...(input.evidence ?? {}),
    vision:
      input.evidence?.vision ??
      (input.critic ? adaptVisionCriticEvidence(input.critic) : undefined),
  };

  const evaluation = evaluateVisualQualityContract(evidence);
  const wouldBlock = evaluation.verdict !== "passed";
  const blocked = mode === "enforce" && wouldBlock;

  const reasonCodes = [
    `GATE_VERSION_${VISUAL_QUALITY_RELEASE_GATE_VERSION}`,
    `GATE_MODE_${mode.toUpperCase()}`,
    wouldBlock ? "GATE_WOULD_BLOCK" : "GATE_WOULD_PASS",
    blocked ? "GATE_ENFORCE_BLOCKED" : "GATE_NOT_BLOCKED",
    ...evaluation.reasonCodes,
  ];

  return Object.freeze({
    gateVersion: VISUAL_QUALITY_RELEASE_GATE_VERSION,
    mode,
    evaluatorVersion: VISUAL_EVALUATION_CONTRACT_VERSION,
    evaluation,
    wouldBlock,
    blocked,
    failedDimensions: evaluation.failedDimensions,
    insufficientDimensions: evaluation.insufficientDimensions,
    reasonCodes,
    totalScore: evaluation.normalizedScore,
    evidenceProvenance: buildEvidenceProvenance(evaluation),
  });
}
