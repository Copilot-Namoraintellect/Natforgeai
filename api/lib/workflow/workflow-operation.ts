/**
 * Workflow Operation Identity Model.
 *
 * Slice 3 scope:
 * - deterministic top-level workflowOperationId from a canonical identity payload;
 * - deterministic workflowAttemptId for child attempts;
 * - in-memory registry with idempotency, conflict detection and state transitions;
 * - immutable WorkflowCorrelationContext;
 * - no database persistence, no provider calls, no billing, no workflow mutation.
 *
 * This module is intentionally neutral: it does not depend on creative-domain
 * types so it can be reused by any workflow phase.
 */

import { createHash } from "crypto";

export type WorkflowOperationType =
  | "strategy_generation"
  | "creative_generation"
  | "creative_recovery"
  | "creative_repair"
  | "publishing";

export type WorkflowOperationSource =
  | "approval"
  | "manual"
  | "automatic"
  | "recovery"
  | "scheduled";

export type WorkflowOperationStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type WorkflowAttemptType =
  | "message_pack"
  | "creative_generation"
  | "creative_regeneration"
  | "targeted_repair"
  | "quality_evaluation"
  | "render"
  | "final_persistence"
  | "billing"
  | "publishing";

export type WorkflowAttemptStatus =
  | "created"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type DuplicateClassification =
  | "none"
  | "idempotent_replay"
  | "idempotency_conflict"
  | "ambiguous_operation";

export interface WorkflowOperation {
  workflowOperationId: string;
  idempotencyKey: string;
  operationType: WorkflowOperationType;
  operationSource: WorkflowOperationSource;
  operationReferenceId: string;
  campaignId: number;
  userId: number;
  businessId: number | null;
  contractFingerprint: string | null;
  strategyRunId: number | null;
  approvalRequestId: number | null;
  claimId: number | null;
  status: WorkflowOperationStatus;
  failureCode: string | null;
  createdAt: string; // ISO 8601 from deterministic input, never now()
}

export interface WorkflowAttempt {
  workflowAttemptId: string;
  workflowOperationId: string;
  attemptType: WorkflowAttemptType;
  ordinal: number;
  parentAttemptId: string | null;
  status: WorkflowAttemptStatus;
  providerRunId: string | null;
  internalRunId: number | null;
  failureCode: string | null;
}

export interface WorkflowOperationIdentityInput {
  operationType: WorkflowOperationType;
  operationSource: WorkflowOperationSource;
  operationReferenceId: string | number;
  campaignId: number;
  userId: number;
  businessId?: number | null;
  contractFingerprint?: string | null;
  strategyRunId?: number | null;
  approvalRequestId?: number | null;
  claimId?: number | null;
  /**
   * Trusted external idempotency key, if one already exists (e.g. a charge key).
   * It is recorded and validated, but the canonical workflow identity still
   * wins; a conflicting external key produces IDEMPOTENCY_KEY_CONFLICT.
   */
  externalIdempotencyKey?: string | null;
  /**
   * Authorisation timestamp used only for correlation context; does not affect
   * the workflowOperationId unless the caller explicitly includes it in the
   * reference (which is not recommended).
   */
  approvedAt?: string | null;
}

export interface WorkflowAttemptIdentityInput {
  workflowOperationId: string;
  attemptType: WorkflowAttemptType;
  /**
   * Positive integer. If omitted, the registry assigns the next ordinal for this
   * attempt type under the operation.
   */
  ordinal?: number;
  parentAttemptId?: string | null;
  providerRunId?: string | null;
  internalRunId?: number | null;
}

export interface WorkflowCorrelationContext {
  workflowOperationId: string;
  idempotencyKey: string;
  campaignId: number;
  userId: number;
  businessId: number | null;
  strategyRunId: number | null;
  approvalRequestId: number | null;
  claimId: number | null;
  contractFingerprint: string | null;
  operationType: WorkflowOperationType;
  operationSource: WorkflowOperationSource;
  operationReferenceId: string;
}

export interface CorrelationValidationResult {
  valid: boolean;
  failureCodes: string[];
}

export interface RegisterOperationResult {
  operation: WorkflowOperation;
  duplicateClassification: DuplicateClassification;
}

export interface RegisterAttemptResult {
  attempt: WorkflowAttempt;
  duplicateClassification: DuplicateClassification;
}

export class WorkflowOperationError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = "WorkflowOperationError";
    this.code = code;
  }
}

function sortKeys(value: unknown): unknown {
  if (value === null || typeof value !== "object") {
    if (typeof value === "string") return value.trim().replace(/\s+/g, " ");
    return value;
  }
  if (Array.isArray(value)) {
    return value.map(sortKeys);
  }
  const sorted: Record<string, unknown> = {};
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj).sort()) {
    sorted[key] = sortKeys(obj[key]);
  }
  return sorted;
}

function canonicalize(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function normalizeReference(value: string | number): string {
  return String(value).trim();
}

function sha256(input: string): string {
  return createHash("sha256").update(input, "utf8").digest("hex");
}

function deterministicIsoTimestamp(input: WorkflowOperationIdentityInput): string {
  // Use the persisted approval timestamp if present so the correlation context
  // is stable; otherwise leave empty rather than using runtime time or a
  // synthetic epoch placeholder.
  if (input.approvedAt && typeof input.approvedAt === "string") {
    return input.approvedAt;
  }
  return "";
}

/**
 * Build the canonical identity payload for a top-level workflow operation.
 * The same authorised invocation always produces the same payload and ID.
 */
export function buildWorkflowOperationIdentityPayload(
  input: WorkflowOperationIdentityInput
): Record<string, unknown> {
  return {
    operationType: input.operationType,
    operationSource: input.operationSource,
    operationReferenceId: normalizeReference(input.operationReferenceId),
    campaignId: input.campaignId,
    userId: input.userId,
    contractFingerprint: input.contractFingerprint ?? null,
    strategyRunId: input.strategyRunId ?? null,
    approvalRequestId: input.approvalRequestId ?? null,
  };
}

export function buildWorkflowOperationId(input: WorkflowOperationIdentityInput): string {
  const payload = buildWorkflowOperationIdentityPayload(input);
  return sha256(canonicalize(payload));
}

export function buildWorkflowIdempotencyKey(input: WorkflowOperationIdentityInput): string {
  if (input.externalIdempotencyKey && input.externalIdempotencyKey.trim().length > 0) {
    return input.externalIdempotencyKey.trim();
  }
  return buildWorkflowOperationId(input);
}

export function buildWorkflowCorrelationContext(
  input: WorkflowOperationIdentityInput
): WorkflowCorrelationContext {
  const workflowOperationId = buildWorkflowOperationId(input);
  const idempotencyKey = buildWorkflowIdempotencyKey(input);
  return {
    workflowOperationId,
    idempotencyKey,
    campaignId: input.campaignId,
    userId: input.userId,
    businessId: input.businessId ?? null,
    strategyRunId: input.strategyRunId ?? null,
    approvalRequestId: input.approvalRequestId ?? null,
    claimId: input.claimId ?? null,
    contractFingerprint: input.contractFingerprint ?? null,
    operationType: input.operationType,
    operationSource: input.operationSource,
    operationReferenceId: normalizeReference(input.operationReferenceId),
  };
}

/**
 * Build a deterministic attempt ID.  The parent ID participates so the
 * attempt lineage is stable; provider/internal run IDs are not identity inputs.
 */
export function buildWorkflowAttemptId(input: WorkflowAttemptIdentityInput): string {
  const payload = {
    workflowOperationId: input.workflowOperationId,
    attemptType: input.attemptType,
    ordinal: input.ordinal,
    parentAttemptId: input.parentAttemptId ?? null,
  };
  return sha256(canonicalize(payload));
}

const TERMINAL_OPERATION_STATUSES: Set<WorkflowOperationStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const TERMINAL_ATTEMPT_STATUSES: Set<WorkflowAttemptStatus> = new Set([
  "completed",
  "failed",
  "cancelled",
]);

const VALID_OPERATION_TRANSITIONS: Record<WorkflowOperationStatus, Set<WorkflowOperationStatus>> = {
  created: new Set(["running", "cancelled"]),
  running: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

const VALID_ATTEMPT_TRANSITIONS: Record<WorkflowAttemptStatus, Set<WorkflowAttemptStatus>> = {
  created: new Set(["running", "cancelled"]),
  running: new Set(["completed", "failed", "cancelled"]),
  completed: new Set(),
  failed: new Set(),
  cancelled: new Set(),
};

export function transitionOperationStatus(
  current: WorkflowOperationStatus,
  next: WorkflowOperationStatus
): WorkflowOperationStatus {
  if (current === next) return current;
  if (TERMINAL_OPERATION_STATUSES.has(current)) {
    throw new WorkflowOperationError(
      "INVALID_OPERATION_TRANSITION",
      `Cannot transition operation from terminal state "${current}" to "${next}".`
    );
  }
  if (!VALID_OPERATION_TRANSITIONS[current].has(next)) {
    throw new WorkflowOperationError(
      "INVALID_OPERATION_TRANSITION",
      `Invalid operation transition: "${current}" -> "${next}".`
    );
  }
  return next;
}

export function transitionAttemptStatus(
  current: WorkflowAttemptStatus,
  next: WorkflowAttemptStatus
): WorkflowAttemptStatus {
  if (current === next) return current;
  if (TERMINAL_ATTEMPT_STATUSES.has(current)) {
    throw new WorkflowOperationError(
      "INVALID_ATTEMPT_TRANSITION",
      `Cannot transition attempt from terminal state "${current}" to "${next}".`
    );
  }
  if (!VALID_ATTEMPT_TRANSITIONS[current].has(next)) {
    throw new WorkflowOperationError(
      "INVALID_ATTEMPT_TRANSITION",
      `Invalid attempt transition: "${current}" -> "${next}".`
    );
  }
  return next;
}

export function validateWorkflowCorrelation(
  baseline: WorkflowCorrelationContext,
  candidate: Partial<WorkflowCorrelationContext>
): CorrelationValidationResult {
  const failures: string[] = [];
  const check = (
    field: keyof WorkflowCorrelationContext,
    expected: unknown,
    actual: unknown
  ) => {
    if (actual !== undefined && actual !== null && actual !== expected) {
      failures.push(`CORRELATION_MISMATCH_${String(field).toUpperCase()}`);
    }
  };
  check("campaignId", baseline.campaignId, candidate.campaignId);
  check("userId", baseline.userId, candidate.userId);
  check("businessId", baseline.businessId, candidate.businessId);
  check("strategyRunId", baseline.strategyRunId, candidate.strategyRunId);
  check("approvalRequestId", baseline.approvalRequestId, candidate.approvalRequestId);
  check("claimId", baseline.claimId, candidate.claimId);
  check("contractFingerprint", baseline.contractFingerprint, candidate.contractFingerprint);
  check("operationType", baseline.operationType, candidate.operationType);
  check("operationSource", baseline.operationSource, candidate.operationSource);
  check("operationReferenceId", baseline.operationReferenceId, candidate.operationReferenceId);
  return { valid: failures.length === 0, failureCodes: failures };
}

export interface RegistrySnapshot {
  operations: WorkflowOperation[];
  attempts: WorkflowAttempt[];
}

/**
 * Injectable in-memory registry.  Create a fresh instance per request or test
 * scope to avoid cross-campaign/request leakage.
 */
export class InMemoryWorkflowOperationRegistry {
  private operations = new Map<string, WorkflowOperation>();
  private attemptsByOperation = new Map<string, Map<string, WorkflowAttempt>>();
  private idempotencyKeyToOperationId = new Map<string, string>();
  private referenceIndex = new Map<string, string>(); // operationType:source:ref:campaign:user -> operationId

  private referenceKey(input: WorkflowOperationIdentityInput): string {
    return [
      input.operationType,
      input.operationSource,
      normalizeReference(input.operationReferenceId),
      input.campaignId,
      input.userId,
    ].join(":");
  }

  private buildOperation(input: WorkflowOperationIdentityInput): WorkflowOperation {
    return {
      workflowOperationId: buildWorkflowOperationId(input),
      idempotencyKey: buildWorkflowIdempotencyKey(input),
      operationType: input.operationType,
      operationSource: input.operationSource,
      operationReferenceId: normalizeReference(input.operationReferenceId),
      campaignId: input.campaignId,
      userId: input.userId,
      businessId: input.businessId ?? null,
      contractFingerprint: input.contractFingerprint ?? null,
      strategyRunId: input.strategyRunId ?? null,
      approvalRequestId: input.approvalRequestId ?? null,
      claimId: input.claimId ?? null,
      status: "created",
      failureCode: null,
      createdAt: deterministicIsoTimestamp(input),
    };
  }

  registerOperation(input: WorkflowOperationIdentityInput): RegisterOperationResult {
    const operation = this.buildOperation(input);
    const refKey = this.referenceKey(input);

    // Same canonical identity -> idempotent replay.
    const existingById = this.operations.get(operation.workflowOperationId);
    if (existingById) {
      return {
        operation: existingById,
        duplicateClassification: "idempotent_replay",
      };
    }

    // Same reference key with different canonical identity -> ambiguous operation.
    const existingRefId = this.referenceIndex.get(refKey);
    if (existingRefId && existingRefId !== operation.workflowOperationId) {
      throw new WorkflowOperationError(
        "AMBIGUOUS_OPERATION",
        `Operation reference "${refKey}" is already bound to a different workflow operation (${existingRefId}).`
      );
    }

    // External idempotency key conflict.
    if (input.externalIdempotencyKey) {
      const existingByKey = this.idempotencyKeyToOperationId.get(input.externalIdempotencyKey);
      if (existingByKey && existingByKey !== operation.workflowOperationId) {
        throw new WorkflowOperationError(
          "IDEMPOTENCY_KEY_CONFLICT",
          `Idempotency key "${input.externalIdempotencyKey}" is already bound to operation ${existingByKey}.`
        );
      }
    }

    this.operations.set(operation.workflowOperationId, operation);
    this.attemptsByOperation.set(operation.workflowOperationId, new Map());
    this.referenceIndex.set(refKey, operation.workflowOperationId);
    if (input.externalIdempotencyKey) {
      this.idempotencyKeyToOperationId.set(input.externalIdempotencyKey, operation.workflowOperationId);
    }
    return { operation, duplicateClassification: "none" };
  }

  findOperation(workflowOperationId: string): WorkflowOperation | null {
    return this.operations.get(workflowOperationId) ?? null;
  }

  findOperationByIdempotencyKey(idempotencyKey: string): WorkflowOperation | null {
    const id = this.idempotencyKeyToOperationId.get(idempotencyKey);
    if (!id) return null;
    return this.operations.get(id) ?? null;
  }

  private nextOrdinalForType(
    workflowOperationId: string,
    attemptType: WorkflowAttemptType
  ): number {
    const attempts = this.attemptsByOperation.get(workflowOperationId);
    if (!attempts) return 1;
    let max = 0;
    for (const attempt of attempts.values()) {
      if (attempt.attemptType === attemptType && attempt.ordinal > max) {
        max = attempt.ordinal;
      }
    }
    return max + 1;
  }

  private validateAttemptOperation(workflowOperationId: string): WorkflowOperation {
    const operation = this.operations.get(workflowOperationId);
    if (!operation) {
      throw new WorkflowOperationError(
        "OPERATION_NOT_FOUND",
        `Cannot register attempt for unknown operation ${workflowOperationId}.`
      );
    }

    if (TERMINAL_OPERATION_STATUSES.has(operation.status)) {
      throw new WorkflowOperationError(
        "ATTEMPT_UNDER_TERMINAL_OPERATION",
        `Cannot register attempt under terminal operation status "${operation.status}".`
      );
    }

    return operation;
  }

  private validateAttemptOrdinal(ordinal: unknown): asserts ordinal is number {
    if (typeof ordinal !== "number" || !Number.isInteger(ordinal) || ordinal <= 0) {
      throw new WorkflowOperationError(
        "INVALID_ATTEMPT_ORDINAL",
        `Attempt ordinal must be a positive integer, got ${String(ordinal)}.`
      );
    }
  }

  private validateAttemptParent(
    workflowOperationId: string,
    parentAttemptId: string | null | undefined
  ): void {
    if (!parentAttemptId) return;

    let parent: WorkflowAttempt | undefined;
    let parentOperationId: string | undefined;
    for (const [opId, opAttempts] of this.attemptsByOperation.entries()) {
      const candidate = opAttempts.get(parentAttemptId);
      if (candidate) {
        parent = candidate;
        parentOperationId = opId;
        break;
      }
    }
    if (!parent) {
      throw new WorkflowOperationError(
        "PARENT_ATTEMPT_NOT_FOUND",
        `Parent attempt ${parentAttemptId} does not exist under operation ${workflowOperationId}.`
      );
    }
    if (parentOperationId !== workflowOperationId) {
      throw new WorkflowOperationError(
        "CROSS_OPERATION_PARENT",
        `Parent attempt ${parentAttemptId} belongs to a different operation.`
      );
    }
  }

  private validateAttemptEligibility(
    attemptType: WorkflowAttemptType,
    eligibility?: { finalAssetSelected?: boolean; chargePermitted?: boolean }
  ): void {
    if (attemptType === "final_persistence") {
      if (!eligibility?.finalAssetSelected) {
        throw new WorkflowOperationError(
          "FINAL_PERSISTENCE_NOT_ELIGIBLE",
          "final_persistence attempt requires finalAssetSelected eligibility."
        );
      }
    }
    if (attemptType === "billing") {
      if (!eligibility?.chargePermitted) {
        throw new WorkflowOperationError(
          "BILLING_NOT_ELIGIBLE",
          "billing attempt requires chargePermitted eligibility."
        );
      }
    }
  }

  /**
   * Register or replay a known logical attempt.  The caller must supply the
   * deterministic ordinal that identifies the logical attempt.  Repeating the
   * same identity returns the existing attempt without creating a new one.
   */
  registerAttemptReplay(
    input: WorkflowAttemptIdentityInput & {
      eligibility?: { finalAssetSelected?: boolean; chargePermitted?: boolean };
    }
  ): RegisterAttemptResult {
    this.validateAttemptOrdinal(input.ordinal);

    const ordinal = input.ordinal as number;
    const attempts = this.attemptsByOperation.get(input.workflowOperationId);
    if (!attempts) {
      throw new WorkflowOperationError(
        "OPERATION_NOT_FOUND",
        `Cannot register attempt for unknown operation ${input.workflowOperationId}.`
      );
    }

    const workflowAttemptId = buildWorkflowAttemptId({
      workflowOperationId: input.workflowOperationId,
      attemptType: input.attemptType,
      ordinal,
      parentAttemptId: input.parentAttemptId ?? null,
    });

    const existing = attempts.get(workflowAttemptId);
    if (existing) {
      if (
        existing.attemptType === input.attemptType &&
        existing.ordinal === ordinal &&
        existing.parentAttemptId === (input.parentAttemptId ?? null) &&
        existing.providerRunId === (input.providerRunId ?? null) &&
        existing.internalRunId === (input.internalRunId ?? null)
      ) {
        return { attempt: existing, duplicateClassification: "idempotent_replay" };
      }
      throw new WorkflowOperationError(
        "DUPLICATE_ATTEMPT_IDENTITY_CONFLICT",
        `Attempt ${workflowAttemptId} already exists with conflicting attributes.`
      );
    }

    // New attempts cannot be added under a terminal operation.
    this.validateAttemptOperation(input.workflowOperationId);
    this.validateAttemptParent(input.workflowOperationId, input.parentAttemptId);
    this.validateAttemptEligibility(input.attemptType, input.eligibility);

    const attempt: WorkflowAttempt = {
      workflowAttemptId,
      workflowOperationId: input.workflowOperationId,
      attemptType: input.attemptType,
      ordinal,
      parentAttemptId: input.parentAttemptId ?? null,
      status: "created",
      providerRunId: input.providerRunId ?? null,
      internalRunId: input.internalRunId ?? null,
      failureCode: null,
    };
    attempts.set(workflowAttemptId, attempt);
    return { attempt, duplicateClassification: "none" };
  }

  /**
   * Allocate a genuinely new attempt under the operation.  The next ordinal for
   * the attempt type is computed deterministically from the current registry
   * state; this is explicitly not a replay-safe operation.
   */
  allocateNewAttempt(
    input: Omit<WorkflowAttemptIdentityInput, "ordinal"> & {
      eligibility?: { finalAssetSelected?: boolean; chargePermitted?: boolean };
    }
  ): RegisterAttemptResult {
    this.validateAttemptOperation(input.workflowOperationId);
    this.validateAttemptParent(input.workflowOperationId, input.parentAttemptId);
    this.validateAttemptEligibility(input.attemptType, input.eligibility);

    const ordinal = this.nextOrdinalForType(input.workflowOperationId, input.attemptType);
    const workflowAttemptId = buildWorkflowAttemptId({
      workflowOperationId: input.workflowOperationId,
      attemptType: input.attemptType,
      ordinal,
      parentAttemptId: input.parentAttemptId ?? null,
    });

    const attempts = this.attemptsByOperation.get(input.workflowOperationId)!;
    if (attempts.has(workflowAttemptId)) {
      throw new WorkflowOperationError(
        "DUPLICATE_ATTEMPT_IDENTITY_CONFLICT",
        `Allocated attempt ${workflowAttemptId} already exists; ordinal allocation collided with an existing attempt.`
      );
    }

    const attempt: WorkflowAttempt = {
      workflowAttemptId,
      workflowOperationId: input.workflowOperationId,
      attemptType: input.attemptType,
      ordinal,
      parentAttemptId: input.parentAttemptId ?? null,
      status: "created",
      providerRunId: input.providerRunId ?? null,
      internalRunId: input.internalRunId ?? null,
      failureCode: null,
    };
    attempts.set(workflowAttemptId, attempt);
    return { attempt, duplicateClassification: "none" };
  }

  listAttempts(workflowOperationId: string): WorkflowAttempt[] {
    const attempts = this.attemptsByOperation.get(workflowOperationId);
    if (!attempts) return [];
    return Array.from(attempts.values()).sort((a, b) => {
      if (a.attemptType !== b.attemptType) {
        return a.attemptType.localeCompare(b.attemptType);
      }
      return a.ordinal - b.ordinal;
    });
  }

  transitionOperation(
    workflowOperationId: string,
    nextStatus: WorkflowOperationStatus,
    failureCode?: string | null
  ): WorkflowOperation {
    const operation = this.operations.get(workflowOperationId);
    if (!operation) {
      throw new WorkflowOperationError(
        "OPERATION_NOT_FOUND",
        `Cannot transition unknown operation ${workflowOperationId}.`
      );
    }
    const previous = operation.status;
    operation.status = transitionOperationStatus(previous, nextStatus);
    if (failureCode !== undefined) {
      operation.failureCode = failureCode ?? null;
    }
    return operation;
  }

  transitionAttempt(
    workflowAttemptId: string,
    nextStatus: WorkflowAttemptStatus,
    failureCode?: string | null
  ): WorkflowAttempt {
    for (const attempts of this.attemptsByOperation.values()) {
      const attempt = attempts.get(workflowAttemptId);
      if (attempt) {
        const previous = attempt.status;
        attempt.status = transitionAttemptStatus(previous, nextStatus);
        if (failureCode !== undefined) {
          attempt.failureCode = failureCode ?? null;
        }
        return attempt;
      }
    }
    throw new WorkflowOperationError(
      "ATTEMPT_NOT_FOUND",
      `Cannot transition unknown attempt ${workflowAttemptId}.`
    );
  }

  validateCorrelation(candidate: Partial<WorkflowCorrelationContext>): CorrelationValidationResult {
    const operation = candidate.workflowOperationId
      ? this.operations.get(candidate.workflowOperationId)
      : null;
    if (!operation) {
      return { valid: false, failureCodes: ["CORRELATION_OPERATION_NOT_FOUND"] };
    }
    const baseline: WorkflowCorrelationContext = {
      workflowOperationId: operation.workflowOperationId,
      idempotencyKey: operation.idempotencyKey,
      campaignId: operation.campaignId,
      userId: operation.userId,
      businessId: operation.businessId,
      strategyRunId: operation.strategyRunId,
      approvalRequestId: operation.approvalRequestId,
      claimId: operation.claimId,
      contractFingerprint: operation.contractFingerprint,
      operationType: operation.operationType,
      operationSource: operation.operationSource,
      operationReferenceId: operation.operationReferenceId,
    };
    return validateWorkflowCorrelation(baseline, candidate);
  }

  snapshot(): RegistrySnapshot {
    return {
      operations: Array.from(this.operations.values()).map((op) => ({ ...op })),
      attempts: Array.from(this.attemptsByOperation.values())
        .flatMap((map) => Array.from(map.values()))
        .map((a) => ({ ...a })),
    };
  }
}

export type TerminalWorkflowOperationStatus = "completed" | "failed" | "cancelled";

export interface FinalizeWorkflowOperationInput {
  registry: InMemoryWorkflowOperationRegistry;
  workflowOperationId: string;
  terminalState: TerminalWorkflowOperationStatus;
  reasonCode?: string | null;
}

/**
 * Explicit orchestration-boundary finalization for a workflow operation.
 *
 * This is the only approved way to move an operation from `running` to a
 * terminal state.  It must not be called by passive quality observers.
 */
export function finalizeWorkflowOperation(
  input: FinalizeWorkflowOperationInput
): WorkflowOperation {
  const operation = input.registry.findOperation(input.workflowOperationId);
  if (!operation) {
    throw new WorkflowOperationError(
      "OPERATION_NOT_FOUND",
      `Cannot finalize unknown operation ${input.workflowOperationId}.`
    );
  }
  return input.registry.transitionOperation(
    input.workflowOperationId,
    input.terminalState,
    input.reasonCode ?? null
  );
}
