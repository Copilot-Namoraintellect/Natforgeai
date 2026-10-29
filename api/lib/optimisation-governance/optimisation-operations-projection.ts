// ─── R7-F Optimisation Governance — operations projection (F8) ───
//
// Truthful, read-only operational visibility over optimisation governance
// state. This projection exposes: pending proposals, allowed, review-required
// and blocked decisions, policy/version, financial impact, approval status,
// stale decisions, expired decisions and failure/recovery classification.
//
// It is a VIEW: it derives status from immutable decision rows and never
// mutates anything. No forceAllow/forceComplete/setApproved/overridePolicy
// exists anywhere in this stream; the only recovery writes are narrow,
// closed-vocabulary, audit-appended operator actions (see the service).
//
// Pure assembly: rows + clock -> projection. No I/O.

import {
  mapReasonCodeToBlockerClass,
  recoveryClassFor,
  type OptimisationBlockerClass,
  type OptimisationRecoveryClass,
} from "./optimisation-blocker-taxonomy";
import type { OptimisationGovernanceDecisionRow } from "./optimisation-governance-store";

export type OptimisationDecisionOperationalStatus =
  | "allowed"
  | "review_pending_approval"
  | "approved"
  | "blocked"
  | "expired"
  | "stale_policy";

export interface OptimisationGovernanceProjectionItem {
  readonly governanceDecisionId: string;
  readonly businessId: number;
  readonly proposalId: string;
  readonly proposalType: string;
  readonly decision: string;
  readonly operationalStatus: OptimisationDecisionOperationalStatus;
  readonly policyVersion: string | null;
  readonly riskClass: string;
  readonly financialImpactClass: string;
  readonly financialDeltaMinor: number;
  readonly approvalRequired: boolean;
  readonly approvalStatus: "none" | "unknown" | "pending" | "approved" | "rejected";
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  readonly reasonCodes: readonly string[];
  readonly primaryBlockerClass: OptimisationBlockerClass | null;
  readonly recoveryClass: OptimisationRecoveryClass | null;
  readonly stale: boolean;
  readonly expired: boolean;
}

export interface OptimisationGovernanceOperationsProjection {
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
  readonly financialImpactMinor: {
    readonly allowedDelta: number;
    readonly reviewDelta: number;
    readonly blockedDelta: number;
  };
  readonly items: readonly OptimisationGovernanceProjectionItem[];
}

export interface OptimisationApprovalStatusView {
  readonly status: "pending" | "approved" | "rejected";
}

function parseReasonCodes(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string");
}

function deriveOperationalStatus(
  row: OptimisationGovernanceDecisionRow,
  approval: OptimisationApprovalStatusView | null | undefined,
  currentPolicyVersion: string,
  nowMs: number
): OptimisationDecisionOperationalStatus {
  const expired =
    row.validUntil !== null && row.validUntil !== undefined && Date.parse(row.validUntil) <= nowMs;
  const stalePolicy = row.policyVersion !== null && row.policyVersion !== currentPolicyVersion;

  if (row.decision === "BLOCK") return "blocked";
  if (stalePolicy) return "stale_policy";
  if (expired) return "expired";
  if (row.decision === "ALLOW") return "allowed";
  // REVIEW_REQUIRED
  if (approval === undefined || approval === null) return "review_pending_approval";
  if (approval.status === "approved") return "approved";
  return "review_pending_approval";
}

/**
 * Assemble the read-only operations projection. Approval status arrives from
 * the approval ledger lookup performed by the service (null = no approval row
 * found for the decision).
 */
export function buildOptimisationGovernanceOperationsProjection(input: {
  rows: readonly OptimisationGovernanceDecisionRow[];
  approvalStatusByDecisionId: Readonly<Map<string, OptimisationApprovalStatusView | null>>;
  currentPolicyVersion: string;
  now: string;
}): OptimisationGovernanceOperationsProjection {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new Error(`optimisation operations projection: invalid now ${String(input.now)}`);
  }
  const items: OptimisationGovernanceProjectionItem[] = input.rows.map((row) => {
    const reasonCodes = parseReasonCodes(row.reasonCodes);
    const approval = input.approvalStatusByDecisionId.get(row.governanceDecisionId);
    const operationalStatus = deriveOperationalStatus(
      row,
      approval,
      input.currentPolicyVersion,
      nowMs
    );
    const primaryReason = row.decision === "BLOCK" ? (reasonCodes[0] ?? null) : null;
    const blockerClass = mapReasonCodeToBlockerClass(primaryReason);
    const approvalStatus: OptimisationGovernanceProjectionItem["approvalStatus"] =
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
      proposalType: row.proposalType,
      decision: row.decision,
      operationalStatus,
      policyVersion: row.policyVersion,
      riskClass: row.riskClass,
      financialImpactClass: row.financialImpactClass,
      financialDeltaMinor: row.financialDeltaMinor,
      approvalRequired: row.approvalRequired,
      approvalStatus,
      validUntil: row.validUntil,
      evaluatedAt: row.evaluatedAt,
      reasonCodes,
      primaryBlockerClass: blockerClass,
      recoveryClass: blockerClass === null ? null : recoveryClassFor(blockerClass),
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

  const financialImpactMinor = {
    allowedDelta: items
      .filter((i) => i.operationalStatus === "allowed")
      .reduce((sum, i) => sum + i.financialDeltaMinor, 0),
    reviewDelta: items
      .filter(
        (i) =>
          i.operationalStatus === "review_pending_approval" || i.operationalStatus === "approved"
      )
      .reduce((sum, i) => sum + i.financialDeltaMinor, 0),
    blockedDelta: items
      .filter((i) => i.operationalStatus === "blocked")
      .reduce((sum, i) => sum + i.financialDeltaMinor, 0),
  };

  return Object.freeze({
    generatedAt: input.now,
    currentPolicyVersion: input.currentPolicyVersion,
    counts: Object.freeze(counts),
    financialImpactMinor: Object.freeze(financialImpactMinor),
    items: Object.freeze(items),
  });
}
