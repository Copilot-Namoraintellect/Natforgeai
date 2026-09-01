/**
 * Premium Candidate Selection.
 *
 * Slice 4 scope:
 * - compile three design direction plans from the approved contract;
 * - evaluate each supplied candidate against its paired direction plan under the
 *   hard-compliance veto and the premium rubric;
 * - separate pre-render readiness (recommendedForRenderCandidateId) from final
 *   premium acceptance (selectedCandidateId);
 * - recommend the highest-ranked ready-for-render candidate before rendered
 *   evidence is available;
 * - select a final candidate only when premiumAcceptanceStatus is "accepted";
 * - apply dimension floors and the 80% overall threshold only for final acceptance;
 * - rank candidates with deterministic tie-breakers;
 * - return one selected candidate, one recommended-for-render candidate, or an
 *   explicit no-selection result;
 * - never fabricate provider generations, rendered outputs or artificial candidates.
 *
 * Provider-free and observation-only.
 */

import { createHash } from "crypto";
import type { ApprovedCreativeContract } from "../contracts/creative-contract";
import type { ProposedCreativeContent } from "../compliance/content-compliance";
import { evaluateContentCompliance } from "../compliance/content-compliance";
import {
  compileDirectionPlans,
  type CreativeDirectionKey,
  type CreativeDirectionPlan,
  type DirectionPlannerResult,
} from "./creative-direction-planner";
import {
  evaluatePremiumCandidate,
  type PremiumQualityResult,
  type RenderedCreativeEvidence,
  RUBRIC_VERSION,
} from "./premium-rubric";

export const SELECTOR_VERSION = "slice4.candidate-selector.v1";

export interface CandidateSpecification {
  candidateId: string;
  candidateOrdinal: number;
  candidate: ProposedCreativeContent;
  directionKey: CreativeDirectionKey;
  directionPlan?: CreativeDirectionPlan;
}

export interface CandidateIdentityInput {
  workflowOperationId: string;
  contractFingerprint: string;
  directionFingerprint: string;
  candidateOrdinal: number;
  contentFingerprint: string;
}

export interface SelectPremiumCandidateInput {
  workflowOperationId: string;
  contract: ApprovedCreativeContract;
  candidateEntries: CandidateSpecification[];
  renderedEvidenceByCandidateId?: Partial<Record<string, RenderedCreativeEvidence>>;
}

export type SelectionStatus =
  | "selected"
  | "no_qualifying_candidate"
  | "render_evaluation_required"
  | "insufficient_candidates"
  | "stale_contract"
  | "ambiguous_tie_rejected";

export interface SelectPremiumCandidateResult {
  selectionStatus: SelectionStatus;
  selectedCandidateId: string | null;
  selectedDirectionKey: CreativeDirectionKey | null;
  selectedCandidateScore: number | null;
  selectedEvaluation: PremiumQualityResult | null;
  /** Highest-ranked candidate that is ready_for_render; null when none qualify. */
  recommendedForRenderCandidateId: string | null;
  /** Pre-render readiness score of the recommended-for-render candidate. */
  recommendedForRenderScore: number | null;
  candidateEvaluations: PremiumQualityResult[];
  selectionReasonCodes: string[];
  selectionFingerprint: string;
  directionPlanFingerprint: string;
  plannedDirectionCount: number;
  availableDirectionCount: number;
  observedCandidateCount: number;
  eligibleCandidateCount: number;
  hardRejectedCandidateCount: number;
  thresholdRejectedCandidateCount: number;
  renderPendingCandidateCount: number;
  unavailableDirectionCodes: string[];
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

export function buildCandidateContentFingerprint(candidate: ProposedCreativeContent): string {
  const payload = {
    headline: candidate.headline,
    primaryText: candidate.primaryText,
    benefits: candidate.benefits.slice().sort(),
    cta: candidate.cta,
    funnelStage: candidate.funnelStage,
    targetAudience: candidate.targetAudience,
    offer: candidate.offer,
    businessName: candidate.businessName,
    protectedFields: candidate.protectedFields,
    requiredContactDetails: (candidate.requiredContactDetails ?? []).slice().sort(),
  };
  return sha256(canonicalize(payload));
}

export function buildCandidateId(input: CandidateIdentityInput): string {
  const payload = {
    workflowOperationId: input.workflowOperationId,
    contractFingerprint: input.contractFingerprint,
    directionFingerprint: input.directionFingerprint,
    candidateOrdinal: input.candidateOrdinal,
    contentFingerprint: input.contentFingerprint,
  };
  return sha256(canonicalize(payload));
}

export function buildEvaluationFingerprint(
  candidateId: string,
  rubricVersion: string,
  directionFingerprint: string,
  contractFingerprint: string
): string {
  const payload = {
    candidateId,
    rubricVersion,
    directionFingerprint,
    contractFingerprint,
  };
  return sha256(canonicalize(payload));
}

export function buildSelectionFingerprint(
  workflowOperationId: string,
  contractFingerprint: string,
  orderedCandidateEvaluationFingerprints: string[],
  selectorVersion: string
): string {
  const payload = {
    workflowOperationId,
    contractFingerprint,
    orderedCandidateEvaluationFingerprints,
    selectorVersion,
  };
  return sha256(canonicalize(payload));
}

function findDirectionPlan(
  directionKey: CreativeDirectionKey,
  directions: CreativeDirectionPlan[]
): CreativeDirectionPlan | undefined {
  return directions.find((d) => d.directionKey === directionKey);
}

function getDimensionScore(
  evaluation: PremiumQualityResult,
  dimensionId: string
): number {
  return evaluation.dimensionResults.find((d) => d.dimensionId === dimensionId)?.score ?? 0;
}

type ScoreAccessor = (evaluation: PremiumQualityResult) => number;

function compareCandidates(
  a: PremiumQualityResult,
  b: PremiumQualityResult,
  ordinalByCandidateId: Map<string, number>,
  getPrimaryScore: ScoreAccessor
): number {
  // Tie-break order:
  // 1. Higher primary score
  const primaryA = getPrimaryScore(a);
  const primaryB = getPrimaryScore(b);
  if (primaryA !== primaryB) {
    return primaryB - primaryA;
  }

  // 2. Higher strategic-alignment score
  const strategicA = getDimensionScore(a, "strategic_alignment");
  const strategicB = getDimensionScore(b, "strategic_alignment");
  if (strategicA !== strategicB) {
    return strategicB - strategicA;
  }

  // 3. Higher CTA score
  const ctaA = getDimensionScore(a, "cta_prominence_and_action_clarity");
  const ctaB = getDimensionScore(b, "cta_prominence_and_action_clarity");
  if (ctaA !== ctaB) {
    return ctaB - ctaA;
  }

  // 4. Higher grounded-persuasive-strength score
  const groundedA = getDimensionScore(a, "grounded_persuasive_strength");
  const groundedB = getDimensionScore(b, "grounded_persuasive_strength");
  if (groundedA !== groundedB) {
    return groundedB - groundedA;
  }

  // 5. Lower candidate ordinal
  const ordinalA = ordinalByCandidateId.get(a.candidateId) ?? Number.MAX_SAFE_INTEGER;
  const ordinalB = ordinalByCandidateId.get(b.candidateId) ?? Number.MAX_SAFE_INTEGER;
  if (ordinalA !== ordinalB) {
    return ordinalA - ordinalB;
  }

  // 6. Lexicographically smaller candidateId
  if (a.candidateId !== b.candidateId) {
    return a.candidateId.localeCompare(b.candidateId);
  }

  return 0;
}

function getFinalPremiumScore(evaluation: PremiumQualityResult): number {
  return evaluation.finalPremiumScore ?? 0;
}

function getPreRenderReadinessScore(evaluation: PremiumQualityResult): number {
  return evaluation.preRenderReadinessScore ?? 0;
}

export function selectPremiumCandidate(
  input: SelectPremiumCandidateInput
): SelectPremiumCandidateResult {
  const { workflowOperationId, contract, candidateEntries } = input;

  // Compile direction plans.
  const directionPlans = compileDirectionPlans({
    workflowOperationId,
    contract,
  });

  // If the contract itself is stale/unapproved, no candidate can be selected.
  if (contract.kind !== "approved" || !contract.approvedAt) {
    return buildSelectionResult({
      directionPlans,
      candidateEvaluations: [],
      selectionStatus: "stale_contract",
      selectionReasonCodes: ["CONTRACT_NOT_AUTHORITATIVE"],
      workflowOperationId,
      contractFingerprint: contract.contractFingerprint,
    });
  }

  if (candidateEntries.length === 0) {
    return buildSelectionResult({
      directionPlans,
      candidateEvaluations: [],
      selectionStatus: "insufficient_candidates",
      selectionReasonCodes: ["NO_CANDIDATE_ENTRIES"],
      workflowOperationId,
      contractFingerprint: contract.contractFingerprint,
    });
  }

  const candidateEvaluations: PremiumQualityResult[] = [];

  for (const entry of candidateEntries) {
    const directionPlan =
      entry.directionPlan ?? findDirectionPlan(entry.directionKey, directionPlans.directions);
    if (!directionPlan || !directionPlan.available) {
      // Direction unavailable; candidate cannot be evaluated under this plan.
      candidateEvaluations.push(createUnavailableDirectionResult(entry, directionPlan));
      continue;
    }

    // Run hard compliance for this candidate.
    const complianceResult = evaluateContentCompliance({
      contract,
      proposed: entry.candidate,
    });

    const evaluation = evaluatePremiumCandidate({
      candidateId: entry.candidateId,
      candidate: entry.candidate,
      directionPlan,
      contract,
      complianceResult,
      renderedEvidence: input.renderedEvidenceByCandidateId?.[entry.candidateId] ?? null,
    });

    candidateEvaluations.push(evaluation);
  }

  // Build a lookup from candidateId to caller-supplied ordinal for tie-breaking.
  const ordinalByCandidateId = new Map<string, number>();
  for (const entry of candidateEntries) {
    ordinalByCandidateId.set(entry.candidateId, entry.candidateOrdinal);
  }

  // Separate final-accepted candidates from pre-render-ready candidates.
  const accepted = candidateEvaluations.filter(
    (e) => e.premiumAcceptanceStatus === "accepted"
  );
  const readyForRender = candidateEvaluations.filter(
    (e) => e.preRenderReadinessStatus === "ready_for_render"
  );

  if (accepted.length > 0) {
    const ranked = accepted
      .slice()
      .sort((a, b) => compareCandidates(a, b, ordinalByCandidateId, getFinalPremiumScore));

    // Detect unresolved tie after all tie-breakers.
    const top = ranked[0];
    const next = ranked[1];
    if (next && compareCandidates(top, next, ordinalByCandidateId, getFinalPremiumScore) === 0) {
      return buildSelectionResult({
        directionPlans,
        candidateEvaluations,
        selectionStatus: "ambiguous_tie_rejected",
        selectionReasonCodes: ["AMBIGUOUS_TIE_AFTER_AUTHORIZED_TIEBREAKERS"],
        workflowOperationId,
        contractFingerprint: contract.contractFingerprint,
      });
    }

    const selectedEntry = candidateEntries.find((e) => e.candidateId === top.candidateId);
    const selectedDirectionPlan = selectedEntry
      ? findDirectionPlan(selectedEntry.directionKey, directionPlans.directions)
      : undefined;

    // The top accepted candidate is always ready_for_render, so it is also the
    // recommended-for-render candidate when no better pre-render score exists.
    // Rank ready candidates by pre-render score to populate the recommendation field.
    const rankedReady = readyForRender
      .slice()
      .sort((a, b) =>
        compareCandidates(a, b, ordinalByCandidateId, getPreRenderReadinessScore)
      );
    const topReady = rankedReady[0];

    return buildSelectionResult({
      directionPlans,
      candidateEvaluations,
      selectionStatus: "selected",
      selectionReasonCodes: ["HIGHEST_RANKED_ELIGIBLE_CANDIDATE"],
      selectedCandidateId: top.candidateId,
      selectedDirectionKey: selectedDirectionPlan?.directionKey ?? null,
      selectedCandidateScore: top.finalPremiumScore,
      selectedEvaluation: top,
      recommendedForRenderCandidateId: topReady?.candidateId ?? top.candidateId,
      recommendedForRenderScore: topReady?.preRenderReadinessScore ?? top.preRenderReadinessScore,
      workflowOperationId,
      contractFingerprint: contract.contractFingerprint,
    });
  }

  if (readyForRender.length > 0) {
    const ranked = readyForRender
      .slice()
      .sort((a, b) =>
        compareCandidates(a, b, ordinalByCandidateId, getPreRenderReadinessScore)
      );

    const top = ranked[0];
    const next = ranked[1];
    if (next && compareCandidates(top, next, ordinalByCandidateId, getPreRenderReadinessScore) === 0) {
      return buildSelectionResult({
        directionPlans,
        candidateEvaluations,
        selectionStatus: "ambiguous_tie_rejected",
        selectionReasonCodes: ["AMBIGUOUS_TIE_AFTER_AUTHORIZED_TIEBREAKERS"],
        workflowOperationId,
        contractFingerprint: contract.contractFingerprint,
      });
    }

    return buildSelectionResult({
      directionPlans,
      candidateEvaluations,
      selectionStatus: "render_evaluation_required",
      selectionReasonCodes: ["ALL_ELIGIBLE_CANDIDATES_PENDING_RENDER"],
      recommendedForRenderCandidateId: top.candidateId,
      recommendedForRenderScore: top.preRenderReadinessScore,
      workflowOperationId,
      contractFingerprint: contract.contractFingerprint,
    });
  }

  // No candidates are ready for render.
  const anyHardFailed = candidateEvaluations.some((e) => !e.hardCompliancePassed);
  const reasonCodes: string[] = anyHardFailed
    ? ["ALL_CANDIDATES_FAILED_HARD_COMPLIANCE"]
    : ["NO_CANDIDATE_MET_PREMIUM_THRESHOLD"];

  return buildSelectionResult({
    directionPlans,
    candidateEvaluations,
    selectionStatus: "no_qualifying_candidate",
    selectionReasonCodes: reasonCodes,
    workflowOperationId,
    contractFingerprint: contract.contractFingerprint,
  });
}

interface BuildSelectionResultArgs {
  directionPlans: DirectionPlannerResult;
  candidateEvaluations: PremiumQualityResult[];
  selectionStatus: SelectionStatus;
  selectionReasonCodes: string[];
  selectedCandidateId?: string | null;
  selectedDirectionKey?: CreativeDirectionKey | null;
  selectedCandidateScore?: number | null;
  selectedEvaluation?: PremiumQualityResult | null;
  recommendedForRenderCandidateId?: string | null;
  recommendedForRenderScore?: number | null;
  workflowOperationId: string;
  contractFingerprint: string;
}

function buildSelectionResult(
  args: BuildSelectionResultArgs
): SelectPremiumCandidateResult {
  const evaluationFingerprints = args.candidateEvaluations
    .map((e) =>
      buildEvaluationFingerprint(
        e.candidateId,
        e.rubricVersion,
        e.dimensionResults[0]?.evidenceRefs[0] ?? "",
        args.contractFingerprint
      )
    )
    .sort();

  const selectionFingerprint = buildSelectionFingerprint(
    args.workflowOperationId,
    args.contractFingerprint,
    evaluationFingerprints,
    SELECTOR_VERSION
  );

  const eligibleCount = args.candidateEvaluations.filter(
    (e) => e.premiumAcceptanceStatus === "accepted"
  ).length;
  const hardRejectedCount = args.candidateEvaluations.filter(
    (e) => !e.hardCompliancePassed
  ).length;
  const thresholdRejectedCount = args.candidateEvaluations.filter(
    (e) =>
      e.hardCompliancePassed &&
      (e.premiumAcceptanceStatus === "below_overall_threshold" ||
        e.premiumAcceptanceStatus === "below_dimension_minimum")
  ).length;
  const renderPendingCount = args.candidateEvaluations.filter(
    (e) => e.premiumAcceptanceStatus === "render_evaluation_required"
  ).length;

  return {
    selectionStatus: args.selectionStatus,
    selectedCandidateId: args.selectedCandidateId ?? null,
    selectedDirectionKey: args.selectedDirectionKey ?? null,
    selectedCandidateScore: args.selectedCandidateScore ?? null,
    selectedEvaluation: args.selectedEvaluation ?? null,
    recommendedForRenderCandidateId: args.recommendedForRenderCandidateId ?? null,
    recommendedForRenderScore: args.recommendedForRenderScore ?? null,
    candidateEvaluations: args.candidateEvaluations,
    selectionReasonCodes: args.selectionReasonCodes,
    selectionFingerprint,
    directionPlanFingerprint: args.directionPlans.directionPlanFingerprint,
    plannedDirectionCount: args.directionPlans.plannedDirectionCount,
    availableDirectionCount: args.directionPlans.availableDirectionCount,
    observedCandidateCount: args.candidateEvaluations.length,
    eligibleCandidateCount: eligibleCount,
    hardRejectedCandidateCount: hardRejectedCount,
    thresholdRejectedCandidateCount: thresholdRejectedCount,
    renderPendingCandidateCount: renderPendingCount,
    unavailableDirectionCodes: args.directionPlans.unavailableDirectionCodes,
  };
}

function createUnavailableDirectionResult(
  entry: CandidateSpecification,
  directionPlan: CreativeDirectionPlan | undefined
): PremiumQualityResult {
  const candidateId = entry.candidateId;
  const reason = directionPlan
    ? `DIRECTION_UNAVAILABLE:${directionPlan.unavailableReasonCode ?? "UNKNOWN"}`
    : "DIRECTION_NOT_FOUND";

  return {
    candidateId,
    rubricVersion: RUBRIC_VERSION,
    overallScore: null,
    passed: false,
    eligibilityStatus: "hard_compliance_failed",
    hardCompliancePassed: false,
    preRenderReadinessStatus: "hard_compliance_failed",
    preRenderReadinessScore: null,
    premiumAcceptanceStatus: "hard_compliance_failed",
    finalPremiumScore: null,
    qualityAuthorityWouldAccept: false,
    dimensionResults: [],
    reasonCodes: [reason],
  };
}
