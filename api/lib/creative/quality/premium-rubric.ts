/**
 * Premium Creative Quality Rubric.
 *
 * Slice 4 scope:
 * - versioned seven-dimension deterministic scoring model;
 * - separates hard compliance, pre-render readiness and final premium acceptance;
 * - operates only on hard-compliance-passing candidates;
 * - uses structured candidate attributes, existing compliance results and the
 *   approved CreativeContract;
 * - render-dependent dimensions return render_required status and a null score
 *   when trusted rendered evidence is absent;
 * - pre-render estimates for non-render dimensions feed preRenderReadinessScore
 *   but never feed finalPremiumScore;
 * - provider-free and observation-only.
 */

import type { ApprovedCreativeContract } from "../contracts/creative-contract";
import type { ProposedCreativeContent } from "../compliance/content-compliance";
import type { ContentComplianceResult } from "../compliance/content-compliance";
import type { CreativeDirectionPlan } from "./creative-direction-planner";
import { isTrustedRenderedCreativeEvidence } from "./rendered-creative-evaluator";

export const RUBRIC_VERSION = "slice4.premium-rubric.v1";

export interface RenderedCreativeEvidence {
  source: "render_evaluator";
  renderedAssetFingerprint: string;
  /** SHA-256 calculated from the decoded render buffer by the internal evaluator. */
  renderedBytesSha256: string;
  verification: "trusted_render_bytes_v1";
  evaluatorVersion: string;
  metricsBindingFingerprint: string;
  layoutAndVisualHierarchyScore: number;
  legibilityAndAccessibilityScore: number;
  reasonCodes: string[];
  evidenceRefs: string[];
}

export interface RubricDimensionResult {
  dimensionId: string;
  score: number | null;
  weight: number;
  passedMinimum: boolean;
  reasonCodes: string[];
  evidenceRefs: string[];
  evaluationStatus: "scored" | "pre_render_estimate" | "render_required" | "not_evaluable_pre_render";
}

export interface PremiumQualityResult {
  candidateId: string;
  rubricVersion: string;
  /**
   * @deprecated Use finalPremiumScore. Kept for compatibility; mirrors
   * finalPremiumScore and stays null until rendered evidence is authoritative.
   */
  overallScore: number | null;
  /**
   * @deprecated Use qualityAuthorityWouldAccept. Kept for compatibility;
   * mirrors qualityAuthorityWouldAccept.
   */
  passed: boolean;
  /**
   * @deprecated Use premiumAcceptanceStatus. Kept for compatibility; maps
   * "accepted" to "eligible" and preserves other terminal statuses.
   */
  eligibilityStatus:
    | "eligible"
    | "hard_compliance_failed"
    | "below_overall_threshold"
    | "below_dimension_minimum"
    | "render_evaluation_required"
    | "stale_contract"
    | "invalid_candidate_schema"
    | "rejected"
    | null;
  hardCompliancePassed: boolean;
  preRenderReadinessStatus:
    | "ready_for_render"
    | "not_ready_for_render"
    | "hard_compliance_failed"
    | "stale_contract"
    | "invalid_candidate_schema";
  preRenderReadinessScore: number | null;
  premiumAcceptanceStatus:
    | "accepted"
    | "rejected"
    | "render_evaluation_required"
    | "hard_compliance_failed"
    | "below_overall_threshold"
    | "below_dimension_minimum"
    | "stale_contract"
    | "invalid_candidate_schema";
  finalPremiumScore: number | null;
  qualityAuthorityWouldAccept: boolean;
  dimensionResults: RubricDimensionResult[];
  reasonCodes: string[];
}

export interface EvaluatePremiumCandidateInput {
  candidateId: string;
  candidate: ProposedCreativeContent;
  directionPlan: CreativeDirectionPlan;
  contract: ApprovedCreativeContract;
  complianceResult: ContentComplianceResult;
  renderedEvidence?: RenderedCreativeEvidence | null;
}

interface DimensionConfig {
  dimensionId: string;
  weight: number;
  minimumScore: number;
  renderDependent: boolean;
}

const DIMENSIONS: DimensionConfig[] = [
  { dimensionId: "strategic_alignment", weight: 0.2, minimumScore: 75, renderDependent: false },
  { dimensionId: "message_hierarchy_and_clarity", weight: 0.15, minimumScore: 70, renderDependent: false },
  { dimensionId: "brand_fidelity", weight: 0.15, minimumScore: 70, renderDependent: false },
  { dimensionId: "grounded_persuasive_strength", weight: 0.15, minimumScore: 70, renderDependent: false },
  { dimensionId: "layout_and_visual_hierarchy", weight: 0.15, minimumScore: 70, renderDependent: true },
  { dimensionId: "legibility_and_accessibility", weight: 0.1, minimumScore: 70, renderDependent: true },
  { dimensionId: "cta_prominence_and_action_clarity", weight: 0.1, minimumScore: 75, renderDependent: false },
];

const NON_RENDER_DIMENSION_IDS = new Set(
  DIMENSIONS.filter((d) => !d.renderDependent).map((d) => d.dimensionId)
);

function normalize(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().replace(/\s+/g, " ");
}

function containsWholeWord(haystack: string, needle: string): boolean {
  const h = normalize(haystack);
  const n = normalize(needle);
  if (!n) return false;
  if (h === n) return true;
  const escaped = n.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?:^|[^a-z0-9])${escaped}(?=[^a-z0-9]|$)`, "i");
  return pattern.test(haystack);
}

function hasRequiredField(value: unknown): boolean {
  return typeof value === "string" && value.trim().length > 0;
}

function hasPlaceholder(text: string): boolean {
  return /\[.*?\]|\{.*?\}|\(.*?\)|\bplaceholder\b|lorem ipsum|your business/i.test(text);
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

function roundScore(score: number): number {
  return Math.round(score * 100) / 100;
}

function isTrustedRenderedEvidence(
  evidence: RenderedCreativeEvidence | null | undefined
): evidence is RenderedCreativeEvidence {
  if (!evidence) return false;
  return isTrustedRenderedCreativeEvidence(evidence);
}

function isCandidateSchemaValid(candidate: ProposedCreativeContent): boolean {
  if (!candidate || typeof candidate !== "object") return false;
  const c = candidate as unknown as Record<string, unknown>;
  if (!Array.isArray(c.benefits)) return false;
  const requiredStrings = ["headline", "primaryText", "cta", "funnelStage", "targetAudience", "businessName"];
  for (const key of requiredStrings) {
    if (typeof c[key] !== "string" || (c[key] as string).trim().length === 0) {
      return false;
    }
  }
  return true;
}

function isContractAuthoritative(contract: ApprovedCreativeContract): boolean {
  return (
    (contract as unknown as Record<string, unknown>).kind === "approved" &&
    typeof contract.approvedAt === "string" &&
    contract.approvedAt.length > 0
  );
}

function scoreStrategicAlignment(
  input: EvaluatePremiumCandidateInput
): Pick<RubricDimensionResult, "score" | "reasonCodes" | "evidenceRefs" | "evaluationStatus"> {
  const { candidate, contract, directionPlan } = input;
  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  let score = 100;

  if (normalize(candidate.cta) !== normalize(contract.cta.text)) {
    score -= 50;
    reasons.push("CTA_LOCKED_MISMATCH");
  } else {
    reasons.push("CTA_LOCKED_MATCH");
  }

  const audienceMatch =
    containsWholeWord(candidate.targetAudience, contract.targetAudience) ||
    containsWholeWord(contract.targetAudience, candidate.targetAudience);
  if (!audienceMatch) {
    score -= 30;
    reasons.push("AUDIENCE_MISMATCH");
  } else {
    reasons.push("AUDIENCE_MATCH");
  }

  const stageMatch = normalize(candidate.funnelStage) === normalize(contract.funnelStage);
  if (!stageMatch) {
    score -= 20;
    reasons.push("FUNNEL_STAGE_MISMATCH");
  } else {
    reasons.push("FUNNEL_STAGE_MATCH");
  }

  if (directionPlan.available && directionPlan.evidenceIds.length > 0) {
    evidenceRefs.push(...directionPlan.evidenceIds.slice(0, 3));
  }

  if (score === 100) reasons.push("STRATEGIC_ALIGNMENT_STRONG");

  return { score: clampScore(score), reasonCodes: reasons, evidenceRefs, evaluationStatus: "scored" };
}

function scoreMessageHierarchyAndClarity(
  input: EvaluatePremiumCandidateInput
): Pick<RubricDimensionResult, "score" | "reasonCodes" | "evidenceRefs" | "evaluationStatus"> {
  const { candidate, contract } = input;
  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  let score = 100;

  if (!hasRequiredField(candidate.headline)) {
    score -= 40;
    reasons.push("HEADLINE_MISSING");
  } else if (candidate.headline.trim().length > 80) {
    score -= 25;
    reasons.push("HEADLINE_TOO_LONG");
  } else {
    reasons.push("HEADLINE_PRESENT");
  }

  if (!hasRequiredField(candidate.primaryText)) {
    score -= 30;
    reasons.push("PRIMARY_TEXT_MISSING");
  } else if (candidate.primaryText.trim().length > 300) {
    score -= 20;
    reasons.push("PRIMARY_TEXT_TOO_LONG");
  } else {
    reasons.push("PRIMARY_TEXT_PRESENT");
  }

  const benefitCount = candidate.benefits.filter((b) => typeof b === "string" && b.trim().length > 0).length;
  if (benefitCount < contract.minimumBenefitCount) {
    score -= 30;
    reasons.push("BENEFIT_COUNT_BELOW_MINIMUM");
  } else {
    reasons.push("BENEFIT_COUNT_ADEQUATE");
  }

  const combinedText = `${candidate.headline} ${candidate.primaryText} ${candidate.benefits.join(" ")}`;
  if (hasPlaceholder(combinedText)) {
    score -= 40;
    reasons.push("PLACEHOLDER_LANGUAGE_DETECTED");
  } else {
    reasons.push("NO_PLACEHOLDER_LANGUAGE");
  }

  if (contract.groundedBenefitEvidence.length > 0) {
    evidenceRefs.push(...contract.groundedBenefitEvidence.flatMap((b) => b.evidenceIds).slice(0, 3));
  }

  return { score: clampScore(score), reasonCodes: reasons, evidenceRefs, evaluationStatus: "scored" };
}

function scoreBrandFidelity(
  input: EvaluatePremiumCandidateInput
): Pick<RubricDimensionResult, "score" | "reasonCodes" | "evidenceRefs" | "evaluationStatus"> {
  const { candidate, contract } = input;
  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  let score = 100;

  const combined = `${candidate.headline} ${candidate.primaryText} ${candidate.benefits.join(" ")}`;

  if (candidate.businessName.trim() !== contract.businessName.trim()) {
    score -= 30;
    reasons.push("BUSINESS_NAME_MISMATCH");
  } else {
    reasons.push("BUSINESS_NAME_MATCH");
  }

  if (!containsWholeWord(combined, contract.businessName)) {
    score -= 25;
    reasons.push("BUSINESS_NAME_NOT_PROMINENT");
  }

  for (const constraint of contract.brandConstraints) {
    if (constraint.trim() && !containsWholeWord(combined, constraint)) {
      score -= 15;
      reasons.push("BRAND_CONSTRAINT_MISSED");
      evidenceRefs.push(constraint);
    }
  }

  for (const prohibited of contract.prohibitedClaims) {
    if (prohibited.trim() && containsWholeWord(combined, prohibited)) {
      score -= 30;
      reasons.push("PROHIBITED_CLAIM_USED");
      evidenceRefs.push(prohibited);
    }
  }

  if (reasons.length === 0 || (reasons.length === 1 && reasons[0] === "BUSINESS_NAME_MATCH")) {
    reasons.push("BRAND_FIDELITY_STRONG");
  }

  return { score: clampScore(score), reasonCodes: reasons, evidenceRefs, evaluationStatus: "scored" };
}

function scoreGroundedPersuasiveStrength(
  input: EvaluatePremiumCandidateInput
): Pick<RubricDimensionResult, "score" | "reasonCodes" | "evidenceRefs" | "evaluationStatus"> {
  const { candidate, contract, complianceResult } = input;
  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  let score = 100;

  const unsupported = complianceResult.failures.some((f) => f.ruleId === "UNSUPPORTED_CLAIMS");
  const claimGroundingFailed = complianceResult.failures.some((f) => f.ruleId === "CLAIM_GROUNDING");
  const benefitGroundingFailed = complianceResult.failures.some((f) => f.ruleId === "BENEFIT_GROUNDING");

  if (unsupported) {
    score -= 50;
    reasons.push("UNSUPPORTED_CLAIMS_PRESENT");
  } else {
    reasons.push("NO_UNSUPPORTED_CLAIMS");
  }

  if (claimGroundingFailed) {
    score -= 25;
    reasons.push("CLAIM_GROUNDING_FAILED");
  } else {
    reasons.push("CLAIMS_GROUNDED");
  }

  if (benefitGroundingFailed) {
    score -= 25;
    reasons.push("BENEFIT_GROUNDING_FAILED");
  } else {
    reasons.push("BENEFITS_GROUNDED");
  }

  const candidateBenefits = candidate.benefits.filter((b) => typeof b === "string" && b.trim().length > 0);
  const groundedBenefits = contract.groundedBenefitEvidence.filter(
    (b) => b.validationStatus === "grounded" || b.validationStatus === "partially_grounded"
  );
  if (groundedBenefits.length === 0 && candidateBenefits.length > 0) {
    score -= 20;
    reasons.push("NO_GROUNDED_BENEFIT_EVIDENCE");
  } else if (groundedBenefits.length > 0) {
    reasons.push("GROUNDED_BENEFIT_EVIDENCE_PRESENT");
    evidenceRefs.push(...groundedBenefits.flatMap((b) => b.evidenceIds).slice(0, 3));
  }

  return { score: clampScore(score), reasonCodes: reasons, evidenceRefs, evaluationStatus: "scored" };
}

function scoreLayoutAndVisualHierarchy(
  input: EvaluatePremiumCandidateInput
): Pick<RubricDimensionResult, "score" | "reasonCodes" | "evidenceRefs" | "evaluationStatus"> {
  const reasons: string[] = [];

  if (!isTrustedRenderedEvidence(input.renderedEvidence)) {
    reasons.push("RENDER_DEPENDENT_EVIDENCE_REQUIRED");
    return { score: null, reasonCodes: reasons, evidenceRefs: [], evaluationStatus: "render_required" };
  }

  const score = clampScore(input.renderedEvidence.layoutAndVisualHierarchyScore);
  reasons.push(...input.renderedEvidence.reasonCodes);
  reasons.push("RENDERED_EVIDENCE_SCORED");

  return { score, reasonCodes: reasons, evidenceRefs: [], evaluationStatus: "scored" };
}

function scoreLegibilityAndAccessibility(
  input: EvaluatePremiumCandidateInput
): Pick<RubricDimensionResult, "score" | "reasonCodes" | "evidenceRefs" | "evaluationStatus"> {
  const reasons: string[] = [];

  if (!isTrustedRenderedEvidence(input.renderedEvidence)) {
    reasons.push("RENDER_DEPENDENT_EVIDENCE_REQUIRED");
    return { score: null, reasonCodes: reasons, evidenceRefs: [], evaluationStatus: "render_required" };
  }

  const score = clampScore(input.renderedEvidence.legibilityAndAccessibilityScore);
  reasons.push(...input.renderedEvidence.reasonCodes);
  reasons.push("RENDERED_EVIDENCE_SCORED");

  return { score, reasonCodes: reasons, evidenceRefs: [], evaluationStatus: "scored" };
}

function scoreCtaProminenceAndActionClarity(
  input: EvaluatePremiumCandidateInput
): Pick<RubricDimensionResult, "score" | "reasonCodes" | "evidenceRefs" | "evaluationStatus"> {
  const { candidate, contract } = input;
  const reasons: string[] = [];
  const evidenceRefs: string[] = [];
  let score = 100;

  if (normalize(candidate.cta) !== normalize(contract.cta.text)) {
    score -= 80;
    reasons.push("CTA_LOCKED_MISMATCH");
  } else {
    reasons.push("CTA_LOCKED_MATCH");
  }

  const cta = candidate.cta.trim();
  if (cta.length === 0) {
    score -= 20;
    reasons.push("CTA_MISSING");
  } else if (cta.length > 40) {
    score -= 15;
    reasons.push("CTA_TOO_LONG");
  } else {
    reasons.push("CTA_PROMINENT");
  }

  const actionWords = new Set([
    "request", "book", "get", "start", "claim", "schedule", "arrange", "reserve",
    "consult", "learn", "discover", "find", "explore",
  ]);
  const firstWord = cta.split(/\s+/)[0]?.toLowerCase() ?? "";
  if (actionWords.has(firstWord)) {
    reasons.push("CTA_ACTION_VERB_PRESENT");
  } else {
    score -= 10;
    reasons.push("CTA_ACTION_VERB_WEAK");
  }

  evidenceRefs.push(contract.cta.source);

  return { score: clampScore(score), reasonCodes: reasons, evidenceRefs, evaluationStatus: "scored" };
}

function evaluateDimension(
  config: DimensionConfig,
  input: EvaluatePremiumCandidateInput
): RubricDimensionResult {
  let evaluation: Pick<RubricDimensionResult, "score" | "reasonCodes" | "evidenceRefs" | "evaluationStatus">;

  switch (config.dimensionId) {
    case "strategic_alignment":
      evaluation = scoreStrategicAlignment(input);
      break;
    case "message_hierarchy_and_clarity":
      evaluation = scoreMessageHierarchyAndClarity(input);
      break;
    case "brand_fidelity":
      evaluation = scoreBrandFidelity(input);
      break;
    case "grounded_persuasive_strength":
      evaluation = scoreGroundedPersuasiveStrength(input);
      break;
    case "layout_and_visual_hierarchy":
      evaluation = scoreLayoutAndVisualHierarchy(input);
      break;
    case "legibility_and_accessibility":
      evaluation = scoreLegibilityAndAccessibility(input);
      break;
    case "cta_prominence_and_action_clarity":
      evaluation = scoreCtaProminenceAndActionClarity(input);
      break;
    default:
      evaluation = {
        score: null,
        reasonCodes: ["UNKNOWN_DIMENSION"],
        evidenceRefs: [],
        evaluationStatus: "not_evaluable_pre_render",
      };
  }

  const score = evaluation.score;
  const passedMinimum = score !== null && score >= config.minimumScore;

  return {
    dimensionId: config.dimensionId,
    score,
    weight: config.weight,
    passedMinimum,
    reasonCodes: evaluation.reasonCodes,
    evidenceRefs: evaluation.evidenceRefs,
    evaluationStatus: evaluation.evaluationStatus,
  };
}

function computePreRenderReadinessScore(
  dimensionResults: RubricDimensionResult[],
  hardCompliancePassed: boolean,
  contractAuthoritative: boolean,
  schemaValid: boolean
): number | null {
  if (!hardCompliancePassed || !contractAuthoritative || !schemaValid) {
    return null;
  }

  const nonRender = dimensionResults.filter((d) => NON_RENDER_DIMENSION_IDS.has(d.dimensionId));
  const weightSum = nonRender.reduce((sum, d) => sum + d.weight, 0);
  if (weightSum === 0) return null;

  const weightedSum = nonRender.reduce((sum, d) => {
    const score = d.score ?? 0;
    return sum + score * d.weight;
  }, 0);

  return roundScore(weightedSum / weightSum);
}

function computeFinalPremiumScore(dimensionResults: RubricDimensionResult[]): number | null {
  const allAuthoritative = dimensionResults.every((d) => d.evaluationStatus === "scored" && d.score !== null);
  if (!allAuthoritative) {
    return null;
  }

  const weightedSum = dimensionResults.reduce((sum, d) => {
    return sum + (d.score as number) * d.weight;
  }, 0);

  return roundScore(weightedSum);
}

function determineStatuses(args: {
  hardCompliancePassed: boolean;
  contractAuthoritative: boolean;
  schemaValid: boolean;
  dimensionResults: RubricDimensionResult[];
  finalPremiumScore: number | null;
  preRenderReadinessScore: number | null;
  complianceFailedRuleIds?: string[];
}): {
  preRenderReadinessStatus: PremiumQualityResult["preRenderReadinessStatus"];
  premiumAcceptanceStatus: PremiumQualityResult["premiumAcceptanceStatus"];
  reasonCodes: string[];
} {
  const { hardCompliancePassed, contractAuthoritative, schemaValid, dimensionResults, finalPremiumScore, preRenderReadinessScore, complianceFailedRuleIds } = args;
  const reasonCodes: string[] = [];

  if (!contractAuthoritative) {
    reasonCodes.push("CONTRACT_NOT_AUTHORITATIVE");
    return {
      preRenderReadinessStatus: "stale_contract",
      premiumAcceptanceStatus: "stale_contract",
      reasonCodes,
    };
  }

  if (!schemaValid) {
    reasonCodes.push("INVALID_CANDIDATE_SCHEMA");
    return {
      preRenderReadinessStatus: "invalid_candidate_schema",
      premiumAcceptanceStatus: "invalid_candidate_schema",
      reasonCodes,
    };
  }

  if (!hardCompliancePassed) {
    reasonCodes.push("HARD_COMPLIANCE_FAILED");
    if (complianceFailedRuleIds && complianceFailedRuleIds.length > 0) {
      reasonCodes.push(...complianceFailedRuleIds);
    }
    return {
      preRenderReadinessStatus: "hard_compliance_failed",
      premiumAcceptanceStatus: "hard_compliance_failed",
      reasonCodes,
    };
  }

  // Pre-render readiness is based only on non-render dimensions.
  const nonRenderResults = dimensionResults.filter((d) => NON_RENDER_DIMENSION_IDS.has(d.dimensionId));
  const nonRenderPassed = nonRenderResults.every((d) => d.passedMinimum);

  let preRenderReadinessStatus: PremiumQualityResult["preRenderReadinessStatus"];
  if (nonRenderPassed && preRenderReadinessScore !== null) {
    preRenderReadinessStatus = "ready_for_render";
    reasonCodes.push("PRE_RENDER_READINESS_PASSED");
  } else {
    preRenderReadinessStatus = "not_ready_for_render";
    const failed = nonRenderResults.find((d) => !d.passedMinimum);
    if (failed) {
      reasonCodes.push(`PRE_RENDER_DIMENSION_BELOW_MINIMUM:${failed.dimensionId}`);
    } else {
      reasonCodes.push("PRE_RENDER_READINESS_FAILED");
    }
  }

  // Final premium acceptance requires authoritative scores for every dimension.
  const renderRequired = dimensionResults.some(
    (d) => d.evaluationStatus === "render_required" || d.score === null
  );
  const belowMinimum = dimensionResults.find((d) => !d.passedMinimum);

  let premiumAcceptanceStatus: PremiumQualityResult["premiumAcceptanceStatus"];

  if (renderRequired) {
    premiumAcceptanceStatus = "render_evaluation_required";
    reasonCodes.push("RENDER_DEPENDENT_DIMENSIONS_PENDING");
  } else if (belowMinimum) {
    premiumAcceptanceStatus = "below_dimension_minimum";
    reasonCodes.push(`DIMENSION_BELOW_MINIMUM:${belowMinimum.dimensionId}`);
  } else if (finalPremiumScore === null) {
    // Should not happen if all dimensions are scored, but keep fail-closed.
    premiumAcceptanceStatus = "render_evaluation_required";
    reasonCodes.push("FINAL_SCORE_NOT_AUTHORITATIVE");
  } else if (finalPremiumScore < 80) {
    premiumAcceptanceStatus = "below_overall_threshold";
    reasonCodes.push("OVERALL_SCORE_BELOW_80");
  } else {
    premiumAcceptanceStatus = "accepted";
    reasonCodes.push("PREMIUM_QUALITY_THRESHOLD_MET");
  }

  return { preRenderReadinessStatus, premiumAcceptanceStatus, reasonCodes };
}

export function evaluatePremiumCandidate(
  input: EvaluatePremiumCandidateInput
): PremiumQualityResult {
  const dimensionResults = DIMENSIONS.map((config) => evaluateDimension(config, input));

  const hardCompliancePassed = input.complianceResult.passed;
  const contractAuthoritative = isContractAuthoritative(input.contract);
  const schemaValid = isCandidateSchemaValid(input.candidate);

  const preRenderReadinessScore = computePreRenderReadinessScore(
    dimensionResults,
    hardCompliancePassed,
    contractAuthoritative,
    schemaValid
  );

  const finalPremiumScore = computeFinalPremiumScore(dimensionResults);

  const { preRenderReadinessStatus, premiumAcceptanceStatus, reasonCodes } = determineStatuses({
    hardCompliancePassed,
    contractAuthoritative,
    schemaValid,
    dimensionResults,
    finalPremiumScore,
    preRenderReadinessScore,
    complianceFailedRuleIds: input.complianceResult.failedRuleIds,
  });

  const qualityAuthorityWouldAccept = premiumAcceptanceStatus === "accepted";

  // Backward-compatible aliases.
  const overallScore = finalPremiumScore;
  const passed = qualityAuthorityWouldAccept;
  const eligibilityStatus: PremiumQualityResult["eligibilityStatus"] =
    premiumAcceptanceStatus === "accepted" ? "eligible" : premiumAcceptanceStatus;

  return {
    candidateId: input.candidateId,
    rubricVersion: RUBRIC_VERSION,
    overallScore,
    passed,
    eligibilityStatus,
    hardCompliancePassed,
    preRenderReadinessStatus,
    preRenderReadinessScore,
    premiumAcceptanceStatus,
    finalPremiumScore,
    qualityAuthorityWouldAccept,
    dimensionResults,
    reasonCodes,
  };
}

export function getDimensionConfigs(): ReadonlyArray<DimensionConfig> {
  return DIMENSIONS.map((d) => ({ ...d }));
}
