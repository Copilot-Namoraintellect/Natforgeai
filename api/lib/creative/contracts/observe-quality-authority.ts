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
import {
  buildWorkflowCorrelationContext,
  InMemoryWorkflowOperationRegistry,
  type WorkflowOperationType,
  type WorkflowOperationSource,
  type WorkflowAttemptType,
  type WorkflowOperationStatus,
} from "../../workflow/workflow-operation";

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
  // Slice 3 workflow identity overrides.  When omitted, the observer infers
  // operationType=creative_generation and operationSource from the lineage.
  operationType?: WorkflowOperationType | null;
  operationSource?: WorkflowOperationSource | null;
  operationReferenceId?: string | number | null;
  claimId?: number | null;
  attemptType?: WorkflowAttemptType | null;
  attemptOrdinal?: number | null;
  parentAttemptId?: string | null;
  providerRunId?: string | null;
  internalRunId?: number | null;
  registry?: InMemoryWorkflowOperationRegistry | null;
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

function normaliseReferenceId(value: string | number | null | undefined): string {
  if (value === null || value === undefined) return "";
  return String(value).trim();
}

function safeWorkflowStatus(
  registry: InMemoryWorkflowOperationRegistry,
  workflowOperationId: string
): WorkflowOperationStatus | null {
  return registry.findOperation(workflowOperationId)?.status ?? null;
}

/**
 * Register an in-memory workflow operation and optional attempt for the current
 * observation.  This is purely diagnostic: no database rows are written and no
 * workflow state is mutated.
 *
 * The observer intentionally does NOT finalize the top-level operation.
 * Terminal-state ownership belongs to explicit orchestration-boundary code
 * (see `finalizeWorkflowOperation`).
 */
const TERMINAL_WORKFLOW_STATUSES: Set<WorkflowOperationStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

function registerWorkflowObservation(
  input: QualityAuthorityObservationInput,
  observation: ObservationDiagnostics
): {
  observation: ObservationDiagnostics;
  registry: InMemoryWorkflowOperationRegistry | null;
} {
  if (!input.registry) {
    // No injected registry means we cannot safely correlate attempts across
    // observation points.  Fail open: continue other diagnostics but do not
    // pretend cross-point correlation occurred.
    const enriched: ObservationDiagnostics = {
      ...observation,
      workflowOperationId: null,
      workflowIdempotencyKey: null,
      operationType: null,
      operationSource: null,
      operationReferenceId: null,
      operationStatus: null,
      attemptCount: null,
      attemptTypeCounts: null,
      completedAttemptCount: null,
      failedAttemptCount: null,
      activeAttemptCount: null,
      terminalAttemptCount: null,
      correlationValid: null,
      correlationFailureCodes: ["WORKFLOW_OBSERVATION_SKIPPED_NO_REGISTRY"],
      duplicateClassification: "none",
      diagnostics: [
        ...observation.diagnostics,
        "Workflow observation skipped: no scoped registry was injected.",
      ],
    };
    return { observation: enriched, registry: null };
  }

  const operationType = input.operationType ?? "creative_generation";
  const operationSource = input.operationSource ?? "automatic";
  const operationReferenceId =
    normaliseReferenceId(input.operationReferenceId) ||
    normaliseReferenceId(input.lineage?.approvalRequestId) ||
    normaliseReferenceId(input.campaignId);

  const identityInput = {
    operationType,
    operationSource,
    operationReferenceId,
    campaignId: input.campaignId,
    userId: input.userId,
    businessId: input.businessId,
    contractFingerprint:
      input.lineage?.approvedStrategyFingerprint ?? observation.contractFingerprint,
    strategyRunId: input.lineage?.strategyRunId ?? null,
    approvalRequestId: input.lineage?.approvalRequestId ?? null,
    claimId: input.claimId ?? null,
    approvedAt: input.lineage?.approvedAt ?? null,
  };

  const context = buildWorkflowCorrelationContext(identityInput);
  const registry = input.registry;
  const opResult = registry.registerOperation(identityInput);
  const isReplay = opResult.duplicateClassification === "idempotent_replay";

  let duplicateClassification = opResult.duplicateClassification;

  // On an idempotent replay the operation may already be terminal.  Do not
  // re-transition; do not register new attempts under a terminal operation.
  const operation = registry.findOperation(context.workflowOperationId);
  const canMutate = operation && !TERMINAL_WORKFLOW_STATUSES.has(operation.status);

  if (canMutate) {
    registry.transitionOperation(context.workflowOperationId, "running");
  }

  if (input.attemptType && canMutate) {
    const explicitOrdinal = input.attemptOrdinal;
    const hasExplicitOrdinal =
      typeof explicitOrdinal === "number" && Number.isInteger(explicitOrdinal) && explicitOrdinal > 0;

    const attemptResult = hasExplicitOrdinal
      ? registry.registerAttemptReplay({
          workflowOperationId: context.workflowOperationId,
          attemptType: input.attemptType,
          ordinal: explicitOrdinal,
          parentAttemptId: input.parentAttemptId ?? null,
          providerRunId: input.providerRunId ?? null,
          internalRunId: input.internalRunId ?? null,
        })
      : registry.allocateNewAttempt({
          workflowOperationId: context.workflowOperationId,
          attemptType: input.attemptType,
          parentAttemptId: input.parentAttemptId ?? null,
          providerRunId: input.providerRunId ?? null,
          internalRunId: input.internalRunId ?? null,
        });

    const isAttemptReplay = attemptResult.duplicateClassification === "idempotent_replay";
    if (!isAttemptReplay) {
      registry.transitionAttempt(attemptResult.attempt.workflowAttemptId, "running");
      registry.transitionAttempt(attemptResult.attempt.workflowAttemptId, "completed");
    }
    duplicateClassification = attemptResult.duplicateClassification;
  }

  // The observer never transitions the operation to a terminal state.
  // It stays `running` until orchestration code calls finalizeWorkflowOperation.

  const attempts = registry.listAttempts(context.workflowOperationId);
  const attemptTypeCounts: Partial<Record<WorkflowAttemptType, number>> = {};
  for (const attempt of attempts) {
    attemptTypeCounts[attempt.attemptType] = (attemptTypeCounts[attempt.attemptType] ?? 0) + 1;
  }

  const completedAttemptCount = attempts.filter((a) => a.status === "completed").length;
  const failedAttemptCount = attempts.filter((a) => a.status === "failed").length;
  const activeAttemptCount = attempts.filter((a) => a.status === "running" || a.status === "created").length;
  const terminalAttemptCount = attempts.filter(
    (a) => a.status === "completed" || a.status === "failed" || a.status === "cancelled"
  ).length;

  const correlationValidation = registry.validateCorrelation(context);

  const enriched: ObservationDiagnostics = {
    ...observation,
    workflowOperationId: context.workflowOperationId,
    workflowIdempotencyKey: context.idempotencyKey,
    operationType: context.operationType,
    operationSource: context.operationSource,
    operationReferenceId: context.operationReferenceId,
    operationStatus: safeWorkflowStatus(registry, context.workflowOperationId),
    attemptCount: attempts.length,
    attemptTypeCounts,
    completedAttemptCount,
    failedAttemptCount,
    activeAttemptCount,
    terminalAttemptCount,
    correlationValid: correlationValidation.valid,
    correlationFailureCodes: correlationValidation.failureCodes,
    duplicateClassification: isReplay ? opResult.duplicateClassification : duplicateClassification,
  };

  return { observation: enriched, registry };
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

    let finalised: ObservationDiagnostics;
    try {
      const { observation: enriched } = registerWorkflowObservation(input, augmented);
      finalised = enriched;
    } catch (err) {
      const reason = err instanceof Error ? err.message : String(err);
      finalised = {
        ...augmented,
        diagnostics: [...augmented.diagnostics, `Workflow observation registration failed: ${reason}`],
      };
    }

    logInfo(`[QualityAuthority] ${label}`, {
      campaignId: finalised.campaignId,
      contractFingerprint: finalised.contractFingerprint,
      legacySelectedCta: finalised.legacySelectedCta,
      contractAuthoritativeCta: finalised.contractAuthoritativeCta,
      mismatchClassification: finalised.mismatchClassification,
      enforceWouldAccept: finalised.enforceWouldAccept,
      compliancePassed: finalised.compliancePassed,
      failedRuleIds: finalised.failedRuleIds,
      workflowOperationId: finalised.workflowOperationId,
      operationStatus: finalised.operationStatus,
      attemptCount: finalised.attemptCount,
    });

    return finalised;
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
