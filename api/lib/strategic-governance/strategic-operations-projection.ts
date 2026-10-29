// ─── R8-F Strategic Intelligence Governance — operations projection (F8) ───
//
// Truthful, read-only operational visibility over strategic governance state.
// This projection exposes: pending proposals, allowed recommendations,
// review-required decisions and blocked decisions, policy version, source
// trust, confidence, strategic risk, approval status, stale/expired status,
// blocker classification and recovery classification.
//
// It is a VIEW: it derives status from immutable decision rows and never
// mutates anything. No forceAllow/forceApprove/setTrusted/overrideRisk/
// overridePolicy exists anywhere in this stream; the only recovery writes are
// narrow, closed-vocabulary, audit-appended operator actions (see the service).
//
// Pure assembly: rows + clock -> projection. No I/O.

import {
  mapStrategicReasonCodeToBlockerClass,
  strategicRecoveryClassFor,
  type StrategicBlockerClass,
  type StrategicRecoveryClass,
} from "./strategic-blocker-taxonomy";
import type { StrategicGovernanceDecisionRow } from "./strategic-governance-store";

export type StrategicDecisionOperationalStatus =
  | "allowed"
  | "review_pending_approval"
  | "approved"
  | "blocked"
  | "expired"
  | "stale_policy";

export interface StrategicGovernanceProjectionItem {
  readonly governanceDecisionId: string;
  readonly businessId: number;
  readonly proposalId: string;
  readonly recommendationType: string;
  readonly decision: string;
  readonly operationalStatus: StrategicDecisionOperationalStatus;
  readonly policyVersion: string | null;
  readonly sourceTrustClass: string;
  readonly confidenceClass: string;
  readonly strategicRiskClass: string;
  readonly approvalRequired: boolean;
  readonly approvalStatus: "none" | "unknown" | "pending" | "approved" | "rejected";
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  readonly reasonCodes: readonly string[];
  readonly primaryBlockerClass: StrategicBlockerClass | null;
  readonly recoveryClass: StrategicRecoveryClass | null;
  readonly stale: boolean;
  readonly expired: boolean;
}

export interface StrategicGovernanceOperationsProjection {
  readonly generatedAt: string;
  readonly currentPolicyVersion: string;
  readonly counts: {
    readonly total: number;
    readonly allowed: number;
    readonly reviewPendingApproval: number;
    readonly approved: number;
    readonly blocked: number;
    readonly expired: number;
    readonly stalePolicy: number;
  };
  readonly riskProfile: {
    readonly low: number;
    readonly medium: number;
    readonly high: number;
    readonly critical: number;
  };
  readonly items: readonly StrategicGovernanceProjectionItem[];
}

export interface StrategicApprovalStatusView {
  readonly status: "pending" | "approved" | "rejected";
}

function parseStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string");
}

function deriveOperationalStatus(
  row: StrategicGovernanceDecisionRow,
  approval: StrategicApprovalStatusView | null | undefined,
  currentPolicyVersion: string,
  nowMs: number
): StrategicDecisionOperationalStatus {
  const expired =
    row.validUntil !== null && row.validUntil !== undefined && Date.parse(row.validUntil) <= nowMs;
  const stalePolicy = row.policyVersion !== null && row.policyVersion !== currentPolicyVersion;

  if (row.decision === "BLOCK") return "blocked";
  if (stalePolicy) return "stale_policy";
  if (expired) return "expired";
  if (row.decision === "ALLOW_RECOMMENDATION") return "allowed";
  // REVIEW_REQUIRED
  if (approval === undefined || approval === null) return "review_pending_approval";
  if (approval.status === "approved") return "approved";
  return "review_pending_approval";
}

/**
 * Assemble the read-only operations projection. Approval status arrives from
 * the approval ledger lookup performed by the service (null = no approval row
 * found for the decision). Stale/expired status is computed, never stored, so
 * the view can never drift from the decisions it projects.
 */
export function buildStrategicGovernanceOperationsProjection(input: {
  rows: readonly StrategicGovernanceDecisionRow[];
  approvalStatusByDecisionId: Readonly<Map<string, StrategicApprovalStatusView | null>>;
  currentPolicyVersion: string;
  now: string;
}): StrategicGovernanceOperationsProjection {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new Error(`strategic operations projection: invalid now ${String(input.now)}`);
  }
  const items: StrategicGovernanceProjectionItem[] = input.rows.map((row) => {
    const reasonCodes = parseStringArray(row.reasonCodes);
    const approval = input.approvalStatusByDecisionId.get(row.governanceDecisionId);
    const operationalStatus = deriveOperationalStatus(
      row,
      approval,
      input.currentPolicyVersion,
      nowMs
    );
    const primaryReason = row.decision === "BLOCK" ? (reasonCodes[0] ?? null) : null;
    const blockerClass = mapStrategicReasonCodeToBlockerClass(primaryReason);
    const approvalStatus: StrategicGovernanceProjectionItem["approvalStatus"] =
      row.decision !== "REVIEW_REQUIRED"
        ? "none"
        : approval === undefined || approval === null
          ? "unknown"
          : approval.status;
    const expired =
      row.validUntil !== null &&
      row.validUntil !== undefined &&
      Date.parse(row.validUntil) <= nowMs;
    const stalePolicy =
      row.policyVersion !== null && row.policyVersion !== input.currentPolicyVersion;
    return Object.freeze({
      governanceDecisionId: row.governanceDecisionId,
      businessId: row.businessId,
      proposalId: row.proposalId,
      recommendationType: row.recommendationType,
      decision: row.decision,
      operationalStatus,
      policyVersion: row.policyVersion,
      sourceTrustClass: row.sourceTrustClass,
      confidenceClass: row.confidenceClass,
      strategicRiskClass: row.strategicRiskClass,
      approvalRequired: row.approvalRequired,
      approvalStatus,
      validUntil: row.validUntil,
      evaluatedAt: row.evaluatedAt,
      reasonCodes,
      primaryBlockerClass: blockerClass,
      recoveryClass: blockerClass === null ? null : strategicRecoveryClassFor(blockerClass),
      stale: stalePolicy,
      expired,
    });
  });

  const counts = {
    total: items.length,
    allowed: items.filter((i) => i.operationalStatus === "allowed").length,
    reviewPendingApproval: items.filter((i) => i.operationalStatus === "review_pending_approval").length,
    approved: items.filter((i) => i.operationalStatus === "approved").length,
    blocked: items.filter((i) => i.operationalStatus === "blocked").length,
    expired: items.filter((i) => i.operationalStatus === "expired").length,
    stalePolicy: items.filter((i) => i.operationalStatus === "stale_policy").length,
  };

  const riskProfile = {
    low: items.filter((i) => i.strategicRiskClass === "LOW").length,
    medium: items.filter((i) => i.strategicRiskClass === "MEDIUM").length,
    high: items.filter((i) => i.strategicRiskClass === "HIGH").length,
    critical: items.filter((i) => i.strategicRiskClass === "CRITICAL").length,
  };

  return Object.freeze({
    generatedAt: input.now,
    currentPolicyVersion: input.currentPolicyVersion,
    counts: Object.freeze(counts),
    riskProfile: Object.freeze(riskProfile),
    items: Object.freeze(items),
  });
}
