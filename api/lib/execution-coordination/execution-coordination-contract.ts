// ─── R9-D Execution Coordination — canonical contract ───
//
// PURE contract module: closed vocabularies, version identities, identity
// patterns, typed error taxonomy, zod router-input schemas and
// client-authority rejection for the execution coordination authority
// (docs/contracts/mission-execution-coordination-contract.md).
// No I/O of any kind; authorizes nothing; executes nothing; invokes nothing.
//
// An execution action is a deterministic, exactly-once dispatch intent bound
// to validated R9-A/B/C upstream authority + an exact R9-F consumption
// authorization. Schedule readiness is never execution authorization; task
// definition is never execution authorization; dispatch is never success;
// uncertainty is never success. This stream never decides mission truth,
// planning, scheduling, governance, retry authority or recovery policy.
//
// z.strictObject everywhere: clients name schedules/tasks/decisions and
// bounded action material only — never identity, dispatch state, results,
// adapters, capabilities, idempotency keys or authorization material.

import { z } from "zod";

// ─── Versions ───

export const EXECUTION_COORDINATION_CONTRACT_VERSION = "mission-execution-coordination/v1" as const;
export const EXECUTION_COORDINATION_ENGINE_VERSION = "mission-execution-engine/v1" as const;
export const EXECUTION_RECOVERY_PROJECTION_VERSION = "mission-execution-to-state-recovery/v1" as const;

/** Frozen upstream contract versions this stream binds (contract §1). */
export const EXECUTION_BOUND_VERSIONS = Object.freeze({
  missionAuthority: "mission-authority/v1",
  missionPlanning: "mission-planning/v1",
  missionScheduling: "mission-dependency-scheduling/v1",
  missionSchedulingProjection: "mission-scheduling-to-execution/v1",
  missionGovernance: "mission-governance/v1",
  missionGovernanceGate: "mission-governance-to-execution/v1",
});

/** Bound frozen policy version (mission-governance-policy/v1 @ R9-F 1665d2f). */
export const BOUND_MISSION_POLICY_VERSION = "mission-governance-policy/v1" as const;

// ─── Identity patterns ───

export const EXECUTION_ACTION_ID_PATTERN = /^exa1:[a-f0-9]{64}$/;
export const EXECUTION_ATTEMPT_ID_PATTERN = /^exr1:[a-f0-9]{64}$/;
export const EXECUTION_LIFECYCLE_ID_PATTERN = /^exl1:[a-f0-9]{64}$/;
export const EXECUTION_IDEMPOTENCY_KEY_PATTERN = /^idem1:[a-f0-9]{64}$/;
export const MISSION_ID_PATTERN = /^mis1:[a-f0-9]{64}$/;
export const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const SCHEDULE_ID_PATTERN = /^sch1:[a-f0-9]{64}$/;
export const GOVERNANCE_DECISION_ID_PATTERN = /^mgd1:[a-f0-9]{64}$/;
export const EXTERNAL_REFERENCE_PATTERN = /^ext1:[a-f0-9]{64}$/;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const INPUT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_#/.-]{0,190}$/;

export const MAX_INPUT_REFS = 16;
export const MAX_PARAMETERS_CANONICAL_CHARS = 4096;
export const MAX_PARAMETER_DEPTH = 16;
export const MAX_CALLBACK_MATERIAL_CHARS = 2048;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value);
}

// ─── Closed vocabularies (contract §2/§5/§7) ───

export const EXECUTION_ADAPTER_TYPES = [
  "CAMPAIGN",
  "CONTENT",
  "SOCIAL",
  "CRM",
  "NOTIFICATION",
  "ANALYTICS",
  "INTERNAL_WORKFLOW",
] as const;
export type ExecutionAdapterType = (typeof EXECUTION_ADAPTER_TYPES)[number];

/** Closed capability keys — each maps to exactly one adapter class. */
export const EXECUTION_CAPABILITIES = [
  "campaign.activate",
  "content.dispatch",
  "social.publish",
  "crm.record",
  "notification.send",
  "analytics.record",
  "workflow.run",
] as const;
export type ExecutionCapability = (typeof EXECUTION_CAPABILITIES)[number];

export const EXECUTION_CAPABILITY_ADAPTER: Readonly<Record<ExecutionCapability, ExecutionAdapterType>> =
  Object.freeze({
    "campaign.activate": "CAMPAIGN",
    "content.dispatch": "CONTENT",
    "social.publish": "SOCIAL",
    "crm.record": "CRM",
    "notification.send": "NOTIFICATION",
    "analytics.record": "ANALYTICS",
    "workflow.run": "INTERNAL_WORKFLOW",
  });

/** Action types admissible for execution consumption (R9-F closed subset). */
export const EXECUTION_ACTION_TYPES = ["EXECUTE_TASK", "EXECUTE_STEP", "RETRY_STEP"] as const;
export type ExecutionActionType = (typeof EXECUTION_ACTION_TYPES)[number];

export const EXECUTION_DISPATCH_STATES = [
  "NEVER_ATTEMPTED",
  "DISPATCH_PREPARED",
  "DISPATCHED",
  "ACKNOWLEDGED",
  "SUCCEEDED",
  "FAILED",
  "UNCERTAIN",
  "CANCELLED",
] as const;
export type ExecutionDispatchState = (typeof EXECUTION_DISPATCH_STATES)[number];

/** States from which a dispatch may begin. */
export const EXECUTION_DISPATCHABLE_STATES = ["DISPATCH_PREPARED"] as const;

export const EXECUTION_RESULT_STATUSES = [
  "SUCCEEDED",
  "FAILED_RETRYABLE",
  "FAILED_FINAL",
  "PENDING_EXTERNAL",
  "UNCERTAIN",
] as const;
export type ExecutionResultStatus = (typeof EXECUTION_RESULT_STATUSES)[number];

export const EXECUTION_FAILURE_CLASSES = [
  "NONE",
  "ADAPTER_REJECTED",
  "PROVIDER_ERROR",
  "TIMEOUT",
  "CONNECTION_LOSS",
  "AMBIGUOUS_CALLBACK",
  "VALIDATION",
  "INTERNAL",
] as const;
export type ExecutionFailureClass = (typeof EXECUTION_FAILURE_CLASSES)[number];

export const EXECUTION_UNCERTAINTY_CLASSES = [
  "NONE",
  "TIMEOUT",
  "CALLBACK_AMBIGUOUS",
  "PARTIAL_CONFIRMATION",
  "PROVIDER_STATE_UNKNOWN",
] as const;
export type ExecutionUncertaintyClass = (typeof EXECUTION_UNCERTAINTY_CLASSES)[number];

export const EXECUTION_LIFECYCLE_TYPES = [
  "dispatch_state_changed",
  "result_recorded",
  "retry_candidate_emitted",
] as const;
export type ExecutionLifecycleType = (typeof EXECUTION_LIFECYCLE_TYPES)[number];

export const EXECUTION_RETRY_CANDIDATE_REASONS = [
  "ATTEMPT_FAILED_RETRYABLE",
  "ATTEMPT_UNCERTAIN",
  "RESULT_PENDING_EXTERNAL",
] as const;
export type ExecutionRetryCandidateReason = (typeof EXECUTION_RETRY_CANDIDATE_REASONS)[number];

export const EXECUTION_DUPLICATE_CLASSIFICATIONS = ["none", "idempotent_replay"] as const;
export type ExecutionDuplicateClassification = (typeof EXECUTION_DUPLICATE_CLASSIFICATIONS)[number];

/** R9-A mission statuses under which execution may consume mission authority. */
export const EXECUTABLE_MISSION_STATUSES = [
  "PROPOSED",
  "ELIGIBLE_FOR_PLANNING",
  "REVIEW_REQUIRED",
] as const;

/** R9-B plan/task statuses under which execution may consume plan authority. */
export const EXECUTABLE_PLAN_STATUSES = ["ACTIVE", "COMPLETE", "PLANNED", "ELIGIBLE"] as const;
export const EXECUTABLE_TASK_STATUSES = [
  "PLANNED",
  "READY",
  "ACTIVE",
  "ELIGIBLE_FOR_EXECUTION",
  "SCHEDULED",
] as const;

/** Only a READY, current schedule is executable (R9-C closed lifecycle). */
export const EXECUTABLE_SCHEDULE_STATUSES = ["READY"] as const;

// ─── Typed error taxonomy (closed codes) ───

export type ExecutionErrorCode =
  | "EXECUTION_INPUT_MALFORMED"
  | "EXECUTION_CLIENT_AUTHORITY_FIELD_FORBIDDEN"
  | "SECRET_MATERIAL_REJECTED"
  | "EXECUTION_AUTHORITY_UNAVAILABLE"
  | "UNKNOWN_SCHEDULE"
  | "CROSS_TENANT_SCHEDULE"
  | "SCHEDULE_NOT_EXECUTABLE"
  | "SCHEDULE_STALE"
  | "TASK_NOT_SCHEDULED"
  | "TASK_BLOCKED"
  | "TASK_CONSTRAINT_WINDOW_CLOSED"
  | "DEPENDENCY_NOT_SATISFIED"
  | "MISSION_NOT_CURRENT"
  | "MISSION_EXPIRED"
  | "PLAN_NOT_CURRENT"
  | "TASK_NOT_IN_PLAN"
  | "CAPABILITY_INVALID"
  | "ADAPTER_UNAVAILABLE"
  | "UNKNOWN_ADAPTER"
  | "GOVERNANCE_DECISION_NOT_FOUND"
  | "GOVERNANCE_NOT_CONSUMABLE"
  | "EXECUTION_REPLAY_CONFLICT"
  | "EXECUTION_TAMPER"
  | "EXECUTION_ACTION_NOT_FOUND"
  | "ATTEMPT_NOT_FOUND"
  | "INVALID_DISPATCH_STATE"
  | "DISPATCH_WINDOW_EXPIRED"
  | "EXTERNAL_REFERENCE_MISMATCH"
  | "RETRY_SCOPE_BROADENED";

export class ExecutionCoordinationError extends Error {
  readonly code: ExecutionErrorCode;
  constructor(code: ExecutionErrorCode, message: string) {
    super(message);
    this.name = "ExecutionCoordinationError";
    this.code = code;
  }
}

/** Malformed/unknown input at the strict boundary (mapped BAD_REQUEST). */
export class ExecutionInputError extends ExecutionCoordinationError {
  constructor(code: ExecutionErrorCode, message: string) {
    super(code, message);
    this.name = "ExecutionInputError";
  }
}

/** Cross-tenant / cross-business evidence or scope (mapped FORBIDDEN). */
export class ExecutionOwnershipError extends ExecutionCoordinationError {
  constructor(code: ExecutionErrorCode, message: string) {
    super(code, message);
    this.name = "ExecutionOwnershipError";
  }
}

/** Upstream seam validation failure (mapped BAD_REQUEST). */
export class ExecutionUpstreamError extends ExecutionCoordinationError {
  constructor(code: ExecutionErrorCode, message: string) {
    super(code, message);
    this.name = "ExecutionUpstreamError";
  }
}

/** Same convergence anchor replayed with conflicting material (CONFLICT). */
export class ExecutionIdentityConflictError extends ExecutionCoordinationError {
  constructor(code: ExecutionErrorCode, message: string) {
    super(code, message);
    this.name = "ExecutionIdentityConflictError";
  }
}

/** Optimistic-CAS stale write (CONFLICT). */
export class ExecutionStateConflictError extends ExecutionCoordinationError {
  constructor(code: ExecutionErrorCode, message: string) {
    super(code, message);
    this.name = "ExecutionStateConflictError";
  }
}

/** Immutable-row hash drift = tampering (CONFLICT). */
export class ExecutionTamperError extends ExecutionCoordinationError {
  constructor(code: ExecutionErrorCode, message: string) {
    super(code, message);
    this.name = "ExecutionTamperError";
  }
}

export function fail(code: ExecutionErrorCode, message: string): never {
  throw new ExecutionInputError(code, message);
}

// ─── Client-authority smuggling rejection ───

const FORBIDDEN_CLIENT_AUTHORITY_FIELDS = [
  "decision",
  "approved",
  "authorization",
  "authority",
  "authorized",
  "authorizationFingerprint",
  "adapterType",
  "adapter",
  "capability",
  "dispatchState",
  "dispatchFingerprint",
  "resultStatus",
  "resultHash",
  "failureClass",
  "uncertaintyClass",
  "idempotencyKey",
  "attemptNumber",
  "attemptId",
  "externalReference",
  "executionActionId",
  "policyVersion",
  "governanceDecision",
  "actionParamsFingerprint",
  "override",
  "forceDispatch",
  "forceAllow",
  "executeNow",
  "execute",
  "run",
  "provider",
  "providerAccount",
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
  if (value === null || typeof value !== "object" || depth > MAX_PARAMETER_DEPTH) return null;
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

/** Bounded, JSON-safe, secret-free action material. Validated strictly. */
export const executionParametersSchema = z
  .unknown()
  .transform((value, ctxx) => {
    if (value === undefined) return {};
    const seen = new WeakSet<object>();
    const walk = (v: unknown, depth: number): boolean => {
      if (v === null || typeof v === "number" || typeof v === "boolean" || typeof v === "string") {
        return true;
      }
      if (typeof v !== "object" || depth > MAX_PARAMETER_DEPTH || seen.has(v as object)) return false;
      seen.add(v as object);
      if (Array.isArray(v)) return v.every((item) => walk(item, depth + 1));
      return Object.values(v as Record<string, unknown>).every((item) => walk(item, depth + 1));
    };
    if (!walk(value, 0)) {
      ctxx.addIssue({ code: "custom", message: "parameters must be bounded acyclic JSON material" });
      return z.NEVER;
    }
    return value as Record<string, unknown>;
  });

export const prepareExecutionActionSchema = z.strictObject({
  scheduleId: z.string().regex(SCHEDULE_ID_PATTERN),
  taskId: z.string().regex(TASK_ID_PATTERN),
  actionType: z.enum(EXECUTION_ACTION_TYPES),
  parameters: executionParametersSchema,
  inputRefs: z.array(z.string().regex(INPUT_REF_PATTERN)).max(MAX_INPUT_REFS).optional(),
  governanceDecisionId: z.string().regex(GOVERNANCE_DECISION_ID_PATTERN),
  /** Required for RETRY_STEP: the failed/uncertain action being retried. */
  retryOf: z.string().regex(EXECUTION_ACTION_ID_PATTERN).optional(),
});

export type PrepareExecutionActionInput = z.infer<typeof prepareExecutionActionSchema>;

export const dispatchExecutionActionSchema = z.strictObject({
  executionActionId: z.string().regex(EXECUTION_ACTION_ID_PATTERN),
  /**
   * The exact bounded action material originally authorized. Re-hashed at
   * dispatch: any drift from the approved actionParametersHash fails closed.
   */
  parameters: executionParametersSchema,
});

export type DispatchExecutionActionInput = z.infer<typeof dispatchExecutionActionSchema>;

export const recordExecutionResultSchema = z.strictObject({
  attemptId: z.string().regex(EXECUTION_ATTEMPT_ID_PATTERN),
  /** Reference-only validation against the attempt's server-issued reference. */
  externalReference: z.string().min(1).max(191).optional(),
});

export type RecordExecutionResultInput = z.infer<typeof recordExecutionResultSchema>;

export const getExecutionActionSchema = z.strictObject({
  executionActionId: z.string().regex(EXECUTION_ACTION_ID_PATTERN),
});

export const listExecutionAttemptsSchema = z.strictObject({
  executionActionId: z.string().regex(EXECUTION_ACTION_ID_PATTERN),
  limit: z.number().int().positive().max(100).optional(),
});

export const getRecoveryProjectionSchema = z.strictObject({
  executionActionId: z.string().regex(EXECUTION_ACTION_ID_PATTERN).optional(),
  missionId: z.string().regex(MISSION_ID_PATTERN).optional(),
  limit: z.number().int().positive().max(100).optional(),
});

export const cancelExecutionActionSchema = z.strictObject({
  executionActionId: z.string().regex(EXECUTION_ACTION_ID_PATTERN),
  expectedVersion: z.number().int().positive(),
});
