// ─── R9-C Dependency & Scheduling Intelligence — canonical contract ───
//
// PURE contract module: closed vocabularies, version identities, identity
// patterns, typed error taxonomy, zod router-input schemas and
// client-authority rejection for the mission dependency & scheduling
// authority (docs/contracts/mission-dependency-scheduling-contract.md).
// No I/O of any kind; authorizes nothing; executes nothing; invokes nothing.
//
// A dependency edge is durable, immutable ordering evidence between two task
// ids of ONE mission + plan. A schedule is deterministic ordering over a
// validated acyclic graph plus a readiness/blocking report. Schedules are
// never execution authorization: there is no EXECUTING status anywhere in
// this stream, no provider invocation, no budget movement, no capability
// minting, no approval minting, no upstream (R9-A/R9-F) table write.
//
// z.strictObject everywhere: clients name missions/plans/tasks and bounded
// declaration material only — never identity, status, readiness, risk,
// requiresApproval, ordering, fingerprints, hashes or validity.
//
// Frozen upstream (consumed read-only, never merged): R9-A mission authority
// (mission-authority/v1 @ 273ce40) and R9-F mission governance
// (mission-governance/v1 @ 1665d2f), both behind guarded information-schema
// seams. R9-B binds the mission-task-plan/v1 input port at R9-X.

import { z } from "zod";

// ─── Versions ───

export const MISSION_SCHEDULING_CONTRACT_VERSION = "mission-dependency-scheduling/v1" as const;
export const MISSION_SCHEDULING_ENGINE_VERSION = "mission-scheduling-engine/v1" as const;
export const MISSION_TASK_PLAN_PORT_VERSION = "mission-task-plan/v1" as const;
export const MISSION_SCHEDULING_STATE_PORT_VERSION = "mission-scheduling-state/v1" as const;
export const MISSION_SCHEDULING_PROJECTION_VERSION = "mission-scheduling-to-execution/v1" as const;

/** Frozen upstream contract versions this stream binds (contract §9). */
export const MISSION_SCHEDULING_BOUND_VERSIONS = Object.freeze({
  missionAuthority: "mission-authority/v1",
  missionGovernance: "mission-governance/v1",
});

// ─── Identity patterns ───

export const MISSION_ID_PATTERN = /^mis1:[a-f0-9]{64}$/;
export const PLAN_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,127}$/;
export const DEPENDENCY_ID_PATTERN = /^dep1:[a-f0-9]{64}$/;
export const SCHEDULE_ID_PATTERN = /^sch1:[a-f0-9]{64}$/;
export const SCHEDULE_LIFECYCLE_ID_PATTERN = /^msl1:[a-f0-9]{64}$/;
export const HEX_64_PATTERN = /^[a-f0-9]{64}$/;
export const ISO_UTC_PATTERN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,3})?Z$/;
export const CAPABILITY_PATTERN = /^[a-z][a-z0-9:_-]{0,63}$/;
export const RESOURCE_KEY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9:_-]{0,190}$/;
export const DEPENDENCY_REASON_MAX = 280;
export const TASK_REF_MAX = 120;

/** Determinism + bounded-traversal guarantees (contract §6). */
export const MAX_TASKS_PER_PLAN = 200;
export const MAX_DEPENDENCIES_PER_PLAN = 1000;
export const MAX_GRAPH_TRAVERSAL_STEPS = 20_000;

export function isIsoUtc(value: string): boolean {
  return ISO_UTC_PATTERN.test(value);
}

// ─── Closed vocabularies (contract §5) ───

export const MISSION_DEPENDENCY_TYPES = [
  "REQUIRES_COMPLETION",
  "REQUIRES_SUCCESS",
  "REQUIRES_OUTPUT",
  "REQUIRES_APPROVAL",
  "REQUIRES_CAPABILITY",
  "REQUIRES_TIME_WINDOW",
  "MUTUAL_EXCLUSION",
] as const;
export type MissionDependencyType = (typeof MISSION_DEPENDENCY_TYPES)[number];

export const MISSION_DEPENDENCY_HARDNESS = ["HARD", "SOFT"] as const;
export type MissionDependencyHardness = (typeof MISSION_DEPENDENCY_HARDNESS)[number];

export const MISSION_DEPENDENCY_SOURCES = [
  "PLAN_DERIVED",
  "OPERATOR_DECLARED",
  "SCHEDULING_DERIVED",
] as const;
export type MissionDependencySource = (typeof MISSION_DEPENDENCY_SOURCES)[number];

/** Hard ordering/ordering-gate edges that shape the DAG (MUTUAL_EXCLUSION is symmetric). */
export const ORDERING_DEPENDENCY_TYPES: readonly MissionDependencyType[] = Object.freeze([
  "REQUIRES_COMPLETION",
  "REQUIRES_SUCCESS",
  "REQUIRES_OUTPUT",
  "REQUIRES_APPROVAL",
  "REQUIRES_CAPABILITY",
  "REQUIRES_TIME_WINDOW",
]);

export const MISSION_TASK_READINESS_STATES = [
  "READY_FOR_SCHEDULING",
  "BLOCKED_DEPENDENCY",
  "BLOCKED_APPROVAL",
  "BLOCKED_CAPABILITY",
  "BLOCKED_TIME_WINDOW",
  "BLOCKED_CONSTRAINT",
  "STALE",
  "INVALID",
] as const;
export type MissionTaskReadiness = (typeof MISSION_TASK_READINESS_STATES)[number];

export const MISSION_SCHEDULE_STATUSES = [
  "PROPOSED",
  "VALIDATED",
  "READY",
  "BLOCKED",
  "SUPERSEDED",
  "STALE",
  "INVALIDATED",
  "CANCELLED",
] as const;
export type MissionScheduleStatus = (typeof MISSION_SCHEDULE_STATUSES)[number];

/** No EXECUTING — execution belongs to R9-D under R9-F governance. */
export const MISSION_SCHEDULE_ACTIVE_STATUSES = ["PROPOSED", "VALIDATED", "READY", "BLOCKED"] as const;

export const MISSION_SCHEDULE_LIFECYCLE_TYPES = [
  "creation",
  "validation",
  "supersession",
  "staleness",
  "invalidation",
  "cancellation",
] as const;
export type MissionScheduleLifecycleType = (typeof MISSION_SCHEDULE_LIFECYCLE_TYPES)[number];

export const MISSION_SCHEDULING_REASON_CODES = [
  "GRAPH_VALIDATED",
  "ALL_TASKS_READY",
  "TASKS_BLOCKED",
  "PLAN_REGISTERED",
  "SCHEDULE_REVISION",
  "DEPENDENCY_CHANGED",
  "APPROVAL_EVIDENCE_CHANGED",
  "EXECUTION_STATE_CHANGED",
  "MISSION_EXPIRED",
  "SCHEDULE_EXPIRED",
  "OPERATOR_CANCELLED",
  "SUPERSEDED_BY_SUCCESSOR",
] as const;
export type MissionSchedulingReasonCode = (typeof MISSION_SCHEDULING_REASON_CODES)[number];

/**
 * R9-A mission statuses under which scheduling may consume mission authority.
 * SUPERSEDED/STALE/CANCELLED/INVALIDATED missions are never schedulable; the
 * mission validity window additionally binds every schedule (contract §7).
 */
export const SCHEDULABLE_MISSION_STATUSES = ["PROPOSED", "ELIGIBLE_FOR_PLANNING", "REVIEW_REQUIRED"] as const;
export type SchedulableMissionStatus = (typeof SCHEDULABLE_MISSION_STATUSES)[number];

export const MISSION_SCHEDULING_RISK_CLASSES = ["LOW", "MEDIUM", "HIGH", "CRITICAL"] as const;
export type MissionSchedulingRiskClass = (typeof MISSION_SCHEDULING_RISK_CLASSES)[number];

export const MISSION_TASK_SIDE_EFFECT_CLASSES = [
  "NONE",
  "OBSERVATION",
  "INTERNAL_MUTATION",
  "EXTERNAL_SIDE_EFFECT",
  "FINANCIAL",
  "IRREVERSIBLE",
] as const;
export type MissionTaskSideEffectClass = (typeof MISSION_TASK_SIDE_EFFECT_CLASSES)[number];

export const MISSION_TASK_CONSTRAINT_TYPES = ["TIME_WINDOW", "EXCLUSIVE_RESOURCE"] as const;
export type MissionTaskConstraintType = (typeof MISSION_TASK_CONSTRAINT_TYPES)[number];

/**
 * Closed governance-surface reason codes (C9). A schedule may set
 * requiresApproval=true with these reasons — never ALLOW, never a decision.
 */
export const MISSION_SCHEDULING_GOVERNANCE_REASON_CODES = [
  "REQUIRES_APPROVAL_MATERIAL",
  "APPROVAL_EVIDENCE_MISSING",
  "SIDE_EFFECT_REVIEW",
  "RISK_REVIEW",
  "SEQUENCE_CHANGED",
] as const;
export type MissionSchedulingGovernanceReasonCode =
  (typeof MISSION_SCHEDULING_GOVERNANCE_REASON_CODES)[number];

/** Duplicate convergence classification for insert-first persistence. */
export const MISSION_SCHEDULING_DUPLICATE_CLASSIFICATIONS = ["none", "idempotent_replay"] as const;
export type MissionSchedulingDuplicateClassification =
  (typeof MISSION_SCHEDULING_DUPLICATE_CLASSIFICATIONS)[number];

// ─── Typed error taxonomy (closed codes) ───

export type MissionSchedulingErrorCode =
  | "SCHEDULING_INPUT_MALFORMED"
  | "SCHEDULING_CLIENT_AUTHORITY_FIELD_FORBIDDEN"
  | "PLAN_PORT_VERSION_UNSUPPORTED"
  | "PLAN_PORT_MALFORMED"
  | "UNKNOWN_MISSION"
  | "UNKNOWN_PLAN"
  | "MISSION_NOT_SCHEDULABLE"
  | "MISSION_EXPIRED"
  | "UNKNOWN_PREDECESSOR_TASK"
  | "UNKNOWN_SUCCESSOR_TASK"
  | "CROSS_MISSION_DEPENDENCY"
  | "CROSS_PLAN_DEPENDENCY"
  | "CROSS_TENANT_DEPENDENCY"
  | "CROSS_BUSINESS_DEPENDENCY"
  | "SELF_DEPENDENCY"
  | "SCHEDULING_CYCLE"
  | "SCHEDULING_GRAPH_TOO_LARGE"
  | "UNKNOWN_DEPENDENCY_TYPE"
  | "UNKNOWN_DEPENDENCY_SOURCE"
  | "EXECUTION_STATE_INVALID"
  | "STALE_TASK"
  | "TIME_WINDOW_INVALID"
  | "MISSION_SCHEDULING_AUTHORITY_UNAVAILABLE"
  | "SCHEDULING_REPLAY_CONFLICT"
  | "SCHEDULING_STALE_STATE"
  | "SCHEDULING_TAMPER"
  | "SCHEDULING_LIFECYCLE_CONFLICT"
  | "SCHEDULE_NOT_FOUND"
  | "SCHEDULE_NOT_CANCELLABLE";

export class MissionSchedulingError extends Error {
  readonly code: MissionSchedulingErrorCode;
  constructor(code: MissionSchedulingErrorCode, message: string) {
    super(message);
    this.name = "MissionSchedulingError";
    this.code = code;
  }
}

/** Malformed/unknown input at the strict boundary (mapped BAD_REQUEST). */
export class MissionSchedulingInputError extends MissionSchedulingError {
  constructor(code: MissionSchedulingErrorCode, message: string) {
    super(code, message);
    this.name = "MissionSchedulingInputError";
  }
}

/** Cross-tenant / cross-business evidence or scope (mapped FORBIDDEN). */
export class MissionSchedulingOwnershipError extends MissionSchedulingError {
  constructor(code: MissionSchedulingErrorCode, message: string) {
    super(code, message);
    this.name = "MissionSchedulingOwnershipError";
  }
}

/** Graph/validation rule failure: cycles, unknown tasks, limits (BAD_REQUEST). */
export class MissionSchedulingValidationError extends MissionSchedulingError {
  constructor(code: MissionSchedulingErrorCode, message: string) {
    super(code, message);
    this.name = "MissionSchedulingValidationError";
  }
}

/** Same convergence anchor replayed with conflicting material (CONFLICT). */
export class MissionSchedulingIdentityConflictError extends MissionSchedulingError {
  constructor(code: MissionSchedulingErrorCode, message: string) {
    super(code, message);
    this.name = "MissionSchedulingIdentityConflictError";
  }
}

/** Optimistic-CAS stale write (CONFLICT). */
export class MissionSchedulingStateConflictError extends MissionSchedulingError {
  constructor(code: MissionSchedulingErrorCode, message: string) {
    super(code, message);
    this.name = "MissionSchedulingStateConflictError";
  }
}

/** Immutable-row hash drift = tampering (CONFLICT). */
export class MissionSchedulingTamperError extends MissionSchedulingError {
  constructor(code: MissionSchedulingErrorCode, message: string) {
    super(code, message);
    this.name = "MissionSchedulingTamperError";
  }
}

export function fail(code: MissionSchedulingErrorCode, message: string): never {
  throw new MissionSchedulingInputError(code, message);
}

// ─── zod input schemas (strictObject — clients never supply authority) ───

const boundedTaskRef = z.string().min(1).max(TASK_REF_MAX);
const capabilityRef = z.string().regex(CAPABILITY_PATTERN);

export const taskTimeWindowConstraintSchema = z
  .strictObject({
    constraintType: z.literal("TIME_WINDOW"),
    notBefore: z.string().regex(ISO_UTC_PATTERN).optional(),
    notAfter: z.string().regex(ISO_UTC_PATTERN).optional(),
  })
  .refine((value) => value.notBefore !== undefined || value.notAfter !== undefined, {
    message: "TIME_WINDOW requires at least one bound",
  });

export const taskExclusiveResourceConstraintSchema = z.strictObject({
  constraintType: z.literal("EXCLUSIVE_RESOURCE"),
  resourceKey: z.string().regex(RESOURCE_KEY_PATTERN),
});

export const missionTaskConstraintSchema = z.discriminatedUnion("constraintType", [
  taskTimeWindowConstraintSchema,
  taskExclusiveResourceConstraintSchema,
]);

export const missionTaskGovernanceCharacteristicsSchema = z.strictObject({
  /** B-declared material signals; the server may only RAISE derived risk. */
  requiresApproval: z.boolean(),
  irreversible: z.boolean(),
  financialExposure: z.boolean(),
  sideEffectClass: z.enum(MISSION_TASK_SIDE_EFFECT_CLASSES),
  declaredRiskClass: z.enum(MISSION_SCHEDULING_RISK_CLASSES).optional(),
});

export const missionTaskSpecSchema = z.strictObject({
  /** Opaque R9-B task identity; scheduling never rewrites task semantics. */
  taskId: z.string().regex(TASK_ID_PATTERN),
  taskType: z.string().min(1).max(64),
  preconditions: z.array(boundedTaskRef).max(8),
  postconditions: z.array(boundedTaskRef).max(8),
  requiredCapabilities: z.array(capabilityRef).max(8),
  constraints: z.array(missionTaskConstraintSchema).max(8),
  governanceCharacteristics: missionTaskGovernanceCharacteristicsSchema,
  validity: z.strictObject({ validFrom: z.string().regex(ISO_UTC_PATTERN), validUntil: z.string().regex(ISO_UTC_PATTERN) }).nullable(),
});

/**
 * C1 — the typed, versioned scheduling input port. R9-X binds this exact
 * schema to frozen R9-B; R9-C validates and stores it as verbatim scheduling
 * material. The port is not permission to invent missing plan data: unknown
 * versions, malformed tasks, duplicate task ids and plan/mission mismatches
 * all fail closed.
 */
export const missionTaskPlanPortSchema = z
  .strictObject({
    portVersion: z.literal(MISSION_TASK_PLAN_PORT_VERSION),
    missionId: z.string().regex(MISSION_ID_PATTERN),
    planId: z.string().regex(PLAN_ID_PATTERN),
    /** Environment contract the plan declares; scheduling can never widen it. */
    supportedCapabilities: z.array(capabilityRef).max(32),
    tasks: z.array(missionTaskSpecSchema).min(1).max(MAX_TASKS_PER_PLAN),
  })
  .refine(
    (plan) => new Set(plan.tasks.map((task) => task.taskId)).size === plan.tasks.length,
    { message: "duplicate taskId in plan" }
  )
  .refine(
    (plan) =>
      plan.tasks.every(
        (task) =>
          task.validity === null ||
          Date.parse(task.validity.validUntil) > Date.parse(task.validity.validFrom)
      ),
    { message: "task validity window is inverted" }
  );

export type MissionTaskPlanPort = z.infer<typeof missionTaskPlanPortSchema>;
export type MissionTaskSpec = z.infer<typeof missionTaskSpecSchema>;

/**
 * Execution-state view consumed for readiness only. Untrusted scheduling
 * material: it is bound into the schedule identity (drift is visible) but it
 * is never execution truth — readiness != execution authorization, and a
 * client can no more mint completion here than it can mint approvals.
 */
export const missionSchedulingStatePortSchema = z.strictObject({
  portVersion: z.literal(MISSION_SCHEDULING_STATE_PORT_VERSION),
  completedTaskIds: z.array(z.string().regex(TASK_ID_PATTERN)).max(MAX_TASKS_PER_PLAN),
  succeededTaskIds: z.array(z.string().regex(TASK_ID_PATTERN)).max(MAX_TASKS_PER_PLAN),
});

export type MissionSchedulingStatePort = z.infer<typeof missionSchedulingStatePortSchema>;

export const EMPTY_SCHEDULING_STATE: MissionSchedulingStatePort = Object.freeze({
  portVersion: MISSION_SCHEDULING_STATE_PORT_VERSION,
  completedTaskIds: [],
  succeededTaskIds: [],
}) as MissionSchedulingStatePort;

/** C2 — dependency declaration. The server mints dep1: identity + validates scope. */
export const recordMissionDependencySchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  planId: z.string().regex(PLAN_ID_PATTERN),
  predecessorTaskId: z.string().regex(TASK_ID_PATTERN),
  successorTaskId: z.string().regex(TASK_ID_PATTERN),
  dependencyType: z.enum(MISSION_DEPENDENCY_TYPES),
  reason: z.string().max(DEPENDENCY_REASON_MAX).optional(),
  hardOrSoft: z.enum(MISSION_DEPENDENCY_HARDNESS),
  source: z.enum(MISSION_DEPENDENCY_SOURCES),
});

export type RecordMissionDependencyInput = z.infer<typeof recordMissionDependencySchema>;

export const produceMissionScheduleSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  planId: z.string().regex(PLAN_ID_PATTERN),
  executionState: missionSchedulingStatePortSchema.optional(),
});

export type ProduceMissionScheduleInput = z.infer<typeof produceMissionScheduleSchema>;

export const missionPlanCoordinateSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN),
  planId: z.string().regex(PLAN_ID_PATTERN),
});

export const listMissionDependenciesSchema = missionPlanCoordinateSchema.extend({
  dependencyType: z.enum(MISSION_DEPENDENCY_TYPES).optional(),
  hardOrSoft: z.enum(MISSION_DEPENDENCY_HARDNESS).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const listMissionSchedulesSchema = z.strictObject({
  missionId: z.string().regex(MISSION_ID_PATTERN).optional(),
  planId: z.string().regex(PLAN_ID_PATTERN).optional(),
  status: z.enum(MISSION_SCHEDULE_STATUSES).optional(),
  limit: z.number().int().positive().max(500).optional(),
});

export const cancelMissionScheduleSchema = z.strictObject({
  scheduleId: z.string().regex(SCHEDULE_ID_PATTERN),
  expectedVersion: z.number().int().positive(),
});

// ─── Derived classification helpers ───

export function isOrderingDependency(type: MissionDependencyType): boolean {
  return (ORDERING_DEPENDENCY_TYPES as readonly string[]).includes(type);
}

export function isSchedulableMissionStatus(status: string): status is SchedulableMissionStatus {
  return (SCHEDULABLE_MISSION_STATUSES as readonly string[]).includes(status);
}

export function isActiveScheduleStatus(status: string): boolean {
  return (MISSION_SCHEDULE_ACTIVE_STATUSES as readonly string[]).includes(status);
}

/**
 * Normalise a MUTUAL_EXCLUSION pair to a canonical (predecessor, successor)
 * order so the identity + natural key are exact-once for the symmetric edge.
 */
export function canonicalExclusionPair(a: string, b: string): [string, string] {
  return a <= b ? [a, b] : [b, a];
}
