/**
 * Shared Quality Authority observation adapter.
 *
 * Slice 1+2 scope:
 * - checks QUALITY_AUTHORITY_MODE once per call;
 * - extracts approved strategy lineage from workflowContext;
 * - compiles deterministic contract evidence (Slice 2);
 * - runs deterministic pre-render content compliance when proposed content is supplied;
 * - returns the legacy result unchanged;
 * - swallows observation errors so legacy behaviour is never disrupted.
 *
 * This module does not call providers, write to the database, change campaign
 * workflow state, or charge.
 */

import { logInfo, logWarn } from "../../logger";
import {
  getQualityAuthorityMode,
  observeCreativeContract,
  compileApprovedCreativeContract,
  isApprovedLineageAuthoritative,
  type ApprovedStrategyLineage,
  type CreativeContract,
  type ObservationDiagnostics,
  type QualityAuthorityMode,
} from "./creative-contract";
import {
  evaluateContentCompliance,
  type ProposedCreativeContent,
} from "../compliance/content-compliance";
import { compileGroundedEvidence } from "./grounded-evidence";
import { type FunnelStage } from "../cta-utils";

export interface QualityAuthorityObservationInput {
  campaignId: number;
  userId: number;
  businessId: number;
  businessName?: string | null;
  lineage: ApprovedStrategyLineage | null;
  expectedApprovedStrategyFingerprint?: string | null;
  funnelStage: FunnelStage;
  stageCtas?: Partial<Record<FunnelStage, string | null | undefined>>;
  campaignWideCta?: string | null;
  campaignInputCta?: string | null;
  offerActionCta?: string | null;
  aiDelegated?: boolean;
  targetAudience: string;
  offer: string | null;
  offerRequired?: boolean;
  businessCapabilities: readonly string[];
  legacySelectedCta: string;
  proposedContent?: ProposedCreativeContent | null;
  requiredBenefitCount?: number;
  brandConstraints?: readonly string[];
  requiredContactDetails?: readonly string[];
  prohibitedClaims?: readonly string[];
}

/**
 * Extract an approved strategy lineage object from campaign.workflowContext.
 * Returns null when the lineage is missing, malformed, or not approved.
 */
export function extractApprovedStrategyLineage(
  workflowContext: Record<string, unknown> | null | undefined,
  campaignId: number,
  userId: number
): ApprovedStrategyLineage | null {
  const rawLineage = workflowContext?.strategyApprovalLineage;
  if (
    !rawLineage ||
    typeof rawLineage !== "object" ||
    (rawLineage as any).status !== "approved"
  ) {
    return null;
  }

  const l = rawLineage as Record<string, unknown>;
  const strategyRunId =
    typeof l.strategyRunId === "number" ? l.strategyRunId : null;
  const approvalRequestId =
    typeof l.approvalRequestId === "number" ? l.approvalRequestId : null;

  if (strategyRunId == null || approvalRequestId == null) {
    return null;
  }

  const approvedAt =
    typeof l.approvedAt === "string" ? l.approvedAt : undefined;
  if (!approvedAt) {
    // A missing approved timestamp means the lineage cannot be treated as an
    // authoritative approved strategy. Observation must fail closed rather than
    // manufacture approval authority.
    return null;
  }

  return {
    campaignId,
    userId,
    strategyRunId,
    approvalRequestId,
    approvedStrategyFingerprint:
      (workflowContext?.approvedStrategyFingerprint as string) ||
      (l.creativeBriefFingerprint as string) ||
      "",
    approvedAt,
    status: "approved" as const,
    strategyRunStatus: "completed" as const,
  };
}

/**
 * Resolve the active approved strategy fingerprint used for stale detection.
 */
export function resolveExpectedApprovedStrategyFingerprint(
  workflowContext: Record<string, unknown> | null | undefined
): string | null {
  const rawLineage = workflowContext?.strategyApprovalLineage;
  return (
    (workflowContext?.approvedStrategyFingerprint as string) ||
    (rawLineage && typeof rawLineage === "object"
      ? ((rawLineage as Record<string, unknown>).creativeBriefFingerprint as string)
      : undefined) ||
    null
  );
}

function emptyComplianceDiagnostics(): Pick<
  ObservationDiagnostics,
  | "compliancePassed"
  | "complianceEvaluatorVersion"
  | "groundedClaimCount"
  | "partiallyGroundedClaimCount"
  | "ungroundedClaimCount"
  | "groundedBenefitCount"
  | "distinctGroundedBenefitCount"
  | "requiredBenefitCount"
  | "failedRuleIds"
  | "warningRuleIds"
  | "unsupportedClaimCodes"
  | "offerViolationCodes"
  | "audienceConsistencyStatus"
> {
  return {
    compliancePassed: null,
    complianceEvaluatorVersion: null,
    groundedClaimCount: null,
    partiallyGroundedClaimCount: null,
    ungroundedClaimCount: null,
    groundedBenefitCount: null,
    distinctGroundedBenefitCount: null,
    requiredBenefitCount: null,
    failedRuleIds: [],
    warningRuleIds: [],
    unsupportedClaimCodes: [],
    offerViolationCodes: [],
    audienceConsistencyStatus: "not_evaluated" as const,
  };
}

function runContentCompliance(
  input: QualityAuthorityObservationInput,
  observation: ObservationDiagnostics,
  contract: CreativeContract
): ObservationDiagnostics {
  if (!input.proposedContent) {
    return {
      ...observation,
      ...emptyComplianceDiagnostics(),
    };
  }

  try {
    const compiledEvidence = compileGroundedEvidence(contract);
    const compliance = evaluateContentCompliance({
      contract,
      proposed: input.proposedContent,
    });

    return {
      ...observation,
      evidenceSetFingerprint: compiledEvidence.evidenceSet.evidenceSetFingerprint,
      evidenceItemCount: compiledEvidence.evidenceSet.items.length,
      compliancePassed: compliance.passed,
      complianceEvaluatorVersion: compliance.evaluatorVersion,
      groundedClaimCount: compliance.groundedClaimCount,
      partiallyGroundedClaimCount: compliance.partiallyGroundedClaimCount,
      ungroundedClaimCount: compliance.ungroundedClaimCount,
      groundedBenefitCount: compliance.groundedBenefitCount,
      distinctGroundedBenefitCount: compliance.distinctGroundedBenefitCount,
      requiredBenefitCount: compliance.requiredBenefitCount,
      failedRuleIds: compliance.failedRuleIds,
      warningRuleIds: compliance.warnings.map((w) => w.ruleId),
      unsupportedClaimCodes: compliance.failures
        .filter((f) => f.ruleId === "UNSUPPORTED_CLAIMS")
        .map((f) => f.reasonCode),
      offerViolationCodes: compliance.failures
        .filter((f) => f.ruleId === "OFFER_AUTHORISED")
        .map((f) => f.reasonCode),
      audienceConsistencyStatus: compliance.failures.some(
        (f) => f.ruleId === "AUDIENCE_CONSISTENCY"
      )
        ? "conflict"
        : "consistent",
    };
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    return {
      ...observation,
      ...emptyComplianceDiagnostics(),
      diagnostics: [...observation.diagnostics, `Content compliance evaluation failed: ${reason}`],
    };
  }
}

/**
 * Run observation only when QUALITY_AUTHORITY_MODE=observe.
 * Always returns null in off or enforce modes, and never throws.
 */
export function observeIfEnabled(
  label: string,
  input: QualityAuthorityObservationInput
): ObservationDiagnostics | null {
  const mode = getQualityAuthorityMode();
  if (mode.effectiveMode !== "observe") {
    return null;
  }

  try {
    const observation = observeCreativeContract({
      ...input,
      mode: "observe" as QualityAuthorityMode,
    });

    if (!observation) {
      return null;
    }

    let contract: CreativeContract | null = null;
    const expectedFingerprint =
      input.expectedApprovedStrategyFingerprint ??
      input.lineage?.approvedStrategyFingerprint ??
      null;
    const authority = isApprovedLineageAuthoritative(
      input.lineage,
      input.campaignId,
      input.userId,
      expectedFingerprint
    );

    if (authority.authoritative && input.lineage) {
      try {
        contract = compileApprovedCreativeContract({
          campaignId: input.lineage.campaignId,
          userId: input.lineage.userId,
          businessId: input.businessId,
          businessName: input.businessName ?? null,
          strategyRunId: input.lineage.strategyRunId,
          approvalRequestId: input.lineage.approvalRequestId,
          approvedAt: input.lineage.approvedAt,
          approvedStrategyFingerprint: input.lineage.approvedStrategyFingerprint,
          funnelStage: input.funnelStage,
          stageCtas: input.stageCtas,
          campaignWideCta: input.campaignWideCta,
          campaignInputCta: input.campaignInputCta,
          offerActionCta: input.offerActionCta,
          aiDelegated: input.aiDelegated,
          targetAudience: input.targetAudience,
          offer: input.offer,
          offerRequired: input.offerRequired,
          businessCapabilities: input.businessCapabilities,
          requiredBenefitCount: input.requiredBenefitCount,
          brandConstraints: input.brandConstraints,
          requiredContactDetails: input.requiredContactDetails,
          prohibitedClaims: input.prohibitedClaims,
        });
      } catch {
        contract = null;
      }
    }

    const augmented =
      input.proposedContent && contract
        ? runContentCompliance(input, observation, contract)
        : { ...observation, ...emptyComplianceDiagnostics() };

    logInfo(`[QualityAuthority] ${label}`, {
      campaignId: augmented.campaignId,
      contractFingerprint: augmented.contractFingerprint,
      legacySelectedCta: augmented.legacySelectedCta,
      contractAuthoritativeCta: augmented.contractAuthoritativeCta,
      mismatchClassification: augmented.mismatchClassification,
      enforceWouldAccept: augmented.enforceWouldAccept,
      compliancePassed: augmented.compliancePassed,
      failedRuleIds: augmented.failedRuleIds,
    });

    return augmented;
  } catch (err) {
    const reason = err instanceof Error ? err.message : String(err);
    logWarn(`[QualityAuthority] observation failed in ${label}`, {
      campaignId: input.campaignId,
      userId: input.userId,
      error: reason,
    });
    return null;
  }
}
