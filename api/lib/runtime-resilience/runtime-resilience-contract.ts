// ─── R10-C Runtime Resilience — canonical contract ───
//
// PURE contract module: closed vocabularies, version identities, identity
// patterns, typed error taxonomy, zod router-input schemas and
// client-authority rejection for the runtime/worker resilience authority
// (docs/contracts/autonomous-runtime-resilience-contract.md).
// No I/O of any kind; authorizes nothing; executes nothing; invokes nothing.
//
// The runtime envelope answers one question: after ANY crash, restart, duplicate
// delivery, stale lease or interruption, is the next action safe? It owns
// worker lifecycle, job/lease identity, heartbeat/liveness, safe claim, crash
// windows, safe resume, the retry boundary, dead-letter, stuck detection,
// draining and version gating — and NOTHING else. It never owns mission
// authority, planning, scheduling authority, execution authorization,
// governance, recovery authorization, provider credentials or deployment.
//
// Authority rules (verbatim on every surface):
//   process recovery != authority recovery
//   worker restart != permission to re-execute
//   queue delivery != execution authorization
//   lease acquisition != business authority
//   retry != automatic permission
//   missing acknowledgement != success
//
// A lease NEVER grants new execution authority: it only fences concurrent
// runtime access to a job whose authorityRef was already validated upstream.
// z.strictObject everywhere: clients name bounded material and reference ids
// only — never identity, state, lease, claim, result, authority, provider,
// secret or version material.

import { z } from "zod";

// ─── Versions ───

export const RUNTIME_RESILIENCE_CONTRACT_VERSION =
  "runtime-resilience/v1" as const;
export const RUNTIME_ENGINE_VERSION = "runtime-resilience-engine/v1" as const;
export const RUNTIME_OBSERVABILITY_PROJECTION_VERSION =
  "runtime-to-observability/v1" as const;

/** Bound frozen upstream contract versions this stream revalidates (C6). */
export const RUNTIME_BOUND_VERSIONS = Object.freeze({
  missionAuthority: "mission-authority/v1",
  missionPlanning: "mission-planning/v1",
  missionScheduling: "mission-dependency-scheduling/v1",
  missionGovernance: "mission-governance/v1",
  missionGovernanceGate: "mission-governance-to-execution/v1",
  executionCoordination: "mission-execution-coordination/v1",
  missionStateRecovery: "mission-state-recovery/v1",
});

// ─── Identity patterns ───

export const WORKER_INSTANCE_ID_PATTERN = /^wrk1:[a-f0-9]{64}$/;
export const RUNTIME_JOB_ID_PATTERN = /^job1:[a-f0-9]{64}$/;
export const RUNTIME_LEASE_ID_PATTERN = /^lea1:[a-f0-9]{64}$/;
export const RUNTIME_LIFECYCLE_ID_PATTERN = /^rlf1:[a-f0-9]{64}$/;
export const RUNTIME_DEAD_LETTER_ID_PATTERN = /^dlq1:[a-f0-9]{64}$/;
export const MISSION_ID_PATTERN = /^mis1:[a-f0-9]{64}$/;
export const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const SCHEDULE_ID_PATTERN = /^sch1:[a-f0-9]{64}$/;
export const GOVERNANCE_DECISION_ID_PATTERN = /^mgd1:[a-f0-9]{64}$/;
export const EXECUTION_ACTION_ID_PATTERN = /^exa1:[a-f0-9]{64}$/;
export const EXECUTION_ATTEMPT_ID_PATTERN = /^exr1:[a-f0-9]{64}$/;
export const AUTHORITY_REF_PATTERN = /^(exa1|sch1|mgd1):[a-f0-9]{64}$/;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
export const ISO_UTC_PATTERN =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const SAFE_TOKEN_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_./-]{0,127}$/;

export const MAX_CAPABILITIES = 16;
export const MAX_DIAGNOSTIC_CHARS = 1024;
export const MAX_DIAGNOSTIC_DEPTH = 6;
export const MAX_REASON_CODES = 8;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value) && Number.isFinite(Date.parse(value));
}

// ─── Closed runtime vocabularies ───

/** Worker runtime states (C1). UNKNOWN is a classification, never persisted. */
export const RUNTIME_WORKER_STATES = [
  "STARTING",
  "READY",
  "BUSY",
  "DRAINING",
  "DEGRADED",
  "STOPPING",
  "STOPPED",
  "FAILED",
] as const;
export type RuntimeWorkerState = (typeof RUNTIME_WORKER_STATES)[number];

/** Durable job states (DB-native work queue). */
export const RUNTIME_JOB_STATES = [
  "PENDING",
  "LEASED",
  "COMPLETED",
  "DEAD_LETTERED",
  "CANCELLED",
] as const;
export type RuntimeJobState = (typeof RUNTIME_JOB_STATES)[number];

export const RUNTIME_LEASE_STATES = [
  "ACTIVE",
  "EXPIRED",
  "RELEASED",
  "REVOKED",
] as const;
export type RuntimeLeaseState = (typeof RUNTIME_LEASE_STATES)[number];

/** Claim outcomes — one durable winner where exclusivity is required (C4). */
export const RUNTIME_CLAIM_OUTCOMES = [
  "WON",
  "LOST_CONTENDED",
  "LOST_WORKER_INELIGIBLE",
  "LOST_WORKER_NOT_FOUND",
  "LOST_VERSION_INCOMPATIBLE",
  "LOST_STATE",
  "LOST_TENANT",
] as const;
export type RuntimeClaimOutcome = (typeof RUNTIME_CLAIM_OUTCOMES)[number];

/** Liveness classifications (C3). Absence of heartbeat is never proof of no-op. */
export const RUNTIME_LIVENESS_CLASSES = [
  "HEALTHY",
  "LATE",
  "STALE",
  "DEAD",
  "VERSION_DRIFT",
  "DUPLICATE_IDENTITY",
  "UNKNOWN",
] as const;
export type RuntimeLivenessClass = (typeof RUNTIME_LIVENESS_CLASSES)[number];

/** Crash windows (C5) — every window maps to a safe restart behaviour. */
export const RUNTIME_CRASH_WINDOWS = [
  "BEFORE_DURABLE_INTENT",
  "AFTER_INTENT_BEFORE_DISPATCH",
  "DURING_DISPATCH",
  "AFTER_PROVIDER_ACK_BEFORE_LOCAL_ACK",
  "AFTER_RESULT_PERSISTENCE",
  "DURING_RECOVERY",
] as const;
export type RuntimeCrashWindow = (typeof RUNTIME_CRASH_WINDOWS)[number];

/** Failure classes — aligned to R9-D so the runtime composes with execution. */
export const RUNTIME_FAILURE_CLASSES = [
  "NONE",
  "ADAPTER_REJECTED",
  "PROVIDER_ERROR",
  "TIMEOUT",
  "CONNECTION_LOSS",
  "AMBIGUOUS_CALLBACK",
  "VALIDATION",
  "INTERNAL",
] as const;
export type RuntimeFailureClass = (typeof RUNTIME_FAILURE_CLASSES)[number];

/** Uncertainty classes — aligned to R9-D. UNKNOWN is never SUCCESS. */
export const RUNTIME_UNCERTAINTY_CLASSES = [
  "NONE",
  "TIMEOUT",
  "CALLBACK_AMBIGUOUS",
  "PARTIAL_CONFIRMATION",
  "PROVIDER_STATE_UNKNOWN",
] as const;
export type RuntimeUncertaintyClass =
  (typeof RUNTIME_UNCERTAINTY_CLASSES)[number];

/** Dead-letter lifecycle (C8). */
export const RUNTIME_DEAD_LETTER_REASONS = [
  "RETRIES_EXHAUSTED",
  "UNRECOVERABLE_FAILURE",
  "STALE_LEASE_UNRESOLVED",
  "WORKER_DEAD_IN_FLIGHT",
  "VERSION_INCOMPATIBLE",
  "AUTHORITY_UNAVAILABLE",
  "MANUAL",
] as const;
export type RuntimeDeadLetterReason =
  (typeof RUNTIME_DEAD_LETTER_REASONS)[number];

/** Stuck-job classes (C9) — detection proposes, never blindly replays. */
export const RUNTIME_STUCK_CLASSES = [
  "LEASE_EXPIRED",
  "WORKER_DEAD",
  "PROVIDER_PENDING",
  "CALLBACK_MISSING",
  "STATE_UNCHANGED",
  "RECOVERY_UNRESOLVED",
] as const;
export type RuntimeStuckClass = (typeof RUNTIME_STUCK_CLASSES)[number];

/** Runtime lifecycle event types (append-only rlf1: facts). */
export const RUNTIME_LIFECYCLE_TYPES = [
  "worker_registered",
  "worker_state_changed",
  "worker_heartbeat",
  "job_enqueued",
  "job_claimed",
  "job_claim_denied",
  "job_lease_expired",
  "job_completed",
  "job_dead_lettered",
  "job_requeued",
  "job_cancelled",
  "worker_draining",
  "worker_drained",
  "resume_revalidated",
  "uncertainty_reconciled",
  "recovery_proposed",
  "callback_converged",
  "callback_conflicted",
] as const;
export type RuntimeLifecycleType = (typeof RUNTIME_LIFECYCLE_TYPES)[number];

/** Job types the runtime is permitted to carry (closed). */
export const RUNTIME_JOB_TYPES = [
  "MISSION_TASK_EXECUTION",
  "MISSION_STEP_RETRY",
  "MISSION_RECOVERY_ACTION",
  "PUBLISHING",
  "CONTENT_GENERATION",
] as const;
export type RuntimeJobType = (typeof RUNTIME_JOB_TYPES)[number];

export const RUNTIME_DUPLICATE_CLASSIFICATIONS = [
  "none",
  "idempotent_replay",
] as const;
export type RuntimeDuplicateClassification =
  (typeof RUNTIME_DUPLICATE_CLASSIFICATIONS)[number];

// ─── Typed error taxonomy (closed codes) ───

export type RuntimeErrorCode =
  | "RUNTIME_INPUT_MALFORMED"
  | "RUNTIME_CLIENT_AUTHORITY_FIELD_FORBIDDEN"
  | "RUNTIME_SECRET_MATERIAL_REJECTED"
  | "RUNTIME_AUTHORITY_UNAVAILABLE"
  | "WORKER_NOT_FOUND"
  | "WORKER_INELIGIBLE"
  | "WORKER_DUPLICATE_IDENTITY"
  | "WORKER_VERSION_DRIFT"
  | "JOB_NOT_FOUND"
  | "CROSS_TENANT_JOB"
  | "CROSS_BUSINESS_JOB"
  | "JOB_STATE_INVALID"
  | "JOB_VERSION_INCOMPATIBLE"
  | "JOB_TAMPER"
  | "LEASE_NOT_FOUND"
  | "LEASE_STALE"
  | "LEASE_EXPIRED"
  | "LEASE_FENCING_CONFLICT"
  | "CLAIM_LOST"
  | "PARAMETERS_FINGERPRINT_MISMATCH"
  | "AUTHORITY_SCOPE_CHANGED"
  | "RETRY_SCOPE_BROADENED"
  | "RETRY_AUTHORITY_STALE"
  | "GOVERNANCE_NOT_CONSUMABLE"
  | "DISPATCH_WINDOW_EXPIRED"
  | "DEAD_LETTER_CONFLICT"
  | "DRAIN_IN_PROGRESS"
  | "CALLBACK_REFERENCE_MISMATCH"
  | "CALLBACK_CONFLICT"
  | "RESULT_ALREADY_RECORDED"
  | "UNSUPPORTED_OPERATION";

export class RuntimeResilienceError extends Error {
  readonly code: RuntimeErrorCode;
  constructor(code: RuntimeErrorCode, message: string) {
    super(message);
    this.name = "RuntimeResilienceError";
    this.code = code;
  }
}

/** Malformed/unknown input at the strict boundary (mapped BAD_REQUEST). */
export class RuntimeInputError extends RuntimeResilienceError {
  constructor(code: RuntimeErrorCode, message: string) {
    super(code, message);
    this.name = "RuntimeInputError";
  }
}

/** Cross-tenant / cross-business scope (mapped FORBIDDEN). */
export class RuntimeOwnershipError extends RuntimeResilienceError {
  constructor(code: RuntimeErrorCode, message: string) {
    super(code, message);
    this.name = "RuntimeOwnershipError";
  }
}

/** Optimistic-CAS stale write / lost race (mapped CONFLICT). */
export class RuntimeStateConflictError extends RuntimeResilienceError {
  constructor(code: RuntimeErrorCode, message: string) {
    super(code, message);
    this.name = "RuntimeStateConflictError";
  }
}

/** Immutable-row hash drift = tampering (mapped CONFLICT). */
export class RuntimeTamperError extends RuntimeResilienceError {
  constructor(code: RuntimeErrorCode, message: string) {
    super(code, message);
    this.name = "RuntimeTamperError";
  }
}

/** Same convergence anchor replayed with conflicting material (CONFLICT). */
export class RuntimeIdentityConflictError extends RuntimeResilienceError {
  constructor(code: RuntimeErrorCode, message: string) {
    super(code, message);
    this.name = "RuntimeIdentityConflictError";
  }
}

/** Upstream authority seam validation failure (mapped BAD_REQUEST). */
export class RuntimeUpstreamError extends RuntimeResilienceError {
  constructor(code: RuntimeErrorCode, message: string) {
    super(code, message);
    this.name = "RuntimeUpstreamError";
  }
}

export function fail(code: RuntimeErrorCode, message: string): never {
  throw new RuntimeInputError(code, message);
}

// ─── Client-authority smuggling rejection (C13) ───

const FORBIDDEN_CLIENT_AUTHORITY_FIELDS = [
  "workerInstanceId",
  "jobId",
  "leaseId",
  "leaseEpoch",
  "jobState",
  "leaseState",
  "leaseExpiresAt",
  "claimedBy",
  "resultStatus",
  "resultHash",
  "failureClass",
  "uncertaintyClass",
  "deadLetterId",
  "liveness",
  "runtimeState",
  "version",
  "attemptRef",
  "authorityRef",
  "tenantUserId",
  "userId",
  "businessId",
  "missionId",
  "planId",
  "scheduleId",
  "taskId",
  "actionType",
  "jobType",
  "capability",
  "adapterType",
  "adapter",
  "provider",
  "providerAccount",
  "parametersFingerprint",
  "jobFingerprint",
  "runtimeVersion",
  "releaseVersion",
  "decision",
  "approved",
  "approval",
  "authorization",
  "authorizationFingerprint",
  "governanceDecisionId",
  "override",
  "forceDispatch",
  "forceAllow",
  "markSuccess",
  "markSucceeded",
  "executeNow",
  "execute",
  "run",
  "retry",
  "selfRetry",
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
  "disableMonitoring",
  "disableBackup",
  "monitoring",
  "backup",
  "policy",
] as const;

const SECRET_KEY_PATTERN =
  /^(api[_-]?key|apikeyv?\d*|secret|secret[_-]?key|token|access[_-]?token|refresh[_-]?token|password|passwd|client[_-]?secret|private[_-]?key|credential(s)?|session|bearer|authorization)$/i;

export function findForbiddenField(
  input: Record<string, unknown>
): string | null {
  for (const key of FORBIDDEN_CLIENT_AUTHORITY_FIELDS) {
    if (key in input) return key;
  }
  return null;
}

export function findSecretKey(value: unknown, depth = 0): string | null {
  if (
    value === null ||
    typeof value !== "object" ||
    depth > MAX_DIAGNOSTIC_DEPTH
  )
    return null;
  if (Array.isArray(value)) {
    for (const item of value) {
      const hit = findSecretKey(item, depth + 1);
      if (hit) return hit;
    }
    return null;
  }
  for (const [key, nested] of Object.entries(
    value as Record<string, unknown>
  )) {
    if (SECRET_KEY_PATTERN.test(key)) return key;
    const hit = findSecretKey(nested, depth + 1);
    if (hit) return hit;
  }
  return null;
}

// ─── Bounded, JSON-safe, secret-free diagnostic material ───

export const runtimeDiagnosticSchema = z.unknown().transform((value, ctxx) => {
  if (value === undefined) return {};
  const seen = new WeakSet<object>();
  const walk = (v: unknown, depth: number): boolean => {
    if (depth > MAX_DIAGNOSTIC_DEPTH) return false;
    if (
      v === null ||
      (typeof v === "number" && Number.isFinite(v)) ||
      typeof v === "boolean" ||
      typeof v === "string"
    ) {
      return true;
    }
    if (
      typeof v !== "object" ||
      depth > MAX_DIAGNOSTIC_DEPTH ||
      seen.has(v as object)
    )
      return false;
    seen.add(v as object);
    if (Array.isArray(v)) return v.every(item => walk(item, depth + 1));
    return Object.values(v as Record<string, unknown>).every(item =>
      walk(item, depth + 1)
    );
  };
  if (!walk(value, 0)) {
    ctxx.addIssue({
      code: "custom",
      message: "diagnostic must be bounded acyclic JSON material",
    });
    return z.NEVER;
  }
  const encoded = JSON.stringify(value);
  if (
    encoded.length > MAX_DIAGNOSTIC_CHARS ||
    findSecretKey(value) ||
    /(?:Bearer\s+\S+|-----BEGIN .*PRIVATE KEY|sk-[A-Za-z0-9]{16,})/i.test(
      encoded
    )
  ) {
    ctxx.addIssue({
      code: "custom",
      message: "diagnostic exceeds size or contains secret material",
    });
    return z.NEVER;
  }
  return value as Record<string, unknown>;
});

// ─── zod input schemas (strictObject — clients never supply authority) ───

export const registerWorkerSchema = z.strictObject({
  workerId: z.string().min(1).max(64).regex(SAFE_TOKEN_PATTERN),
  service: z.string().min(1).max(64).regex(SAFE_TOKEN_PATTERN),
  releaseVersion: z.string().min(1).max(64).regex(SAFE_TOKEN_PATTERN),
  capabilities: z
    .array(z.string().regex(SAFE_TOKEN_PATTERN))
    .min(1)
    .max(MAX_CAPABILITIES),
});

export type RegisterWorkerInput = z.infer<typeof registerWorkerSchema>;

// Controller-only enqueue references; all scope/material is loaded durably.
export const enqueueRuntimeJobSchema = z.strictObject({
  executionActionId: z.string().regex(EXECUTION_ACTION_ID_PATTERN),
  failedAttemptRef: z.string().regex(EXECUTION_ATTEMPT_ID_PATTERN).optional(),
});
export type EnqueueRuntimeJobInput = z.infer<typeof enqueueRuntimeJobSchema>;

// Worker delivery carries no identity assertion, authorization or outcome.
export const claimRuntimeJobSchema = z.strictObject({
  jobId: z.string().regex(RUNTIME_JOB_ID_PATTERN),
});
export type ClaimRuntimeJobInput = z.infer<typeof claimRuntimeJobSchema>;
export const getRuntimeJobSchema = claimRuntimeJobSchema;
export const deadLetterRuntimeJobSchema = claimRuntimeJobSchema.extend({
  reason: z.enum(RUNTIME_DEAD_LETTER_REASONS),
  diagnostic: runtimeDiagnosticSchema.optional(),
});
export type DeadLetterRuntimeJobInput = z.infer<
  typeof deadLetterRuntimeJobSchema
>;
