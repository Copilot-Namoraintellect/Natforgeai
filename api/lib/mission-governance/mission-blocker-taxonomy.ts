// ─── R9-F Mission Governance & Approval — blocker taxonomy ───
//
// Closed blocker classes for mission-governance decisions, each mapped to a
// closed recovery class. There is deliberately no forceAllow/forceApprove/
// setApproved/overrideRisk/overridePolicy anywhere: the only recovery writes
// are narrow, closed-vocabulary, audit-appended operator actions (see the
// service). Pure module: no I/O.

import type { MissionGovernanceReasonCode } from "./mission-governance-contract";

export const MISSION_BLOCKER_CLASSES = [
  "POLICY",
  "TENANT_OWNERSHIP",
  "UNKNOWN_SUBJECT_OR_ACTION",
  "PROHIBITED_ACTION",
  "RISK_REVIEW",
  "PHASE_SEPARATION",
  "RETRY_GOVERNANCE",
  "RECOVERY_GOVERNANCE",
  "APPROVAL_LIFECYCLE",
  "EXPIRY",
] as const;
export type MissionBlockerClass = (typeof MISSION_BLOCKER_CLASSES)[number];

export const MISSION_RECOVERY_CLASSES = [
  "AUTO_RECOVER",
  "OPERATOR_ACTION",
  "FAIL_CLOSED",
  "GOVERNANCE_APPROVAL",
] as const;
export type MissionRecoveryClass = (typeof MISSION_RECOVERY_CLASSES)[number];

const REASON_TO_BLOCKER: Readonly<Record<MissionGovernanceReasonCode, MissionBlockerClass | null>> =
  Object.freeze({
    MISSION_ALLOWED_BY_POLICY: null,
    MISSION_BLOCKED_BY_POLICY: "POLICY",
    UNKNOWN_SUBJECT_CLASS: "UNKNOWN_SUBJECT_OR_ACTION",
    UNKNOWN_ACTION_TYPE: "UNKNOWN_SUBJECT_OR_ACTION",
    PROHIBITED_ACTION_TYPE: "PROHIBITED_ACTION",
    POLICY_MISSING: "POLICY",
    UNKNOWN_POLICY_VERSION: "POLICY",
    STALE_POLICY_VERSION: "POLICY",
    OWNERSHIP_MISMATCH: "TENANT_OWNERSHIP",
    CROSS_TENANT_MISSION: "TENANT_OWNERSHIP",
    MALFORMED_PROPOSAL: "POLICY",
    DECLARED_IMPACT_RAISES_RISK: "RISK_REVIEW",
    PROMPT_INJECTION_SUSPECTED: "RISK_REVIEW",
    CLIENT_AUTHORITY_FIELD_REJECTED: "POLICY",
    PHASE_REQUIRES_REVIEW: "PHASE_SEPARATION",
    EXECUTION_REQUIRES_REVIEW: "PHASE_SEPARATION",
    LIFECYCLE_REQUIRES_REVIEW: "PHASE_SEPARATION",
    RECOVERY_REQUIRES_FRESH_REVIEW: "RECOVERY_GOVERNANCE",
    RETRY_NEW_SIDE_EFFECT_REVIEW: "RETRY_GOVERNANCE",
    RETRY_SCOPE_BROADENED: "RETRY_GOVERNANCE",
    HIGH_RISK_REVIEW_REQUIRED: "RISK_REVIEW",
    CRITICAL_RISK_BLOCKED: "RISK_REVIEW",
    APPROVAL_REQUIRED_BY_RISK: "RISK_REVIEW",
    APPROVAL_NOT_FOUND: "APPROVAL_LIFECYCLE",
    APPROVAL_PENDING: "APPROVAL_LIFECYCLE",
    APPROVAL_REJECTED_BY_HUMAN: "APPROVAL_LIFECYCLE",
    APPROVAL_BINDING_MISMATCH: "APPROVAL_LIFECYCLE",
    EXPIRED_APPROVAL: "EXPIRY",
    EXPIRED_DECISION: "EXPIRY",
    AGENT_SELF_APPROVAL_FORBIDDEN: "APPROVAL_LIFECYCLE",
  });

export function mapMissionReasonCodeToBlockerClass(
  reason: MissionGovernanceReasonCode | null
): MissionBlockerClass | null {
  if (reason === null) return null;
  return REASON_TO_BLOCKER[reason] ?? null;
}

const BLOCKER_TO_RECOVERY: Readonly<Record<MissionBlockerClass, MissionRecoveryClass>> =
  Object.freeze({
    POLICY: "OPERATOR_ACTION",
    TENANT_OWNERSHIP: "FAIL_CLOSED",
    UNKNOWN_SUBJECT_OR_ACTION: "OPERATOR_ACTION",
    PROHIBITED_ACTION: "FAIL_CLOSED",
    RISK_REVIEW: "GOVERNANCE_APPROVAL",
    PHASE_SEPARATION: "GOVERNANCE_APPROVAL",
    RETRY_GOVERNANCE: "GOVERNANCE_APPROVAL",
    RECOVERY_GOVERNANCE: "GOVERNANCE_APPROVAL",
    APPROVAL_LIFECYCLE: "OPERATOR_ACTION",
    EXPIRY: "AUTO_RECOVER",
  });

export function missionRecoveryClassFor(blocker: MissionBlockerClass): MissionRecoveryClass {
  return BLOCKER_TO_RECOVERY[blocker];
}
