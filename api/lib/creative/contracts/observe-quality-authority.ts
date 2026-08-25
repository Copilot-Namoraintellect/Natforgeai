/**
 * Shared Quality Authority observation adapter.
 *
 * Slice 1 scope:
 * - checks QUALITY_AUTHORITY_MODE once per call;
 * - extracts approved strategy lineage from workflowContext;
 * - runs deterministic observation without mutating the caller's state;
 * - logs structured diagnostics;
 * - swallows observation errors so legacy behaviour is never disrupted.
 *
 * This module does not call providers, write to the database, or change
 * campaign workflow state.
 */

import { logInfo, logWarn } from "../../logger";
import {
  getQualityAuthorityMode,
  observeCreativeContract,
  type ApprovedStrategyLineage,
  type ObservationDiagnostics,
  type QualityAuthorityMode,
} from "./creative-contract";
import { type FunnelStage } from "../cta-utils";

export interface QualityAuthorityObservationInput {
  campaignId: number;
  userId: number;
  businessId: number;
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
  businessCapabilities: readonly string[];
  legacySelectedCta: string;
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

  return {
    campaignId,
    userId,
    strategyRunId,
    approvalRequestId,
    approvedStrategyFingerprint:
      (workflowContext?.approvedStrategyFingerprint as string) ||
      (l.creativeBriefFingerprint as string) ||
      "",
    approvedAt:
      typeof l.approvedAt === "string"
        ? l.approvedAt
        : new Date(0).toISOString(),
    status: "approved",
    strategyRunStatus: "completed",
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

    if (observation) {
      logInfo(`[QualityAuthority] ${label}`, {
        campaignId: observation.campaignId,
        contractFingerprint: observation.contractFingerprint,
        legacySelectedCta: observation.legacySelectedCta,
        contractAuthoritativeCta: observation.contractAuthoritativeCta,
        mismatchClassification: observation.mismatchClassification,
        enforceWouldAccept: observation.enforceWouldAccept,
      });
    }

    return observation;
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
