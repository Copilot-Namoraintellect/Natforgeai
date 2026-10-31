// ─── R9-F Mission Governance & Approval — operations projection (F8) ───
//
// Truthful, read-only operational visibility over mission-governance state:
// allowed actions, review-required decisions awaiting approval, approved
// actions, blocked decisions, policy version, mission risk, approval status,
// stale/expired status, blocker classification and recovery classification.
//
// It is a VIEW: it derives status from immutable receipt rows and never
// mutates anything. No forceAllow/forceApprove/override* exists anywhere in
// this stream; the only recovery writes are narrow, closed-vocabulary,
// audit-appended operator actions (see the service).
//
// Pure assembly: rows + clock -> projection. No I/O.

import {
  mapMissionReasonCodeToBlockerClass,
  missionRecoveryClassFor,
  type MissionBlockerClass,
  type MissionRecoveryClass,
} from "./mission-blocker-taxonomy";
import { MISSION_PHASE_BY_SUBJECT_CLASS } from "./mission-governance-contract";
import type { MissionGovernanceDecisionRow } from "./mission-governance-store";

export type MissionDecisionOperationalStatus =
  | "allowed"
  | "review_pending_approval"
  | "approved"
  | "blocked"
  | "expired"
  | "stale_policy";

export interface MissionGovernanceProjectionItem {
  readonly governanceDecisionId: string;
  readonly businessId: number;
  readonly missionRef: string;
  readonly planRef: string | null;
  readonly taskRef: string | null;
  readonly subjectClass: string;
  readonly phase: string;
  readonly actionType: string;
  readonly decision: string;
  readonly operationalStatus: MissionDecisionOperationalStatus;
  readonly policyVersion: string | null;
  readonly missionRiskClass: string;
  readonly approvalRequired: boolean;
  readonly approvalStatus: "none" | "unknown" | "pending" | "approved" | "rejected";
  readonly validUntil: string | null;
  readonly evaluatedAt: string;
  readonly reasonCodes: readonly string[];
  readonly primaryBlockerClass: MissionBlockerClass | null;
  readonly recoveryClass: MissionRecoveryClass | null;
  readonly stale: boolean;
  readonly expired: boolean;
}

export interface MissionGovernanceOperationsProjection {
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
  readonly items: readonly MissionGovernanceProjectionItem[];
}

export interface MissionApprovalStatusView {
  readonly status: "pending" | "approved" | "rejected";
}

function parseStringArray(raw: unknown): readonly string[] {
  if (!Array.isArray(raw)) return [];
  return raw.filter((c): c is string => typeof c === "string");
}

function deriveOperationalStatus(
  row: MissionGovernanceDecisionRow,
  approval: MissionApprovalStatusView | null | undefined,
  currentPolicyVersion: string,
  nowMs: number
): MissionDecisionOperationalStatus {
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
 * found for the decision). Stale/expired status is computed, never stored, so
 * the view can never drift from the receipts it projects.
 */
export function buildMissionGovernanceOperationsProjection(input: {
  rows: readonly MissionGovernanceDecisionRow[];
  approvalStatusByDecisionId: Readonly<Map<string, MissionApprovalStatusView | null>>;
  currentPolicyVersion: string;
  now: string;
}): MissionGovernanceOperationsProjection {
  const nowMs = Date.parse(input.now);
  if (Number.isNaN(nowMs)) {
    throw new Error(`mission operations projection: invalid now ${String(input.now)}`);
  }
  const items: MissionGovernanceProjectionItem[] = input.rows.map((row) => {
    const reasonCodes = parseStringArray(row.reasonCodes);
    const approval = input.approvalStatusByDecisionId.get(row.governanceDecisionId);
    const operationalStatus = deriveOperationalStatus(
      row,
      approval,
      input.currentPolicyVersion,
      nowMs
    );
    const primaryReason = row.decision === "BLOCK" ? (reasonCodes[0] ?? null) : null;
    const blockerClass = mapMissionReasonCodeToBlockerClass(primaryReason);
    const approvalStatus: MissionGovernanceProjectionItem["approvalStatus"] =
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
      missionRef: row.missionRef,
      planRef: row.planRef,
      taskRef: row.taskRef,
      subjectClass: row.subjectClass,
      phase:
        MISSION_PHASE_BY_SUBJECT_CLASS[
          row.subjectClass as keyof typeof MISSION_PHASE_BY_SUBJECT_CLASS
        ] ?? "UNKNOWN",
      actionType: row.actionType,
      decision: row.decision,
      operationalStatus,
      policyVersion: row.policyVersion,
      missionRiskClass: row.missionRiskClass,
      approvalRequired: row.approvalRequired,
      approvalStatus,
      validUntil: row.validUntil,
      evaluatedAt: row.evaluatedAt,
      reasonCodes,
      primaryBlockerClass: blockerClass,
      recoveryClass: blockerClass === null ? null : missionRecoveryClassFor(blockerClass),
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
    low: items.filter((i) => i.missionRiskClass === "LOW").length,
    medium: items.filter((i) => i.missionRiskClass === "MEDIUM").length,
    high: items.filter((i) => i.missionRiskClass === "HIGH").length,
    critical: items.filter((i) => i.missionRiskClass === "CRITICAL").length,
  };

  return Object.freeze({
    generatedAt: input.now,
    currentPolicyVersion: input.currentPolicyVersion,
    counts: Object.freeze(counts),
    riskProfile: Object.freeze(riskProfile),
    items: Object.freeze(items),
  });
}
