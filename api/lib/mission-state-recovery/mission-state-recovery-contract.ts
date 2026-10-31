// ─── R9-E Mission State, Recovery & Observability — canonical contract ───
//
// PURE contract module: closed vocabularies, version identities, identity
// patterns, typed error taxonomy, zod router-input schemas and
// client-authority rejection for the mission-state/recovery/observability
// authority (docs/contracts/mission-state-recovery-contract.md).
// No I/O of any kind; authorizes nothing; executes nothing; invokes nothing.
//
// Mission operational state, task operational state, mission health and
// recovery candidates are DERIVED from authoritative upstream records
// (R9-A/B/C lifecycle, R9-D immutable execution history, R9-F governance)
// — never set by client or model. Execution history is immutable input.
// Observability != authority. Recovery proposal != recovery authorization.
// Retry proposal != retry authorization. Authorized recovery != execution.
//
// z.strictObject everywhere: clients name missions/tasks/candidates and
// bounded material only — never identity, state, health, classifications,
// decisions, approvals, fingerprints or authorization material.

import { z } from "zod";

// ─── Versions ───

export const MISSION_STATE_RECOVERY_CONTRACT_VERSION = "mission-state-recovery/v1" as const;
export const MISSION_STATE_RECOVERY_ENGINE_VERSION = "mission-state-recovery-engine/v1" as const;
export const MISSION_STATE_TO_MISSION_CONTROL_PROJECTION_VERSION = "mission-state-to-mission-control/v1" as const;

/** Frozen upstream contract versions this stream binds (contract §2). */
export const MISSION_STATE_BOUND_VERSIONS = Object.freeze({
  missionAuthority: "mission-authority/v1",
  missionPlanning: "mission-planning/v1",
  missionScheduling: "mission-dependency-scheduling/v1",
  missionExecution: "mission-execution-coordination/v1",
  missionExecutionProjection: "mission-execution-to-state-recovery/v1",
  missionGovernance: "mission-governance/v1",
  missionGovernanceGate: "mission-governance-to-execution/v1",
});

/** Bound frozen policy version (mission-governance-policy/v1 @ R9-F 1665d2f). */
export const BOUND_MISSION_RECOVERY_POLICY_VERSION = "mission-governance-policy/v1" as const;

/** Verbatim disclaimers preserved on every surface. */
export const MISSION_STATE_OBSERVABILITY_DISCLAIMER =
  "observability != authority. Mission state is derived from authoritative upstream records; " +
  "this surface authorizes nothing and mutates nothing upstream. Recovery proposal != recovery " +
  "authorization; authorized recovery != execution.";

export const MISSION_STATE_HISTORY_DISCLAIMER =
  "execution history is immutable input. Uncertainty != success; failure is never silently " +
  "converted to success. No consumer may rewrite R9-D execution records.";

// ─── Identity patterns ───

export const MISSION_STATE_ID_PATTERN = /^mst1:[a-f0-9]{64}$/;
export const TASK_STATE_ID_PATTERN = /^tst1:[a-f0-9]{64}$/;
export const RECOVERY_CANDIDATE_ID_PATTERN = /^rcn1:[a-f0-9]{64}$/;
export const RECOVERY_LIFECYCLE_ID_PATTERN = /^rcl1:[a-f0-9]{64}$/;
export const TIMELINE_EVENT_ID_PATTERN = /^mot1:[a-f0-9]{64}$/;
export const MISSION_ID_PATTERN = /^mis1:[a-f0-9]{64}$/;
export const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const SCHEDULE_ID_PATTERN = /^sch1:[a-f0-9]{64}$/;
export const EXECUTION_ACTION_ID_PATTERN = /^exa1:[a-f0-9]{64}$/;
export const EXECUTION_ATTEMPT_ID_PATTERN = /^exr1:[a-f0-9]{64}$/;
export const GOVERNANCE_DECISION_ID_PATTERN = /^mgd1:[a-f0-9]{64}$/;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;

export const MAX_BLOCKING_REASONS = 8;
export const MAX_UNCERTAINTIES = 8;
export const MAX_LATEST_EXECUTION_REFS = 100;
export const MAX_TIMELINE_EVENTS = 500;
export const MAX_TASK_STATES = 200;
export const MAX_RECOVERY_CANDIDATES = 100;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value);
}

// ─── Closed vocabularies (contract §3) ───

export const TASK_OPERATIONAL_STATUSES = [
  "PENDING",
  "READY",
  "DISPATCHED",
  "PENDING_EXTERNAL",
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "UNCERTAIN",
  "BLOCKED",
  "STALE",
  "CANCELLED",
] as const;
export type TaskOperationalStatus = (typeof TASK_OPERATIONAL_STATUSES)[number];

export const MISSION_HEALTH_CLASSES = [
  "HEALTHY",
  "DEGRADED",
  "BLOCKED",
  "AT_RISK",
  "FAILED",
  "UNCERTAIN",
  "COMPLETED",
] as const;
export type MissionHealthClass = (typeof MISSION_HEALTH_CLASSES)[number];

export const MISSION_FAILURE_CLASSES = [
  "NONE",
  "TRANSIENT",
  "FINAL",
  "AUTHORIZATION_EXPIRED",
  "DEPENDENCY_INVALID",
  "SCHEDULE_STALE",
  "PROVIDER_PENDING",
  "AMBIGUOUS_RESULT",
  "CALLBACK_MISMATCH",
  "CAPABILITY_UNAVAILABLE",
  "HUMAN_INTERVENTION_REQUIRED",
] as const;
export type MissionFailureClass = (typeof MISSION_FAILURE_CLASSES)[number];

export const MISSION_UNCERTAINTY_CLASSES = [
  "NONE",
  "PROVIDER_PENDING",
  "TIMEOUT",
  "CALLBACK_AMBIGUOUS",
  "PARTIAL_CONFIRMATION",
  "PROVIDER_STATE_UNKNOWN",
  "STALE_STATE",
  "AUTHORIZATION_EXPIRED",
  "SCHEDULE_DRIFT",
] as const;
export type MissionUncertaintyClass = (typeof MISSION_UNCERTAINTY_CLASSES)[number];

export const MISSION_RECOVERY_TYPES = [
  "RETRY",
  "REVALIDATE",
  "WAIT_EXTERNAL",
  "REQUEST_HUMAN_REVIEW",
  "RESCHEDULE",
  "REPLAN",
  "CANCEL_TASK",
  "CANCEL_MISSION",
  "ESCALATE",
] as const;
export type MissionRecoveryType = (typeof MISSION_RECOVERY_TYPES)[number];

export const MISSION_RECOVERY_STATUSES = [
  "PROPOSED",
  "REVIEW_REQUIRED",
  "AUTHORIZED",
  "IN_PROGRESS",
  "RESOLVED",
  "FAILED",
  "SUPERSEDED",
  "STALE",
  "CANCELLED",
  "INVALIDATED",
] as const;
export type MissionRecoveryStatus = (typeof MISSION_RECOVERY_STATUSES)[number];

export const MISSION_TIMELINE_EVENT_TYPES = [
  "mission_state_derived",
  "task_state_derived",
  "recovery_candidate_proposed",
  "recovery_governance_bound",
  "recovery_lifecycle_changed",
  "uncertainty_observed",
  "operator_intervention",
  "resolution_recorded",
] as const;
export type MissionTimelineEventType = (typeof MISSION_TIMELINE_EVENT_TYPES)[number];

export const MISSION_BLOCKING_REASONS = [
  "MISSION_NOT_CURRENT",
  "MISSION_SUPERSEDED",
  "MISSION_STALE",
  "MISSION_CANCELLED",
  "MISSION_INVALIDATED",
  "MISSION_BLOCKED",
  "PLAN_SUPERSEDED",
  "PLAN_STALE",
  "PLAN_NOT_CURRENT",
  "PLAN_BLOCKED",
  "PLAN_INVALIDATED",
  "SCHEDULE_SUPERSEDED",
  "SCHEDULE_STALE",
  "SCHEDULE_NOT_READY",
  "SCHEDULE_BLOCKED",
  "SCHEDULE_INVALIDATED",
  "SCHEDULE_CANCELLED",
  "TASK_SUPERSEDED",
  "TASK_UNRESOLVED",
  "TASK_BLOCKED",
  "TASK_NOT_SCHEDULED",
  "DEPENDENCY_NOT_SATISFIED",
  "GOVERNANCE_REVIEW_PENDING",
  "GOVERNANCE_BLOCK",
  "GOVERNANCE_UNAVAILABLE",
] as const;
export type MissionBlockingReason = (typeof MISSION_BLOCKING_REASONS)[number];

/** R9-A mission lifecycle statuses (closed, verbatim from mission-authority/v1). */
export const R9_MISSION_STATUSES = [
  "PROPOSED",
  "ELIGIBLE_FOR_PLANNING",
  "REVIEW_REQUIRED",
  "BLOCKED",
  "SUPERSEDED",
  "STALE",
  "CANCELLED",
  "INVALIDATED",
] as const;

/** R9-C schedule lifecycle statuses (closed, verbatim). */
export const R9_SCHEDULE_STATUSES = [
  "PROPOSED",
  "VALIDATED",
  "READY",
  "BLOCKED",
  "SUPERSEDED",
  "STALE",
  "INVALIDATED",
  "CANCELLED",
] as const;

/** R9-B task planning statuses (closed, verbatim). */
export const R9_TASK_STATUSES = [
  "DEFINED",
  "VALIDATED",
  "READY_FOR_SCHEDULING",
  "GOVERNANCE_REVIEW_REQUIRED",
  "BLOCKED",
  "SUPERSEDED",
  "UNRESOLVED",
] as const;

/** R9-D execution dispatch states (closed, verbatim). */
export const R9_DISPATCH_STATES = [
  "NEVER_ATTEMPTED",
  "DISPATCH_PREPARED",
  "DISPATCHED",
  "ACKNOWLEDGED",
  "SUCCEEDED",
  "FAILED",
  "UNCERTAIN",
  "CANCELLED",
] as const;

/** R9-D execution result statuses (closed, verbatim). */
export const R9_RESULT_STATUSES = [
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "PENDING_EXTERNAL",
  "UNCERTAIN",
] as const;

/** R9-D failure classes (closed, verbatim). */
export const R9_EXECUTION_FAILURE_CLASSES = [
  "NONE",
  "ADAPTER_REJECTED",
  "PROVIDER_ERROR",
  "TIMEOUT",
  "CONNECTION_LOSS",
  "AMBIGUOUS_CALLBACK",
  "VALIDATION",
  "INTERNAL",
] as const;

/** R9-D uncertainty classes (closed, verbatim). */
export const R9_EXECUTION_UNCERTAINTY_CLASSES = [
  "NONE",
  "TIMEOUT",
  "CALLBACK_AMBIGUOUS",
  "PARTIAL_CONFIRMATION",
  "PROVIDER_STATE_UNKNOWN",
] as const;

/** Recovery subject class mapping (contract §9) — deterministic. */
export const RECOVERY_TYPE_GOVERNANCE_SUBJECT: Readonly<Record<MissionRecoveryType, string>> = Object.freeze({
  RETRY: "RETRY",
  REVALIDATE: "RECOVERY_ACTION",
  WAIT_EXTERNAL: "RECOVERY_ACTION",
  REQUEST_HUMAN_REVIEW: "ESCALATION",
  RESCHEDULE: "RECOVERY_ACTION",
  REPLAN: "RECOVERY_ACTION",
  CANCEL_TASK: "RECOVERY_ACTION",
  CANCEL_MISSION: "RECOVERY_ACTION",
  ESCALATE: "ESCALATION",
});

/** Recovery action type mapping (contract §9) — deterministic. */
export const RECOVERY_TYPE_GOVERNANCE_ACTION: Readonly<Record<MissionRecoveryType, string>> = Object.freeze({
  RETRY: "RETRY_STEP",
  REVALIDATE: "RECOVER_STATE",
  WAIT_EXTERNAL: "RECOVER_STATE",
  REQUEST_HUMAN_REVIEW: "ESCALATE_TO_HUMAN",
  RESCHEDULE: "RECOVER_STATE",
  REPLAN: "RECOVER_STATE",
  CANCEL_TASK: "RECOVER_STATE",
  CANCEL_MISSION: "RECOVER_STATE",
  ESCALATE: "ESCALATE_TO_HUMAN",
});

export const MISSION_DUPLICATE_CLASSIFICATIONS = ["none", "idempotent_replay"] as const;
export type MissionDuplicateClassification = (typeof MISSION_DUPLICATE_CLASSIFICATIONS)[number];

/** Default policy horizons (code-level constants; governance owns policy). */
export const PENDING_EXTERNAL_STALE_MS = 24 * 3600_000;
export const DISPATCHED_STALE_MS = 24 * 3600_000;
export const OBSERVATION_VALIDITY_MS = 15 * 60_000;

// ─── Typed error taxonomy (closed codes) ───

export const MISSION_STATE_INPUT_MALFORMED = "MISSION_STATE_INPUT_MALFORMED" as const;
export const MISSION_STATE_CLIENT_AUTHORITY_FIELD_FORBIDDEN = "MISSION_STATE_CLIENT_AUTHORITY_FIELD_FORBIDDEN" as const;
export const SECRET_MATERIAL_REJECTED = "SECRET_MATERIAL_REJECTED" as const;
export const CROSS_TENANT_MISSION = "CROSS_TENANT_MISSION" as const;
export const CROSS_BUSINESS_MISSION = "CROSS_BUSINESS_MISSION" as const;
export const MISSION_STATE_AUTHORITY_UNAVAILABLE = "MISSION_STATE_AUTHORITY_UNAVAILABLE" as const;
export const UNKNOWN_MISSION = "UNKNOWN_MISSION" as const;
export const MISSION_NOT_CURRENT = "MISSION_NOT_CURRENT" as const;
export const UNKNOWN_TASK = "UNKNOWN_TASK" as const;
export const TASK_NOT_IN_MISSION = "TASK_NOT_IN_MISSION" as const;
export const UNKNOWN_RECOVERY_CANDIDATE = "UNKNOWN_RECOVERY_CANDIDATE" as const;
export const RECOVERY_CANDIDATE_NOT_CURRENT = "RECOVERY_CANDIDATE_NOT_CURRENT" as const;
export const GOVERNANCE_DECISION_NOT_FOUND = "GOVERNANCE_DECISION_NOT_FOUND" as const;
export const GOVERNANCE_NOT_CONSUMABLE = "GOVERNANCE_NOT_CONSUMABLE" as const;
export const MISSION_STATE_REPLAY_CONFLICT = "MISSION_STATE_REPLAY_CONFLICT" as const;
export const MISSION_STATE_TAMPER = "MISSION_STATE_TAMPER" as const;
export const INVALID_RECOVERY_STATUS = "INVALID_RECOVERY_STATUS" as const;
export const RECOVERY_SCOPE_DRIFT = "RECOVERY_SCOPE_DRIFT" as const;
export const MISSION_STATE_CONFLICT = "MISSION_STATE_CONFLICT" as const;

export type MissionStateErrorCode =
  | "MISSION_STATE_INPUT_MALFORMED"
  | "MISSION_STATE_CLIENT_AUTHORITY_FIELD_FORBIDDEN"
  | "SECRET_MATERIAL_REJECTED"
  | "CROSS_TENANT_MISSION"
  | "CROSS_BUSINESS_MISSION"
  | "MISSION_STATE_AUTHORITY_UNAVAILABLE"
  | "UNKNOWN_MISSION"
  | "MISSION_NOT_CURRENT"
  | "UNKNOWN_TASK"
  | "TASK_NOT_IN_MISSION"
  | "UNKNOWN_RECOVERY_CANDIDATE"
  | "RECOVERY_CANDIDATE_NOT_CURRENT"
  | "GOVERNANCE_DECISION_NOT_FOUND"
  | "GOVERNANCE_NOT_CONSUMABLE"
  | "MISSION_STATE_REPLAY_CONFLICT"
  | "MISSION_STATE_TAMPER"
  | "INVALID_RECOVERY_STATUS"
  | "RECOVERY_SCOPE_DRIFT"
  | "MISSION_STATE_CONFLICT";

export class MissionStateRecoveryError extends Error {
  readonly code: MissionStateErrorCode;
  constructor(code: MissionStateErrorCode, message: string) {
    super(message);
    this.name = "MissionStateRecoveryError";
    this.code = code;
  }
}

/** Malformed/unknown input at the strict boundary (mapped BAD_REQUEST). */
export class MissionStateInputError extends MissionStateRecoveryError {
  constructor(code: MissionStateErrorCode, message: string) {
    super(code, message);
    this.name = "MissionStateInputError";
  }
}

/** Cross-tenant / cross-business evidence or scope (mapped FORBIDDEN). */
export class MissionStateOwnershipError extends MissionStateRecoveryError {
  constructor(code: MissionStateErrorCode, message: string) {
    super(code, message);
    this.name = "MissionStateOwnershipError";
  }
}

/** Upstream seam validation failure / unavailable authority (BAD_REQUEST). */
export class MissionStateUpstreamError extends MissionStateRecoveryError {
  constructor(code: MissionStateErrorCode, message: string) {
    super(code, message);
    this.name = "MissionStateUpstreamError";
  }
}

/** Same convergence anchor replayed with conflicting material (CONFLICT). */
export class MissionStateIdentityConflictError extends MissionStateRecoveryError {
  constructor(code: MissionStateErrorCode, message: string) {
    super(code, message);
    this.name = "MissionStateIdentityConflictError";
  }
}

/** Optimistic-CAS stale write / illegal transition (CONFLICT). */
export class MissionStateConflictError extends MissionStateRecoveryError {
  constructor(code: MissionStateErrorCode, message: string) {
    super(code, message);
    this.name = "MissionStateConflictError";
  }
}

/** Immutable-row hash drift = tampering (CONFLICT). */
export class MissionStateTamperError extends MissionStateRecoveryError {
  constructor(code: MissionStateErrorCode, message: string) {
    super(code, message);
    this.name = "MissionStateTamperError";
  }
}

// ─── Client-authority smuggling rejection ───

const FORBIDDEN_CLIENT_AUTHORITY_FIELDS = [
  "status",
  "missionStatus",
  "healthClass",
  "health",
  "taskSummary",
  "blockingReasons",
  "uncertainties",
  "recoveryCandidateIds",
  "missionStateId",
  "taskStateId",
  "recoveryCandidateId",
  "recoveryLifecycleId",
  "timelineEventId",
  "stateId",
  "decision",
  "approved",
  "approval",
  "authorization",
  "authority",
  "authorized",
  "riskClass",
  "missionRiskClass",
  "failureClass",
  "uncertaintyClass",
  "retryEligibility",
  "recoveryRequired",
  "recoveryStatus",
  "recoveryType",
  "governanceDecision",
  "policyVersion",
  "actionParamsFingerprint",
  "proposalHash",
  "stateHash",
  "derivationHash",
  "derivedFromVersion",
  "fingerprint",
  "override",
  "force",
  "forceAllow",
  "forceApprove",
  "success",
  "succeeded",
  "completed",
  "complete",
  "execute",
  "execution",
  "dispatch",
  "adapter",
  "adapterType",
  "capability",
  "provider",
  "url",
  "endpoint",
  "webhook",
  "command",
  "shell",
  "exec",
  "sql",
  "query",
  "statement",
  "module",
  "tool",
  "toolName",
  "function",
  "credentials",
  "credentialRef",
  "apiKey",
  "apiKeyV2",
  "secret",
  "secretKey",
  "token",
  "accessToken",
  "refreshToken",
  "password",
  "clientSecret",
  "privateKey",
  "session",
] as const;

const SECRET_KEY_PATTERN =
  /^(api[_-]?key|apikeyv?\d*|secret|secret[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|private[_-]?key|credential(s)?|session|bearer|authorization)$/i;

export function findForbiddenField(input: Record<string, unknown>): string | null {
  for (const key of FORBIDDEN_CLIENT_AUTHORITY_FIELDS) {
    if (key in input) return key;
  }
  return null;
}

export function findSecretKey(value: unknown, depth = 0): string | null {
  if (value === null || typeof value !== "object" || depth > 16) return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSecretKey(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_PATTERN.test(key)) return key;
    const hit = findSecretKey(nested, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ─── zod input schemas (strictObject — clients never supply authority) ───

export const observeMissionStateSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  planId: z.string().regex(PLAN_ID_PATTERN).optional(),
  scheduleId: z.string().regex(SCHEDULE_ID_PATTERN).optional(),
});

export type ObserveMissionStateInput = z.infer<typeof observeMissionStateSchema>;

export const getMissionStateSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  scheduleId: z.string().regex(SCHEDULE_ID_PATTERN).optional(),
});

export const listMissionTaskStatesSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  scheduleId: z.string().regex(SCHEDULE_ID_PATTERN).optional(),
  limit: z.number().int().positive().max(MAX_TASK_STATES).optional(),
});

export const listExecutionAttemptsSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  taskId: z.string().regex(TASK_ID_PATTERN).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export const listRecoveryCandidatesSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  taskId: z.string().regex(TASK_ID_PATTERN).optional(),
  status: z.enum(MISSION_RECOVERY_STATUSES).optional(),
  limit: z.number().int().positive().max(MAX_RECOVERY_CANDIDATES).optional(),
});

export const getRecoveryCandidateSchema = z.strictObject({
  recoveryCandidateId: z.string().regex(RECOVERY_CANDIDATE_ID_PATTERN),
});

export const proposeRecoverySchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  scheduleId: z.string().regex(SCHEDULE_ID_PATTERN),
  taskId: z.string().regex(TASK_ID_PATTERN),
  recoveryType: z.enum(MISSION_RECOVERY_TYPES),
  reason: z.string().min(1).max(280).optional(),
});

export const bindRecoveryGovernanceSchema = z.strictObject({
  recoveryCandidateId: z.string().regex(RECOVERY_CANDIDATE_ID_PATTERN),
  /** Reference to the R9-F decision row that evaluated this exact proposal. */
  governanceDecisionId: z.string().regex(GOVERNANCE_DECISION_ID_PATTERN),
});

export const consumeRecoverySchema = z.strictObject({
  recoveryCandidateId: z.string().regex(RECOVERY_CANDIDATE_ID_PATTERN),
  expectedVersion: z.number().int().positive(),
});

export const reevaluateMissionStateSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  scheduleId: z.string().regex(SCHEDULE_ID_PATTERN).optional(),
});

export const cancelRecoverySchema = z.strictObject({
  recoveryCandidateId: z.string().regex(RECOVERY_CANDIDATE_ID_PATTERN),
  expectedVersion: z.number().int().positive(),
  reason: z.string().min(1).max(280),
});

export const getOperationalTimelineSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  limit: z.number().int().positive().max(MAX_TIMELINE_EVENTS).optional(),
});

export const getMissionHealthSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  planId: z.string().regex(PLAN_ID_PATTERN).optional(),
  scheduleId: z.string().regex(SCHEDULE_ID_PATTERN).optional(),
});

export const getMissionControlHandoffSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  scheduleId: z.string().regex(SCHEDULE_ID_PATTERN).optional(),
});

/** Output-side recovery lifecycle transition validity (contract §10). */
export function canTransitionRecoveryStatus(from: MissionRecoveryStatus, to: MissionRecoveryStatus): boolean {
  const allowed: Readonly<Record<MissionRecoveryStatus, readonly MissionRecoveryStatus[]>> = {
    PROPOSED: ["REVIEW_REQUIRED", "AUTHORIZED", "CANCELLED", "INVALIDATED", "STALE", "SUPERSEDED"],
    REVIEW_REQUIRED: ["AUTHORIZED", "CANCELLED", "INVALIDATED", "STALE", "SUPERSEDED"],
    AUTHORIZED: ["IN_PROGRESS", "INVALIDATED", "STALE", "CANCELLED", "SUPERSEDED"],
    IN_PROGRESS: ["RESOLVED", "FAILED", "INVALIDATED"],
    RESOLVED: ["SUPERSEDED"],
    FAILED: ["SUPERSEDED", "INVALIDATED", "CANCELLED"],
    SUPERSEDED: [],
    STALE: ["SUPERSEDED", "CANCELLED", "INVALIDATED"],
    CANCELLED: [],
    INVALIDATED: [],
  };
  return allowed[from].includes(to);
}
