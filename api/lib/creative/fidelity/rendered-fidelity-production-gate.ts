/**
 * Rendered Semantic Fidelity Production Gate (WBS12E3).
 *
 * Production wiring for the accepted WBS12E2 decision adapter
 * (`rendered-semantic-fidelity-gate.ts`). It resolves the dedicated
 * `RENDERED_FIDELITY_GATE_MODE` runtime mode and evaluates the gate against
 * the same approved authority state consumed by the rendered-quality
 * observation scope — never reconstructing approval semantics manually.
 *
 * Mode (`RENDERED_FIDELITY_GATE_MODE`):
 * - unset/empty → "observe" (default shadow behaviour; never blocks);
 * - "off" → the gate is not evaluated at all (zero lifecycle impact);
 * - "observe" → the real production render is evaluated and `wouldBlock` plus
 *   the evaluator's verbatim reason codes are reported; release is never
 *   blocked and legacy behaviour is unchanged;
 * - "enforce" → a failed, invalid, or unavailable evaluation fails closed and
 *   the caller must block before permanent storage, claim completion, and
 *   billing;
 * - any unrecognised value → "observe" plus one warning (fail-safe: unknown
 *   configuration must never silently enforce).
 *
 * Unlike `QUALITY_AUTHORITY_MODE`, "enforce" is allowed here: that mode
 * carries a Phase-5 enforcement embargo, while this gate is a dedicated,
 * independently accepted stream with default shadow behaviour.
 *
 * Authority posture: the approved creative contract is compiled from the same
 * `QualityAuthorityObservationInput` the observation scope consumes, and only
 * when `isApprovedLineageAuthoritative` passes — the exact fail-closed
 * boundary the scope uses. When no authoritative approved lineage exists
 * (legacy/envelope-less requests) the gate is `not_requested` and the
 * lifecycle is identical in every mode.
 *
 * Safety: never throws (malformed input and unexpected delegate errors fail
 * closed in enforce mode); never rewrites, "fixes", regenerates, or persists
 * content; never logs or returns rendered business copy — outcomes carry only
 * machine reason codes and fingerprints. The rendered observation must be the
 * caller's real final rendered semantic values, not a pre-render
 * approximation.
 */

import {
  evaluateRenderedSemanticFidelityGate,
  type RenderedSemanticFidelityGateDecision,
} from "./rendered-semantic-fidelity-gate";
import {
  RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION,
  type RenderedCreativeSemanticContent,
  type RenderedSemanticFidelityResult,
} from "./rendered-semantic-fidelity";
import {
  compileApprovedCreativeContract,
  isApprovedLineageAuthoritative,
  type ApprovedCreativeContract,
} from "../contracts/creative-contract";
import type { QualityAuthorityObservationInput } from "../contracts/observe-quality-authority";

export type RenderedFidelityGateRuntimeMode = "off" | "observe" | "enforce";

const VALID_RUNTIME_MODES = new Set(["off", "observe", "enforce"]);

export interface RenderedFidelityGateModeResult {
  /** Raw configured value (null when unset). */
  requestedMode: string | null;
  /** Mode actually applied. Unknown values degrade to "observe". */
  effectiveMode: RenderedFidelityGateRuntimeMode;
  /** Structured warning for unrecognised values; null otherwise. */
  warning: string | null;
}

/**
 * Read RENDERED_FIDELITY_GATE_MODE. An optional explicit value overrides the
 * environment variable (test seam); omitting it reads process.env.
 */
export function getRenderedFidelityGateMode(
  explicitValue?: string
): RenderedFidelityGateModeResult {
  const raw = explicitValue !== undefined ? explicitValue : process.env.RENDERED_FIDELITY_GATE_MODE;
  const empty = !raw || raw.trim().length === 0;
  if (empty) {
    return { requestedMode: null, effectiveMode: "observe", warning: null };
  }
  const requested = raw.trim().toLowerCase();
  if (!VALID_RUNTIME_MODES.has(requested)) {
    return {
      requestedMode: requested,
      effectiveMode: "observe",
      warning: `Unknown RENDERED_FIDELITY_GATE_MODE="${raw}". Defaulting to observe (shadow).`,
    };
  }
  return { requestedMode: requested, effectiveMode: requested as RenderedFidelityGateRuntimeMode, warning: null };
}

export type RenderedFidelityProductionGateStatus =
  | "not_requested"
  | "observed"
  | "passed"
  | "blocked";

export interface RenderedFidelityProductionGateOutcome {
  status: RenderedFidelityProductionGateStatus;
  /** Effective runtime mode that produced this outcome. */
  mode: RenderedFidelityGateRuntimeMode;
  /** True only when the caller must block release (enforce + wouldBlock). */
  blocked: boolean;
  /** True when enforcement would have blocked (failed/invalid/unavailable). */
  wouldBlock: boolean;
  /** Evaluator reason codes, preserved verbatim. Empty on pass. */
  reasonCodes: string[];
  /** Set only for not_requested outcomes (e.g. off mode, non-authoritative lineage). */
  notRequestedReason: string | null;
  /** Operator-safe blocked message (reason codes only, never rendered copy). */
  message: string | null;
  modeWarning: string | null;
  contractFingerprint: string | null;
  evidenceSetFingerprint: string | null;
  evaluatorVersion: string;
  /** The underlying evaluation when one ran; null when unavailable. */
  evaluation: RenderedSemanticFidelityResult | null;
}

export interface EvaluateRenderedFidelityProductionGateInput {
  /**
   * Optional mode override (test seam). Omit to resolve
   * RENDERED_FIDELITY_GATE_MODE from the environment.
   */
  mode?: string | null;
  /**
   * Same approved-authority input consumed by the rendered-quality
   * observation scope in this request. Its lineage/funnel/CTA/offer/
   * capability fields compile the ApprovedCreativeContract; registry and
   * workflow fields are ignored here.
   */
  authority: QualityAuthorityObservationInput;
  /**
   * Exact approved headline authority for this request (the approved message
   * pack headline). Null/absent means headline presence is not required.
   */
  approvedHeadline?: string | null;
  /** Exact final rendered semantic values observed on the artifact. */
  rendered: RenderedCreativeSemanticContent;
}

const EVALUATOR_VERSION = RENDERED_SEMANTIC_FIDELITY_EVALUATOR_VERSION;

function baseOutcome(
  mode: RenderedFidelityGateRuntimeMode,
  modeWarning: string | null
): Pick<
  RenderedFidelityProductionGateOutcome,
  | "mode"
  | "blocked"
  | "wouldBlock"
  | "reasonCodes"
  | "notRequestedReason"
  | "message"
  | "modeWarning"
  | "contractFingerprint"
  | "evidenceSetFingerprint"
  | "evaluatorVersion"
  | "evaluation"
> {
  return {
    mode,
    blocked: false,
    wouldBlock: false,
    reasonCodes: [],
    notRequestedReason: null,
    message: null,
    modeWarning,
    contractFingerprint: null,
    evidenceSetFingerprint: null,
    evaluatorVersion: EVALUATOR_VERSION,
    evaluation: null,
  };
}

function unavailableOutcome(
  mode: RenderedFidelityGateRuntimeMode,
  modeWarning: string | null
): RenderedFidelityProductionGateOutcome {
  const reasonCodes = ["FIDELITY_EVALUATION_ERROR"];
  const blocked = mode === "enforce";
  return {
    status: blocked ? "blocked" : "observed",
    ...baseOutcome(mode, modeWarning),
    blocked,
    wouldBlock: true,
    reasonCodes,
    message: blocked
      ? `Rendered semantic fidelity evaluation unavailable: ${reasonCodes.join(", ")}`
      : null,
  };
}

/**
 * Evaluate the rendered semantic fidelity production gate. Never throws:
 * malformed authority input, contract compilation errors, and unexpected
 * delegate errors all fail closed in enforce mode while observe mode keeps
 * the legacy lifecycle intact.
 */
export function evaluateRenderedFidelityProductionGate(
  input: EvaluateRenderedFidelityProductionGateInput
): RenderedFidelityProductionGateOutcome {
  const modeResult = getRenderedFidelityGateMode(
    input?.mode === undefined || input?.mode === null ? undefined : input.mode
  );
  const { effectiveMode, warning } = modeResult;

  if (effectiveMode === "off") {
    return {
      status: "not_requested",
      ...baseOutcome("off", warning),
      notRequestedReason: "gate_mode_off",
    };
  }

  // Authority posture: identical to the rendered-quality observation scope —
  // no approved authority means the gate does not apply (legacy/envelope-less
  // requests keep their established behaviour in every mode).
  const authority = input?.authority ?? (null as unknown as QualityAuthorityObservationInput);
  const lineage = authority?.lineage ?? null;
  const campaignId = Number(authority?.campaignId ?? 0);
  const userId = Number(authority?.userId ?? 0);
  const expectedFingerprint =
    authority?.expectedApprovedStrategyFingerprint ??
    lineage?.approvedStrategyFingerprint ??
    null;
  const authorityCheck = isApprovedLineageAuthoritative(
    lineage,
    campaignId,
    userId,
    expectedFingerprint
  );
  if (!lineage || !authorityCheck.authoritative) {
    return {
      status: "not_requested",
      ...baseOutcome(effectiveMode, warning),
      notRequestedReason: `lineage_not_authoritative:${authorityCheck.reason ?? "missing_lineage"}`,
    };
  }

  // Compile the same approved contract the observation scope compiles for
  // this request — never reconstructing approval semantics manually.
  let contract: ApprovedCreativeContract | null = null;
  try {
    contract = compileApprovedCreativeContract({
      campaignId: lineage.campaignId,
      userId: lineage.userId,
      businessId: authority.businessId,
      businessName: authority.businessName ?? null,
      strategyRunId: lineage.strategyRunId,
      approvalRequestId: lineage.approvalRequestId,
      approvedAt: lineage.approvedAt,
      approvedStrategyFingerprint: lineage.approvedStrategyFingerprint,
      funnelStage: authority.funnelStage,
      stageCtas: authority.stageCtas,
      campaignWideCta: authority.campaignWideCta,
      campaignInputCta: authority.campaignInputCta,
      offerActionCta: authority.offerActionCta,
      aiDelegated: authority.aiDelegated,
      targetAudience: authority.targetAudience,
      offer: authority.offer,
      offerRequired: authority.offerRequired,
      businessCapabilities: authority.businessCapabilities,
      requiredBenefitCount: authority.requiredBenefitCount,
      brandConstraints: authority.brandConstraints,
      requiredContactDetails: authority.requiredContactDetails,
      prohibitedClaims: authority.prohibitedClaims,
    });
  } catch {
    contract = null;
  }

  let decision: RenderedSemanticFidelityGateDecision | null = null;
  try {
    decision = evaluateRenderedSemanticFidelityGate({
      contract: (contract ?? undefined) as ApprovedCreativeContract,
      approvedHeadline: input?.approvedHeadline ?? null,
      rendered: input?.rendered,
      mode: effectiveMode === "enforce" ? "enforce" : "observe",
    });
  } catch {
    decision = null;
  }

  if (!decision) {
    return unavailableOutcome(effectiveMode, warning);
  }

  const shared = {
    ...baseOutcome(effectiveMode, warning),
    wouldBlock: decision.wouldBlock,
    reasonCodes: decision.reasonCodes,
    contractFingerprint: decision.contractFingerprint ?? null,
    evidenceSetFingerprint: decision.evidenceSetFingerprint ?? null,
    evaluatorVersion: decision.evaluatorVersion ?? EVALUATOR_VERSION,
    evaluation: decision.evaluation,
  };

  if (decision.blocked) {
    return {
      status: "blocked",
      ...shared,
      blocked: true,
      message: `Rendered semantic fidelity gate failed: ${decision.reasonCodes.join(", ")}`,
    };
  }

  if (effectiveMode === "enforce") {
    return { status: "passed", ...shared };
  }

  return { status: "observed", ...shared };
}
