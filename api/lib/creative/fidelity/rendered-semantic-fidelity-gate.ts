/**
 * Rendered Semantic Fidelity Gate (WBS12E2).
 *
 * Integration-ready decision adapter over the pure WBS12E evaluator
 * (`rendered-semantic-fidelity.ts`). It exists so that wiring into a shared
 * production seam (e.g. the service.ts render-finalization boundary or the
 * dormant image-render-finalization coordinator) later becomes a single call:
 *
 *   const decision = evaluateRenderedSemanticFidelityGate({
 *     contract, approvedHeadline, rendered, mode,
 *   });
 *   if (decision.blocked) { return blockedResponse; }
 *
 * Behaviour:
 * - delegates ALL semantic judgment to `evaluateRenderedSemanticFidelity`;
 *   this module adds no rules, scores, or reason codes of its own;
 * - "observe" mode never blocks release; it records `wouldBlock` so operators
 *   can measure what enforcement would have stopped;
 * - "enforce" mode blocks release fail-closed on any failed, invalid, or
 *   unavailable evaluation (`blocked === wouldBlock`);
 * - an unrecognised runtime mode normalises to "observe" (never blocks),
 *   consistent with the repository's QUALITY_AUTHORITY_MODE convention;
 * - preserves the evaluator's reason codes verbatim in `reasonCodes`;
 * - is pure: never rewrites content, never mutates the approved contract or
 *   rendered observation, never calls providers or the database, never reads
 *   clocks or randomness — identical inputs produce identical decisions.
 *
 * This module is wired into the production render lifecycle by
 * `rendered-fidelity-production-gate.ts` (WBS12E3), which resolves the
 * dedicated RENDERED_FIDELITY_GATE_MODE runtime mode and supplies the same
 * approved authority state consumed by the rendered-quality observation
 * scope.
 */

import {
  evaluateRenderedSemanticFidelity,
  RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION,
  type EvaluateRenderedSemanticFidelityInput,
  type RenderedCreativeSemanticContent,
  type RenderedSemanticFidelityResult,
} from "./rendered-semantic-fidelity";
import type { ApprovedCreativeContract } from "../contracts/creative-contract";

export type RenderedSemanticFidelityGateMode = "observe" | "enforce";

export interface RenderedSemanticFidelityGateInput {
  /** Approved semantic intent (must be an ApprovedCreativeContract). */
  contract: ApprovedCreativeContract;
  /**
   * Optional approved headline authority (e.g. ApprovedMessagePack.copy.headline).
   * Null/absent means headline presence is not required.
   */
  approvedHeadline?: string | null;
  /** Semantic content observed on the rendered artifact. */
  rendered: RenderedCreativeSemanticContent;
  /** Gate mode. Anything other than "enforce" is treated as "observe". */
  mode: RenderedSemanticFidelityGateMode;
}

export interface RenderedSemanticFidelityGateDecision {
  /** Effective gate mode after normalisation. */
  mode: RenderedSemanticFidelityGateMode;
  /**
   * True when this decision blocks release. Always false in observe mode;
   * in enforce mode equal to `wouldBlock`.
   */
  blocked: boolean;
  /**
   * True when the fidelity evaluation failed, was invalid, or was
   * unavailable — i.e. enforcement would have blocked release.
   */
  wouldBlock: boolean;
  /** The underlying evaluation, or null when evaluation was unavailable. */
  evaluation: RenderedSemanticFidelityResult | null;
  /**
   * Evaluator failure reason codes, preserved verbatim. Empty on pass.
   * When the evaluation itself was unavailable, contains the evaluator's
   * own FIDELITY_EVALUATION_ERROR code.
   */
  reasonCodes: string[];
  contractFingerprint: string;
  evidenceSetFingerprint: string;
  evaluatorVersion: string;
}

/**
 * Evaluate the rendered semantic fidelity gate.
 *
 * Never throws: malformed input and unexpected delegate errors fail closed in
 * enforce mode while observe mode continues to record `wouldBlock`.
 */
export function evaluateRenderedSemanticFidelityGate(
  input: RenderedSemanticFidelityGateInput
): RenderedSemanticFidelityGateDecision {
  const mode: RenderedSemanticFidelityGateMode =
    input?.mode === "enforce" ? "enforce" : "observe";

  let evaluation: RenderedSemanticFidelityResult | null = null;
  try {
    // The delegate validates its own input and never throws; the catch below
    // is a defensive fail-closed backstop for the "unavailable" case only.
    evaluation = evaluateRenderedSemanticFidelity({
      contract: input?.contract,
      approvedHeadline: input?.approvedHeadline ?? null,
      rendered: input?.rendered,
    } as EvaluateRenderedSemanticFidelityInput);
  } catch {
    evaluation = null;
  }

  const wouldBlock = evaluation ? !evaluation.passed : true;
  const blocked = mode === "enforce" && wouldBlock;
  const reasonCodes = evaluation
    ? evaluation.failures.map((failure) => failure.reasonCode)
    : ["FIDELITY_EVALUATION_ERROR"];

  return {
    mode,
    blocked,
    wouldBlock,
    evaluation,
    reasonCodes,
    contractFingerprint: evaluation?.contractFingerprint ?? "",
    evidenceSetFingerprint: evaluation?.evidenceSetFingerprint ?? "",
    evaluatorVersion:
      evaluation?.evaluatorVersion ??
      RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION,
  };
}
