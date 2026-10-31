// ─── R9-F Mission Governance & Approval — canonical governance contract ───
//
// PURE contract module: closed vocabularies, version identities, deterministic
// id/hash derivations, typed error taxonomy, zod router-input schemas and
// canonical hashing helpers for the mission-governance authority
// (docs/contracts/mission-governance-contract.md).
// It performs no I/O of any kind and authorizes nothing.
//
// A mission governance decision is AUTHORITY derived from a validated action
// proposal + versioned policy + SERVER-DERIVED mission risk + phase autonomy
// ceilings + tenant ownership only. No model sits in the decision path; no
// client may supply decisions, risk classes, reason codes, approval state or
// policy content. Model/agent output is proposal material only — never
// authority. The only possible outcomes are ALLOW / REVIEW_REQUIRED / BLOCK:
// there is deliberately NO EXECUTE outcome anywhere in this stream.
//
// Charter: planning authority != execution authority; mission approval !=
// task approval; retry authority != new action authority; no agent may
// approve itself.

import { createHash } from "crypto";
import { z } from "zod";

export const MISSION_GOVERNANCE_CONTRACT_VERSION = "mission-governance/v1" as const;
export const MISSION_GOVERNANCE_ENGINE_VERSION = "mission-governance-engine/v1" as const;
export const DEFAULT_MISSION_POLICY_VERSION = "mission-governance-policy/v1" as const;

export const MISSION_DECISION_ID_PREFIX = "mgd1:" as const;
export const MISSION_DECISION_ID_PATTERN = /^mgd1:[a-f0-9]{64}$/;
export const MISSION_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const HEX_64 = /^[a-f0-9]{64}$/;

export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value);
}

// ─── Closed governance decision vocabulary (F1) ───
//
// Exhaustive: downstream R9 streams must never invent additional outcomes.
// Anything outside this vocabulary is a programming error, not a decision.
// There is NO "EXECUTE" — an ALLOW is bounded authority for the exact bound
// subject/action only, never a blanket mission authorization.

export const MISSION_GOVERNANCE_DECISIONS = ["ALLOW", "REVIEW_REQUIRED", "BLOCK"] as const;
export type MissionGovernanceDecision = (typeof MISSION_GOVERNANCE_DECISIONS)[number];

const MISSION_GOVERNANCE_DECISION_SET: ReadonlySet<string> = new Set(
  MISSION_GOVERNANCE_DECISIONS
);

export function isMissionGovernanceDecision(value: unknown): value is MissionGovernanceDecision {
  return typeof value === "string" && MISSION_GOVERNANCE_DECISION_SET.has(value);
}

/**
 * Autonomy ranking: BLOCK < REVIEW_REQUIRED < ALLOW. Governance may only ever
 * narrow (move down) as more constraints apply; no evaluation path may widen a
 * disposition (charter core principle; contract §3).
 */
export const MISSION_DECISION_AUTONOMY_RANK: Readonly<Record<MissionGovernanceDecision, number>> = {
  ALLOW: 2,
  REVIEW_REQUIRED: 1,
  BLOCK: 0,
};

// ─── Closed mission risk classes (F3) ───

export const MISSION_RISK_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type MissionRiskClass = (typeof MISSION_RISK_CLASSES)[number];

const MISSION_RISK_CLASS_SET: ReadonlySet<string> = new Set(MISSION_RISK_CLASSES);

export function isMissionRiskClass(value: unknown): value is MissionRiskClass {
  return typeof value === "string" && MISSION_RISK_CLASS_SET.has(value);
}

export const MISSION_RISK_CLASS_RANK: Readonly<Record<MissionRiskClass, number>> = {
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
};

// ─── Closed mission phases (F2 — phase-separated authorization) ───

export const MISSION_PHASES = [
  "FORMULATION",
  "PLANNING",
  "SCHEDULING",
  "EXECUTION",
  "LIFECYCLE",
] as const;
export type MissionPhase = (typeof MISSION_PHASES)[number];

const MISSION_PHASE_SET: ReadonlySet<string> = new Set(MISSION_PHASES);

export function isMissionPhase(value: unknown): value is MissionPhase {
  return typeof value === "string" && MISSION_PHASE_SET.has(value);
}

// ─── Closed governed subject classes (F1) ───
//
// Adapted to the actual architecture: mission/plan/schedule/task stores are
// sibling R9-stream concerns, so R9-F binds them as opaque pattern-checked
// references and governs the decision surface only.

export const MISSION_SUBJECT_CLASSES = [
  "MISSION_PROPOSAL",
  "MISSION_PLAN",
  "MISSION_SCHEDULE",
  "TASK",
  "EXECUTION_STEP",
  "RETRY",
  "RECOVERY_ACTION",
  "CANCELLATION",
  "ESCALATION",
] as const;
export type MissionSubjectClass = (typeof MISSION_SUBJECT_CLASSES)[number];

const MISSION_SUBJECT_CLASS_SET: ReadonlySet<string> = new Set(MISSION_SUBJECT_CLASSES);

export function isMissionSubjectClass(value: unknown): value is MissionSubjectClass {
  return typeof value === "string" && MISSION_SUBJECT_CLASS_SET.has(value);
}

/** The phase each subject class belongs to (F2). */
export const MISSION_PHASE_BY_SUBJECT_CLASS: Readonly<Record<MissionSubjectClass, MissionPhase>> =
  Object.freeze({
    MISSION_PROPOSAL: "FORMULATION",
    MISSION_PLAN: "PLANNING",
    MISSION_SCHEDULE: "SCHEDULING",
    TASK: "EXECUTION",
    EXECUTION_STEP: "EXECUTION",
    RETRY: "LIFECYCLE",
    RECOVERY_ACTION: "LIFECYCLE",
    CANCELLATION: "LIFECYCLE",
    ESCALATION: "LIFECYCLE",
  });

export function phaseOfMissionSubjectClass(subjectClass: MissionSubjectClass): MissionPhase {
  return MISSION_PHASE_BY_SUBJECT_CLASS[subjectClass];
}

// ─── Closed action taxonomy (F1) ───
//
// The governed action vocabulary for mission subjects. Policy marks a closed
// subset as prohibited (default: MODIFY_POLICY, SELF_APPROVE, INVOKE_BILLING,
// ACCESS_SECRETS, ALTER_PERMISSIONS); unknown values are BLOCKED durably.

export const MISSION_ACTION_TYPES = [
  "FORMULATE_MISSION",
  "BIND_OBJECTIVES",
  "PLAN_TASKS",
  "SEQUENCE_DEPENDENCIES",
  "COMMIT_SCHEDULE",
  "EXECUTE_TASK",
  "EXECUTE_STEP",
  "RETRY_STEP",
  "INVOKE_PROVIDER",
  "MUTATE_DATA",
  "ACTIVATE_CAMPAIGN",
  "CONSUME_BUDGET",
  "CANCEL_MISSION",
  "ESCALATE_TO_HUMAN",
  "RECOVER_STATE",
  "MODIFY_POLICY",
  "SELF_APPROVE",
  "INVOKE_BILLING",
  "ACCESS_SECRETS",
  "ALTER_PERMISSIONS",
] as const;
export type MissionActionType = (typeof MISSION_ACTION_TYPES)[number];

const MISSION_ACTION_TYPE_SET: ReadonlySet<string> = new Set(MISSION_ACTION_TYPES);

export function isMissionActionType(value: unknown): value is MissionActionType {
  return typeof value === "string" && MISSION_ACTION_TYPE_SET.has(value);
}

/** Actions policy prohibits outright by default (F8 rogue-agent surface). */
export const DEFAULT_PROHIBITED_ACTION_TYPES: readonly MissionActionType[] = Object.freeze([
  "MODIFY_POLICY",
  "SELF_APPROVE",
  "INVOKE_BILLING",
  "ACCESS_SECRETS",
  "ALTER_PERMISSIONS",
]);

/**
 * Closed governance reason codes. Bounded: a decision carries at most
 * MAX_MISSION_REASON_CODES codes (deterministic selection order).
 */
export const MISSION_GOVERNANCE_REASON_CODES = [
  "MISSION_ALLOWED_BY_POLICY",
  "MISSION_BLOCKED_BY_POLICY",
  "UNKNOWN_SUBJECT_CLASS",
  "UNKNOWN_ACTION_TYPE",
  "PROHIBITED_ACTION_TYPE",
  "POLICY_MISSING",
  "UNKNOWN_POLICY_VERSION",
  "STALE_POLICY_VERSION",
  "OWNERSHIP_MISMATCH",
  "CROSS_TENANT_MISSION",
  "MALFORMED_PROPOSAL",
  "DECLARED_IMPACT_RAISES_RISK",
  "PROMPT_INJECTION_SUSPECTED",
  "CLIENT_AUTHORITY_FIELD_REJECTED",
  "PHASE_REQUIRES_REVIEW",
  "EXECUTION_REQUIRES_REVIEW",
  "LIFECYCLE_REQUIRES_REVIEW",
  "RECOVERY_REQUIRES_FRESH_REVIEW",
  "RETRY_NEW_SIDE_EFFECT_REVIEW",
  "RETRY_SCOPE_BROADENED",
  "HIGH_RISK_REVIEW_REQUIRED",
  "CRITICAL_RISK_BLOCKED",
  "APPROVAL_REQUIRED_BY_RISK",
  "APPROVAL_NOT_FOUND",
  "APPROVAL_PENDING",
  "APPROVAL_REJECTED_BY_HUMAN",
  "APPROVAL_BINDING_MISMATCH",
  "EXPIRED_APPROVAL",
  "EXPIRED_DECISION",
  "AGENT_SELF_APPROVAL_FORBIDDEN",
] as const;
export type MissionGovernanceReasonCode = (typeof MISSION_GOVERNANCE_REASON_CODES)[number];

const MISSION_GOVERNANCE_REASON_CODE_SET: ReadonlySet<string> = new Set(
  MISSION_GOVERNANCE_REASON_CODES
);

export function isMissionGovernanceReasonCode(
  value: unknown
): value is MissionGovernanceReasonCode {
  return typeof value === "string" && MISSION_GOVERNANCE_REASON_CODE_SET.has(value);
}

export const MAX_MISSION_REASON_CODES = 8;

// ─── Deterministic id/hash derivations (contract §9) ───
//
// Each derivation rebuilds its hashed fragment field-by-field: callers cannot
// smuggle extra keys into a hash. Same authoritative inputs ⇒ same output;
// any material change ⇒ new identity.

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    return value;
  }
  if (Array.isArray(value)) return value.map(sortKeys);
  const sorted: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

/** Canonical JSON (key-sorted, whitespace-normalised) for stable hashing. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

export function sha256Hex(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Deterministic fingerprint of the exact action parameters. The raw params
 * are NEVER persisted — only this fingerprint — so a modified action after
 * approval invalidates the binding (F4/F10 AC7) while the authoritative
 * params stay out of the durable store.
 */
export function deriveActionParamsFingerprint(actionParams: unknown): string {
  return sha256Hex(canonicalJson({ v: 1, params: actionParams }));
}

/**
 * Deterministic governance decision identity (the immutable receipt anchor,
 * F5): one set of authoritative coordinates + one policy version + one exact
 * action fingerprint -> one stable governanceDecisionId. Retries and
 * concurrent evaluations converge through the durable store's unique insert
 * anchor.
 */
export function deriveMissionGovernanceDecisionId(input: {
  userId: number;
  businessId: number;
  missionRef: string;
  planRef: string | null;
  taskRef: string | null;
  subjectClass: string;
  actionType: string;
  policyVersion: string;
  actionParamsFingerprint: string;
}): string {
  return `${MISSION_DECISION_ID_PREFIX}${sha256Hex(
    canonicalJson({
      v: 1,
      userId: input.userId,
      businessId: input.businessId,
      missionRef: input.missionRef,
      planRef: input.planRef,
      taskRef: input.taskRef,
      subjectClass: input.subjectClass,
      actionType: input.actionType,
      policyVersion: input.policyVersion,
      actionParamsFingerprint: input.actionParamsFingerprint,
    })
  )}`;
}

/** Deterministic approval binding hash (F4): binds decision + policy version + exact action fingerprint + risk class. */
export function deriveMissionApprovalBindingHash(input: {
  governanceDecisionId: string;
  policyVersion: string;
  actionParamsFingerprint: string;
  missionRiskClass: string;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      policyVersion: input.policyVersion,
      actionParamsFingerprint: input.actionParamsFingerprint,
      missionRiskClass: input.missionRiskClass,
    })
  );
}

/** Deterministic evaluation fingerprint for replay/evidence verification. */
export function deriveEvaluationFingerprint(input: {
  governanceDecisionId: string;
  decision: string;
  reasonCodes: readonly string[];
  missionRiskClass: string;
  policyVersion: string | null;
  actionParamsFingerprint: string;
  approvalRequired: boolean;
}): string {
  return sha256Hex(
    canonicalJson({
      v: 1,
      governanceDecisionId: input.governanceDecisionId,
      decision: input.decision,
      reasonCodes: input.reasonCodes,
      missionRiskClass: input.missionRiskClass,
      policyVersion: input.policyVersion,
      actionParamsFingerprint: input.actionParamsFingerprint,
      approvalRequired: input.approvalRequired,
    })
  );
}

// ─── Typed error taxonomy (fail closed, mirrors R8-F/R7-F discipline) ───

export type MissionGovernanceErrorCode =
  | "MALFORMED_PROPOSAL"
  | "INVALID_RETRY_CONTEXT"
  | "UNKNOWN_SUBJECT_CLASS"
  | "UNKNOWN_ACTION_TYPE"
  | "UNKNOWN_POLICY_VERSION"
  | "POLICY_VERSION_CONFLICT"
  | "POLICY_MISSING"
  | "OWNERSHIP_MISMATCH"
  | "CROSS_TENANT_MISSION"
  | "GOVERNANCE_DECISION_NOT_FOUND"
  | "GOVERNANCE_REPLAY_CONFLICT"
  | "GOVERNANCE_AUTHORITY_UNAVAILABLE"
  | "INVALID_POLICY"
  | "CLIENT_AUTHORITY_FIELD_REJECTED"
  | "RECOVERY_ACTION_FORBIDDEN"
  | "INVALID_RECOVERY_ACTION"
  | "INVALID_EVALUATION_CLOCK"
  | "INVALID_DECISION_IDENTITY"
  | "INVALID_APPROVAL_INPUT"
  | "INVALID_APPROVAL_MODE"
  | "APPROVAL_NOT_FOUND"
  | "APPROVAL_BINDING_MISMATCH"
  | "EXPIRED_APPROVAL"
  | "REVIEW_CHALLENGE_UNAVAILABLE"
  | "REVIEW_CHALLENGE_INVALID";

export class MissionGovernanceError extends Error {
  readonly code: MissionGovernanceErrorCode;
  constructor(code: MissionGovernanceErrorCode, message: string) {
    super(message);
    this.name = "MissionGovernanceError";
    this.code = code;
  }
}

export class MissionGovernanceInputError extends MissionGovernanceError {
  constructor(code: MissionGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "MissionGovernanceInputError";
  }
}

export class MissionGovernanceOwnershipError extends MissionGovernanceError {
  constructor(code: MissionGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "MissionGovernanceOwnershipError";
  }
}

export class MissionGovernanceValidationError extends MissionGovernanceError {
  constructor(code: MissionGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "MissionGovernanceValidationError";
  }
}

export class MissionGovernanceStateConflictError extends MissionGovernanceError {
  constructor(code: MissionGovernanceErrorCode, message: string) {
    super(code, message);
    this.name = "MissionGovernanceStateConflictError";
  }
}

// ─── zod router-input schemas ───
//
// z.strictObject rejects unknown keys: no client-supplied authority of any
// kind (decision, reason codes, risk class, approval state, policy content,
// fingerprints, authorization). Clients reference ids and propose material
// only.

export const EvaluateMissionGovernanceInputSchema = z.strictObject({
  proposal: z.unknown(),
  policyVersion: z.string().min(1).max(96).optional(),
});
export type EvaluateMissionGovernanceInput = z.infer<typeof EvaluateMissionGovernanceInputSchema>;

export const GetMissionGovernanceDecisionInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(MISSION_DECISION_ID_PATTERN),
});
export type GetMissionGovernanceDecisionInput = z.infer<
  typeof GetMissionGovernanceDecisionInputSchema
>;

export const ListMissionGovernanceDecisionsInputSchema = z.strictObject({
  businessId: z.number().int().positive().optional(),
  missionRef: z.string().regex(MISSION_REF_PATTERN).optional(),
  decision: z.enum(MISSION_GOVERNANCE_DECISIONS).optional(),
});
export type ListMissionGovernanceDecisionsInput = z.infer<
  typeof ListMissionGovernanceDecisionsInputSchema
>;

export const RevalidateMissionGovernanceDecisionInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(MISSION_DECISION_ID_PATTERN),
  proposal: z.unknown().optional(),
});
export type RevalidateMissionGovernanceDecisionInput = z.infer<
  typeof RevalidateMissionGovernanceDecisionInputSchema
>;

/** Narrow, closed recovery vocabulary (F8): no forceAllow/forceApprove/setApproved/overridePolicy. */
export const MISSION_RECOVERY_ACTIONS = [
  "operator_acknowledged",
  "operator_requeued",
  "operator_dismissed",
] as const;
export type MissionRecoveryAction = (typeof MISSION_RECOVERY_ACTIONS)[number];

export const RecordMissionGovernanceRecoveryInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(MISSION_DECISION_ID_PATTERN),
  action: z.enum(MISSION_RECOVERY_ACTIONS),
  note: z.string().min(1).max(500),
});
export type RecordMissionGovernanceRecoveryInput = z.infer<
  typeof RecordMissionGovernanceRecoveryInputSchema
>;

// ─── F4/F5 approval resolution surface schemas (human review) ───

export const RequestMissionApprovalChallengeInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(MISSION_DECISION_ID_PATTERN),
});
export type RequestMissionApprovalChallengeInput = z.infer<
  typeof RequestMissionApprovalChallengeInputSchema
>;

export const ResolveMissionApprovalChallengeInputSchema = z.strictObject({
  governanceDecisionId: z.string().regex(MISSION_DECISION_ID_PATTERN),
  challengeToken: z.string().min(1).max(255),
  code: z.string().min(4).max(12),
});
export type ResolveMissionApprovalChallengeInput = z.infer<
  typeof ResolveMissionApprovalChallengeInputSchema
>;
