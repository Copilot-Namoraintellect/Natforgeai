// ─── R9-D Execution Coordination — service ───
//
// Server-side orchestration of the execution coordination authority.
// Authority rules:
// - clients name schedules/tasks/decisions and bounded action material only;
//   identity, dispatch state, results, adapters, capabilities, idempotency
//   and authorization material are server-derived (z.strictObject boundary);
// - every upstream authority (R9-A mission, R9-B plan/task, R9-C schedule,
//   R9-F governance) is re-validated before ANY dispatch intent exists and
//   re-validated again immediately before the side-effect boundary; failure
//   at any seam ⇒ NO DISPATCH;
// - dispatch intents are insert-first, deterministic and exactly-once;
//   attempts are immutable, conservatively classified, append-only audited;
// - retries bind fresh, exact R9-F authority and can never broaden the
//   original action scope; retry/recovery candidates are emitted read-only;
// - this service never writes upstream tables, never touches legacy
//   execution surfaces, never invokes live providers (sandbox adapters only,
//   LIVE_EXECUTION=False).

import { and, eq, isNull, or } from "drizzle-orm";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import { executionAttempts } from "@db/schema";
import {
  EXECUTABLE_MISSION_STATUSES,
  EXECUTABLE_PLAN_STATUSES,
  EXECUTABLE_SCHEDULE_STATUSES,
  EXECUTABLE_TASK_STATUSES,
  ExecutionCoordinationError,
  ExecutionIdentityConflictError,
  ExecutionInputError,
  ExecutionOwnershipError,
  ExecutionStateConflictError,
  ExecutionUpstreamError,
  cancelExecutionActionSchema,
  findForbiddenField,
  findSecretKey,
  isIsoUtc,
  prepareExecutionActionSchema,
  dispatchExecutionActionSchema,
  recordExecutionResultSchema,
  type ExecutionDuplicateClassification,
  type PrepareExecutionActionInput,
  type DispatchExecutionActionInput,
  type RecordExecutionResultInput,
} from "./execution-coordination-contract";
import {
  deriveActionParametersHash,
  deriveAttemptId,
  deriveAuthorizationFingerprint,
  deriveCanonicalActionParams,
  deriveDispatchFingerprint,
  deriveExecutionActionId,
  deriveExternalReference,
  deriveIdempotencyKey,
  deriveLifecycleEventId,
  deriveResultHash,
} from "./execution-coordination-identity";
import type { ExecutionUpstreamAuthority } from "./execution-upstream-seams";
import {
  assertMissionActionConsumable,
  deriveGovernanceActionParamsFingerprint,
  type MissionGovernanceConsumptionAuthority,
} from "./execution-governance-seam";
import {
  resolveAdapterForCapabilities,
  type ExecutionAdapterRegistry,
} from "./execution-adapter-registry";
import {
  classifyAdapterOutcome,
  type ClassifiedExecutionResult,
} from "./execution-result-classification";
import {
  findSucceededExecutionAttemptForTask,
  getExecutionActionById,
  getExecutionAttemptById,
  getLatestExecutionAttemptForAction,
  insertExecutionAction,
  insertExecutionAttempt,
  insertExecutionLifecycleEvent,
  listExecutionActionsByMission,
  listExecutionAttemptsForAction,
  resolveExecutionDb,
  transitionDispatchState,
  type ExecutionStoreExecutor,
} from "./execution-coordination-store";
import {
  buildRecoveryProjection,
  type ExecutionRecoveryProjection,
} from "./execution-recovery-projection";
import type { ExecutionActionRow, ExecutionAttemptRow } from "@db/schema";

export interface ExecutionCoordinationServiceDeps {
  readonly upstream: ExecutionUpstreamAuthority;
  readonly governance: MissionGovernanceConsumptionAuthority;
  readonly adapters: ExecutionAdapterRegistry;
  /** Injected clock (ISO 8601 UTC) — deterministic acceptance. */
  readonly now?: () => string;
}

export interface ExecutionAuthContext {
  readonly userId: number;
}

function defaultNow(): string {
  return new Date().toISOString();
}

function clock(deps: ExecutionCoordinationServiceDeps): string {
  const value = (deps.now ?? defaultNow)();
  if (!isIsoUtc(value)) {
    throw new ExecutionInputError("EXECUTION_INPUT_MALFORMED", `service clock must return ISO 8601 UTC, got ${String(value)}`);
  }
  return value;
}

// ─── Audit (deterministic per durable effect; convergence emits zero) ───

async function emitExecutionAudit(
  db: ExecutionStoreExecutor | undefined,
  input: Parameters<typeof createAuditEvent>[0]
): Promise<void> {
  try {
    const event = createAuditEvent(input);
    await persistAuditEvent(event, db as never);
  } catch (err) {
    console.error(
      `[ExecutionCoordination] Failed to persist ${input.eventType} audit event:`,
      (err as Error)?.message
    );
  }
}

async function emitLifecycleFact(
  db: ExecutionStoreExecutor | undefined,
  deps: ExecutionCoordinationServiceDeps,
  ctx: ExecutionAuthContext,
  input: {
    executionActionId: string;
    attemptId: string | null;
    lifecycleType: string;
    fromState: string | null;
    toState: string;
    reasonCode: string | null;
  }
): Promise<void> {
  const occurredAt = clock(deps);
  const lifecycleEventId = deriveLifecycleEventId({ ...input, occurredAt });
  await insertExecutionLifecycleEvent(
    {
      lifecycleEventId,
      userId: ctx.userId,
      executionActionId: input.executionActionId,
      attemptId: input.attemptId,
      lifecycleType: input.lifecycleType,
      fromState: input.fromState,
      toState: input.toState,
      reasonCode: input.reasonCode,
      occurredAt,
    },
    db
  );
}

// ─── D3 — upstream consumption gate ───

interface UpstreamGateResult {
  readonly mission: { readonly missionId: string; readonly businessId: number };
  readonly planId: string;
  readonly scheduleId: string;
  readonly task: {
    readonly taskId: string;
    readonly taskType: string;
    readonly requiredCapabilities: readonly string[];
  };
  readonly adapterType: string;
  readonly capability: string;
}

async function runUpstreamGate(
  db: ExecutionStoreExecutor | undefined,
  deps: ExecutionCoordinationServiceDeps,
  ctx: ExecutionAuthContext,
  input: { scheduleId: string; taskId: string },
  nowIso: string
): Promise<UpstreamGateResult> {
  const userId = ctx.userId;

  // R9-C schedule (resolve + cross-tenant classification).
  const scheduleGlobal = await deps.upstream.resolveScheduleGlobal(input.scheduleId);
  if (!scheduleGlobal) {
    throw new ExecutionInputError("UNKNOWN_SCHEDULE", `schedule ${input.scheduleId} is unknown.`);
  }
  if (scheduleGlobal.userId !== userId) {
    throw new ExecutionOwnershipError("CROSS_TENANT_SCHEDULE", "the referenced schedule belongs to a different tenant.");
  }
  const schedule = await deps.upstream.resolveSchedule(userId, input.scheduleId);
  if (!schedule) {
    throw new ExecutionInputError("UNKNOWN_SCHEDULE", `schedule ${input.scheduleId} is unknown.`);
  }

  // R9-A mission currency (via the schedule's bound mission).
  const missionGlobal = await deps.upstream.resolveMissionGlobal(schedule.missionId);
  if (!missionGlobal) {
    throw new ExecutionUpstreamError("MISSION_NOT_CURRENT", `mission ${schedule.missionId} is unknown to scheduling evidence.`);
  }
  if (missionGlobal.userId !== userId || missionGlobal.businessId !== schedule.businessId) {
    throw new ExecutionOwnershipError("MISSION_NOT_CURRENT", "mission ownership does not match the scheduling evidence.");
  }
  const mission = await deps.upstream.resolveMission(userId, schedule.missionId);
  if (!mission) {
    throw new ExecutionUpstreamError("MISSION_NOT_CURRENT", `mission ${schedule.missionId} is unknown.`);
  }
  if (!EXECUTABLE_MISSION_STATUSES.includes(mission.status as never)) {
    throw new ExecutionUpstreamError(
      "MISSION_NOT_CURRENT",
      `mission status ${mission.status} is not current (${EXECUTABLE_MISSION_STATUSES.join("/")} only). No dispatch.`
    );
  }
  if (Date.parse(nowIso) < Date.parse(mission.validFrom) || Date.parse(nowIso) >= Date.parse(mission.validUntil)) {
    throw new ExecutionUpstreamError("MISSION_EXPIRED", "mission validity window does not cover now. No dispatch.");
  }

  // R9-B plan currency (via the schedule's bound plan).
  const planGlobal = await deps.upstream.resolvePlanGlobal(schedule.planId);
  if (!planGlobal) {
    throw new ExecutionUpstreamError("PLAN_NOT_CURRENT", `plan ${schedule.planId} is unknown.`);
  }
  if (planGlobal.userId !== userId || planGlobal.businessId !== schedule.businessId) {
    throw new ExecutionOwnershipError("PLAN_NOT_CURRENT", "plan ownership does not match the scheduling evidence.");
  }
  const plan = await deps.upstream.resolvePlan(userId, schedule.planId);
  if (!plan || plan.missionId !== schedule.missionId) {
    throw new ExecutionUpstreamError("PLAN_NOT_CURRENT", `plan ${schedule.planId} does not belong to mission ${schedule.missionId}.`);
  }
  if (!EXECUTABLE_PLAN_STATUSES.includes(plan.status as never)) {
    throw new ExecutionUpstreamError(
      "PLAN_NOT_CURRENT",
      `plan status ${plan.status} is not executable-authority current. No dispatch.`
    );
  }
  if (Date.parse(nowIso) < Date.parse(plan.validFrom) || Date.parse(nowIso) >= Date.parse(plan.validUntil)) {
    throw new ExecutionUpstreamError("PLAN_NOT_CURRENT", "plan validity window does not cover now. No dispatch.");
  }

  // R9-B task authority (belongs to exact mission + plan).
  const taskGlobal = await deps.upstream.resolveTaskGlobal(input.taskId);
  if (!taskGlobal) {
    throw new ExecutionUpstreamError("TASK_NOT_IN_PLAN", `task ${input.taskId} is unknown.`);
  }
  if (taskGlobal.userId !== userId || taskGlobal.businessId !== schedule.businessId) {
    throw new ExecutionOwnershipError("TASK_NOT_IN_PLAN", "task ownership does not match the scheduling evidence.");
  }
  const task = await deps.upstream.resolveTask(userId, input.taskId);
  if (!task || task.missionId !== schedule.missionId || task.planId !== schedule.planId) {
    throw new ExecutionUpstreamError(
      "TASK_NOT_IN_PLAN",
      `task ${input.taskId} does not belong to mission ${schedule.missionId} / plan ${schedule.planId}.`
    );
  }
  if (!EXECUTABLE_TASK_STATUSES.includes(task.status as never)) {
    throw new ExecutionUpstreamError(
      "TASK_NOT_IN_PLAN",
      `task status ${task.status} is not executable-authority current. No dispatch.`
    );
  }

  // R9-C schedule executability.
  if (!EXECUTABLE_SCHEDULE_STATUSES.includes(schedule.status as never)) {
    const code = ["SUPERSEDED", "STALE", "INVALIDATED", "CANCELLED"].includes(schedule.status)
      ? "SCHEDULE_STALE"
      : "SCHEDULE_NOT_EXECUTABLE";
    throw new ExecutionUpstreamError(
      code,
      `schedule status ${schedule.status} is not executable (READY only). No dispatch.`
    );
  }
  if (Date.parse(nowIso) < Date.parse(schedule.validFrom) || Date.parse(nowIso) >= Date.parse(schedule.validUntil)) {
    throw new ExecutionUpstreamError("SCHEDULE_STALE", "schedule validity window does not cover now. No dispatch.");
  }
  if (!schedule.orderedTaskIds.includes(input.taskId)) {
    throw new ExecutionUpstreamError("TASK_NOT_SCHEDULED", `task ${input.taskId} is not in the schedule's ordered task set.`);
  }
  const blocked = schedule.blockingStates.find((b) => b.taskId === input.taskId);
  if (blocked) {
    throw new ExecutionUpstreamError(
      "TASK_BLOCKED",
      `task ${input.taskId} is blocked (${blocked.readiness}: ${blocked.reasons.join(", ")}).`
    );
  }
  // Task-level TIME_WINDOW constraints (R9-B task row, verbatim plan
  // material) must admit `now`. The frozen mission_schedules table carries
  // no constraints column — scheduling projects them from the plan document.
  for (const constraint of task.constraints) {
    const c = (constraint ?? {}) as Record<string, unknown>;
    if (c["constraintType"] !== "TIME_WINDOW") continue;
    const notBefore = typeof c["notBefore"] === "string" ? c["notBefore"] : null;
    const notAfter = typeof c["notAfter"] === "string" ? c["notAfter"] : null;
    if (notBefore && isIsoUtc(notBefore) && Date.parse(nowIso) < Date.parse(notBefore)) {
      throw new ExecutionUpstreamError("TASK_CONSTRAINT_WINDOW_CLOSED", `task time window opens at ${notBefore}.`);
    }
    if (notAfter && isIsoUtc(notAfter) && Date.parse(nowIso) >= Date.parse(notAfter)) {
      throw new ExecutionUpstreamError("TASK_CONSTRAINT_WINDOW_CLOSED", `task time window closed at ${notAfter}.`);
    }
  }
  for (const edge of schedule.dependencyRefs) {
    if (edge.successorTaskId !== input.taskId || edge.hardOrSoft !== "HARD") continue;
    if (edge.dependencyType !== "REQUIRES_COMPLETION" && edge.dependencyType !== "REQUIRES_SUCCESS") continue;
    const predecessor = await findSucceededExecutionAttemptForTask(
      userId,
      schedule.missionId,
      edge.predecessorTaskId,
      db
    );
    if (!predecessor) {
      throw new ExecutionUpstreamError(
        "DEPENDENCY_NOT_SATISFIED",
        `hard dependency ${edge.predecessorTaskId} → ${input.taskId} (${edge.dependencyType}) has no succeeded execution attempt.`
      );
    }
  }

  // D5 — server-controlled adapter/capability resolution.
  const planEnvironment = await deps.upstream.resolvePlanEnvironment(userId, schedule.planId, schedule.planFingerprint);
  if (!planEnvironment) {
    throw new ExecutionUpstreamError("CAPABILITY_INVALID", "plan environment evidence is unavailable; adapter cannot be resolved.");
  }
  const resolved = resolveAdapterForCapabilities({
    requiredCapabilities: task.requiredCapabilities,
    supportedCapabilities: planEnvironment.supportedCapabilities,
  });

  return {
    mission: { missionId: mission.missionId, businessId: mission.businessId },
    planId: plan.planId,
    scheduleId: schedule.scheduleId,
    task: { taskId: task.taskId, taskType: task.taskType, requiredCapabilities: task.requiredCapabilities },
    adapterType: resolved.adapterType,
    capability: resolved.capability,
  };
}

// ─── R9-F consumption (prepare + dispatch revalidation) ───

function subjectClassForActionType(actionType: string): string {
  return actionType === "RETRY_STEP" ? "RETRY" : "EXECUTION_STEP";
}

async function runGovernanceGate(input: {
  deps: ExecutionCoordinationServiceDeps;
  ctx: ExecutionAuthContext;
  governanceDecisionId: string;
  expectedAction: {
    subjectClass: string;
    actionType: string;
    missionRef: string;
    planRef: string | null;
    taskRef: string | null;
  };
  actionParams?: unknown;
  actionParamsFingerprint?: string;
  businessId: number;
  nowIso: string;
}): Promise<ReturnType<typeof assertMissionActionConsumable> & { readonly _unused?: never }> {
  const { deps, ctx } = input;
  const global = await deps.governance.resolveDecisionGlobal(input.governanceDecisionId);
  if (!global) {
    throw new ExecutionInputError(
      "GOVERNANCE_DECISION_NOT_FOUND",
      `governance decision ${input.governanceDecisionId} is unknown.`
    );
  }
  if (global.userId !== ctx.userId || global.businessId !== input.businessId) {
    throw new ExecutionOwnershipError(
      "GOVERNANCE_DECISION_NOT_FOUND",
      "governance decision does not belong to this tenant/business scope."
    );
  }
  const decision = await deps.governance.resolveDecision(ctx.userId, input.governanceDecisionId);
  if (!decision) {
    throw new ExecutionInputError(
      "GOVERNANCE_DECISION_NOT_FOUND",
      `governance decision ${input.governanceDecisionId} is unknown.`
    );
  }
  const approval = await deps.governance.resolveApprovalForDecision(ctx.userId, input.governanceDecisionId);
  const currentPolicyVersion = await deps.governance.currentPolicyVersion();
  const verdict = assertMissionActionConsumable({
    decision,
    approval,
    expectedAction: input.expectedAction,
    expectedActionParams:
      input.actionParamsFingerprint !== undefined
        ? { actionParamsFingerprint: input.actionParamsFingerprint }
        : { actionParams: input.actionParams },
    currentPolicyVersion,
    now: input.nowIso,
  });
  if (!verdict.consumable) {
    const err = new ExecutionUpstreamError(
      "GOVERNANCE_NOT_CONSUMABLE",
      `R9-F consumption gate denied dispatch (${verdict.reason}${verdict.permanent ? ", permanent" : ""}). No dispatch.`
    );
    (err as { governanceReason?: string }).governanceReason = verdict.reason;
    (err as { governancePermanent?: boolean }).governancePermanent = verdict.permanent;
    throw err;
  }
  return verdict;
}

// ─── Parameter validation (client-authority + secret hygiene) ───

function validateActionMaterial(parameters: unknown): void {
  // Secret hygiene first: secret-shaped keys are the sharper violation.
  const secretKey = findSecretKey(parameters);
  if (secretKey) {
    throw new ExecutionInputError(
      "SECRET_MATERIAL_REJECTED",
      `action material carries secret-shaped key "${secretKey}"; secrets never enter execution payloads.`
    );
  }
  if (parameters && typeof parameters === "object" && !Array.isArray(parameters)) {
    const forbidden = findForbiddenField(parameters as Record<string, unknown>);
    if (forbidden) {
      throw new ExecutionInputError(
        "EXECUTION_CLIENT_AUTHORITY_FIELD_FORBIDDEN",
        `action material carries server-authority field "${forbidden}".`
      );
    }
  }
}

// ─── D4 — prepare (dispatch intent creation) ───

export interface PrepareExecutionActionResult {
  readonly executionAction: Record<string, unknown>;
  readonly duplicateClassification: ExecutionDuplicateClassification;
}

export async function prepareExecutionAction(
  db: ExecutionStoreExecutor | undefined,
  deps: ExecutionCoordinationServiceDeps,
  ctx: ExecutionAuthContext,
  rawInput: unknown
): Promise<PrepareExecutionActionResult> {
  const parsed = prepareExecutionActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ExecutionInputError(
      "EXECUTION_INPUT_MALFORMED",
      `prepare input malformed: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }
  const input: PrepareExecutionActionInput = parsed.data as PrepareExecutionActionInput;
  validateActionMaterial(input.parameters);
  const nowIso = clock(deps);

  // D3 — every upstream authority validated before any intent exists.
  const gate = await runUpstreamGate(db, deps, ctx, input, nowIso);

  // D8 — retry scope binding (fresh authority, exact original scope).
  let retryOfAction: ExecutionActionRow | null = null;
  if (input.actionType === "RETRY_STEP") {
    if (!input.retryOf) {
      throw new ExecutionInputError("EXECUTION_INPUT_MALFORMED", "RETRY_STEP requires retryOf (the failed/uncertain action).");
    }
    retryOfAction = await getExecutionActionById(ctx.userId, input.retryOf, db);
    if (!retryOfAction) {
      throw new ExecutionInputError("EXECUTION_ACTION_NOT_FOUND", `retry target ${input.retryOf} is unknown.`);
    }
    const latest = await getLatestExecutionAttemptForAction(ctx.userId, retryOfAction.executionActionId, db);
    const retryable =
      retryOfAction.dispatchState === "FAILED" ||
      retryOfAction.dispatchState === "UNCERTAIN" ||
      (latest !== null && (latest.resultStatus === "FAILED_RETRYABLE" || latest.resultStatus === "UNCERTAIN" || latest.resultStatus === "FAILED_FINAL"));
    if (!retryable) {
      throw new ExecutionStateConflictError(
        "INVALID_DISPATCH_STATE",
        `retry target ${input.retryOf} is in state ${retryOfAction.dispatchState}; only failed/uncertain actions admit a retry candidate.`
      );
    }
  } else if (input.retryOf) {
    throw new ExecutionInputError("EXECUTION_INPUT_MALFORMED", "retryOf is admissible for RETRY_STEP only.");
  }

  // Canonical action parameters + governance fingerprint (D2).
  const canonicalParams = deriveCanonicalActionParams({
    scheduleId: gate.scheduleId,
    taskId: gate.task.taskId,
    taskType: gate.task.taskType,
    actionType: input.actionType,
    adapterType: gate.adapterType,
    capability: gate.capability,
    parameters: input.parameters,
  });
  const actionParametersHash = deriveActionParametersHash(canonicalParams);

  // D8 — a governed retry may never broaden the original authorization. The
  // bounded scope (mission/plan/schedule/task/adapter/capability/parameters)
  // must equal the original action's; the actionType legitimately differs
  // (RETRY_STEP) so the original hash is recomputed under the original type.
  if (retryOfAction) {
    const originalCanonical = deriveCanonicalActionParams({
      scheduleId: retryOfAction.scheduleId,
      taskId: retryOfAction.taskId,
      taskType: retryOfAction.taskType,
      actionType: retryOfAction.actionType,
      adapterType: retryOfAction.adapterType,
      capability: retryOfAction.capability,
      parameters: input.parameters,
    });
    if (
      retryOfAction.missionId !== gate.mission.missionId ||
      retryOfAction.planId !== gate.planId ||
      retryOfAction.scheduleId !== gate.scheduleId ||
      retryOfAction.taskId !== gate.task.taskId ||
      retryOfAction.adapterType !== gate.adapterType ||
      retryOfAction.capability !== gate.capability ||
      retryOfAction.actionParametersHash !== deriveActionParametersHash(originalCanonical)
    ) {
      throw new ExecutionIdentityConflictError(
        "RETRY_SCOPE_BROADENED",
        "retry binds different scope/parameters than the original authorized action."
      );
    }
  }

  // R9-F — exact action consumable now (exactness, policy, expiry, approval).
  const verdict = await runGovernanceGate({
    deps,
    ctx,
    governanceDecisionId: input.governanceDecisionId,
    expectedAction: {
      subjectClass: subjectClassForActionType(input.actionType),
      actionType: input.actionType,
      missionRef: gate.mission.missionId,
      planRef: gate.planId,
      taskRef: gate.task.taskId,
    },
    actionParams: canonicalParams,
    businessId: gate.mission.businessId,
    nowIso,
  });
  if (!verdict.consumable) {
    throw new ExecutionCoordinationError("GOVERNANCE_NOT_CONSUMABLE", "unreachable: gate denial throws.");
  }

  // Deterministic identity + insert-first dispatch intent (D2/D4).
  const authorization = verdict.authorization;
  const authorizationFingerprint = deriveAuthorizationFingerprint({
    governanceDecisionId: authorization.governanceDecisionId,
    policyVersion: authorization.policyVersion,
    approvalRequestId: authorization.approvalRequestId,
    missionRiskClass: authorization.missionRiskClass,
    expiresAt: authorization.expiresAt,
  });
  const executionActionId = deriveExecutionActionId({
    tenantUserId: ctx.userId,
    businessId: gate.mission.businessId,
    missionId: gate.mission.missionId,
    planId: gate.planId,
    scheduleId: gate.scheduleId,
    taskId: gate.task.taskId,
    actionType: input.actionType,
    actionParametersHash,
    authorizationFingerprint,
    adapterType: gate.adapterType,
  });
  const idempotencyKey = deriveIdempotencyKey(ctx.userId, executionActionId);
  const dispatchFingerprint = deriveDispatchFingerprint({
    executionActionId,
    adapterType: gate.adapterType,
    capability: gate.capability,
    attemptNumber: 1,
    actionParametersHash,
    idempotencyKey,
  });
  const validUntil =
    authorization.expiresAt && isIsoUtc(authorization.expiresAt) && Date.parse(authorization.expiresAt) < Date.parse(nowIso) + 30 * 24 * 3600 * 1000
      ? authorization.expiresAt
      : new Date(Date.parse(nowIso) + 24 * 3600 * 1000).toISOString();

  const insertResult = await insertExecutionAction(
    {
      executionActionId,
      userId: ctx.userId,
      businessId: gate.mission.businessId,
      missionId: gate.mission.missionId,
      planId: gate.planId,
      scheduleId: gate.scheduleId,
      taskId: gate.task.taskId,
      taskType: gate.task.taskType,
      actionType: input.actionType,
      actionParametersHash,
      inputRefs: input.inputRefs ?? [],
      governanceDecisionId: authorization.governanceDecisionId,
      approvalReference: authorization.approvalRequestId,
      authorizationFingerprint,
      idempotencyKey,
      adapterType: gate.adapterType,
      capability: gate.capability,
      validFrom: nowIso,
      validUntil,
      dispatchState: "DISPATCH_PREPARED",
      dispatchFingerprint,
      attemptCount: 0,
      version: 1,
    },
    db
  );

  if (insertResult.duplicateClassification === "none") {
    await emitExecutionAudit(db, {
      eventType: "execution_action_prepared",
      occurredAt: nowIso,
      userId: ctx.userId,
      source: "system",
      outcome: "succeeded",
      businessId: gate.mission.businessId,
      metadata: {
        executionActionId,
        missionId: gate.mission.missionId,
        planId: gate.planId,
        scheduleId: gate.scheduleId,
        taskId: gate.task.taskId,
        actionType: input.actionType,
        adapterType: gate.adapterType,
        capability: gate.capability,
        governanceDecisionId: authorization.governanceDecisionId,
        approvalReference: authorization.approvalRequestId,
        retryOf: retryOfAction?.executionActionId ?? null,
      },
    });
  }

  return {
    executionAction: envelopeView(insertResult.row),
    duplicateClassification: insertResult.duplicateClassification,
  };
}

function envelopeView(row: ExecutionActionRow): Record<string, unknown> {
  return {
    executionActionId: row.executionActionId,
    tenantId: row.userId,
    businessId: row.businessId,
    missionId: row.missionId,
    planId: row.planId,
    scheduleId: row.scheduleId,
    taskId: row.taskId,
    taskType: row.taskType,
    actionType: row.actionType,
    actionParametersHash: row.actionParametersHash,
    inputRefs: row.inputRefs,
    governanceDecisionId: row.governanceDecisionId,
    approvalReference: row.approvalReference,
    authorizationFingerprint: row.authorizationFingerprint,
    idempotencyKey: row.idempotencyKey,
    adapterType: row.adapterType,
    capability: row.capability,
    validFrom: row.validFrom,
    validUntil: row.validUntil,
    dispatchState: row.dispatchState,
    dispatchFingerprint: row.dispatchFingerprint,
    attemptCount: row.attemptCount,
    version: row.version,
  };
}

// ─── Dispatch (side-effect boundary under fresh revalidation) ───

export interface DispatchExecutionActionResult {
  readonly executionAction: Record<string, unknown>;
  readonly attempt: Record<string, unknown>;
  readonly classification: ClassifiedExecutionResult;
}

export async function dispatchExecutionAction(
  db: ExecutionStoreExecutor | undefined,
  deps: ExecutionCoordinationServiceDeps,
  ctx: ExecutionAuthContext,
  rawInput: unknown
): Promise<DispatchExecutionActionResult> {
  const parsed = dispatchExecutionActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ExecutionInputError(
      "EXECUTION_INPUT_MALFORMED",
      `dispatch input malformed: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }
  const input: DispatchExecutionActionInput = parsed.data as DispatchExecutionActionInput;
  validateActionMaterial(input.parameters);
  const nowIso = clock(deps);

  const action = await getExecutionActionById(ctx.userId, input.executionActionId, db);
  if (!action) {
    throw new ExecutionInputError("EXECUTION_ACTION_NOT_FOUND", `execution action ${input.executionActionId} is unknown.`);
  }

  // Fresh D3 revalidation immediately before the material effect.
  await runUpstreamGate(db, deps, ctx, { scheduleId: action.scheduleId, taskId: action.taskId }, nowIso);

  // Parameter drift check: re-dispatched material must equal the approved hash.
  const canonicalParams = deriveCanonicalActionParams({
    scheduleId: action.scheduleId,
    taskId: action.taskId,
    taskType: action.taskType,
    actionType: action.actionType,
    adapterType: action.adapterType,
    capability: action.capability,
    parameters: input.parameters,
  });
  const recomputedHash = deriveActionParametersHash(canonicalParams);
  if (recomputedHash !== action.actionParametersHash) {
    throw new ExecutionIdentityConflictError(
      "EXECUTION_REPLAY_CONFLICT",
      "dispatched action material does not match the authorized actionParametersHash."
    );
  }

  // Fresh R9-F consumption revalidation (fingerprint path — raw params never persist).
  const verdict = await runGovernanceGate({
    deps,
    ctx,
    governanceDecisionId: action.governanceDecisionId,
    expectedAction: {
      subjectClass: subjectClassForActionType(action.actionType),
      actionType: action.actionType,
      missionRef: action.missionId,
      planRef: action.planId,
      taskRef: action.taskId,
    },
    actionParamsFingerprint: action.actionParametersHash,
    businessId: action.businessId,
    nowIso,
  });
  if (!verdict.consumable) {
    throw new ExecutionCoordinationError("GOVERNANCE_NOT_CONSUMABLE", "unreachable: gate denial throws.");
  }

  // Consumption validity window.
  if (Date.parse(nowIso) >= Date.parse(action.validUntil)) {
    throw new ExecutionStateConflictError("DISPATCH_WINDOW_EXPIRED", "execution action consumption window has closed.");
  }

  // CAS into DISPATCHED — duplicate dispatchers converge/fail closed.
  const dispatched = await transitionDispatchState({
    userId: ctx.userId,
    executionActionId: action.executionActionId,
    expectedVersion: action.version,
    fromStates: ["DISPATCH_PREPARED"],
    toState: "DISPATCHED",
    attemptCount: action.attemptCount + 1,
    executor: db,
  });
  await emitLifecycleFact(db, deps, ctx, {
    executionActionId: action.executionActionId,
    attemptId: null,
    lifecycleType: "dispatch_state_changed",
    fromState: "DISPATCH_PREPARED",
    toState: "DISPATCHED",
    reasonCode: null,
  });

  // Mint the immutable attempt.
  const attemptNumber = dispatched.attemptCount;
  const attemptDispatchFingerprint = deriveDispatchFingerprint({
    executionActionId: action.executionActionId,
    adapterType: action.adapterType,
    capability: action.capability,
    attemptNumber,
    actionParametersHash: action.actionParametersHash,
    idempotencyKey: action.idempotencyKey,
  });
  const attemptId = deriveAttemptId({
    executionActionId: action.executionActionId,
    attemptNumber,
    dispatchFingerprint: attemptDispatchFingerprint,
  });
  const externalReference = deriveExternalReference(attemptId);
  const attemptResult = await insertExecutionAttempt(
    {
      attemptId,
      userId: ctx.userId,
      businessId: action.businessId,
      executionActionId: action.executionActionId,
      attemptNumber,
      dispatchFingerprint: attemptDispatchFingerprint,
      adapterType: action.adapterType,
      capability: action.capability,
      externalReference: null,
      resultStatus: null,
      resultHash: null,
      failureClass: "NONE",
      uncertaintyClass: "NONE",
      startedAt: nowIso,
      completedAt: null,
    },
    db
  );
  if (attemptResult.duplicateClassification === "none") {
    await emitExecutionAudit(db, {
      eventType: "execution_attempt_recorded",
      occurredAt: nowIso,
      userId: ctx.userId,
      source: "system",
      outcome: "succeeded",
      businessId: action.businessId,
      metadata: {
        attemptId,
        executionActionId: action.executionActionId,
        attemptNumber,
        adapterType: action.adapterType,
        capability: action.capability,
        dispatchState: "DISPATCHED",
      },
    });
  }

  // Adapter dispatch — server-selected adapter, secret-scrubbed payload.
  const adapter = deps.adapters.resolve(action.adapterType as never);
  if (!adapter) {
    throw new ExecutionUpstreamError("ADAPTER_UNAVAILABLE", `no adapter bound for class ${action.adapterType}.`);
  }
  const rawOutcome = await adapter.dispatch({
    payload: {
      capability: action.capability,
      taskId: action.taskId,
      missionId: action.missionId,
      actionType: action.actionType,
      parameters: input.parameters,
    },
    externalReference,
    dispatchFingerprint: attemptDispatchFingerprint,
  });

  const classification = classifyAdapterOutcome(rawOutcome, externalReference);
  const completedAt = classification.resultStatus === "PENDING_EXTERNAL" ? null : nowIso;
  const resultHash = deriveResultHash({
    attemptId,
    resultStatus: classification.resultStatus,
    failureClass: classification.failureClass,
    uncertaintyClass: classification.uncertaintyClass,
    externalReference: classification.externalReference,
    classifiedResult: classification.classifiedResult,
  });

  // Record the result once (null → value CAS on the attempt row).
  await recordAttemptResult(db, ctx.userId, attemptId, {
    resultStatus: classification.resultStatus,
    resultHash,
    failureClass: classification.failureClass,
    uncertaintyClass: classification.uncertaintyClass,
    externalReference: classification.externalReference,
    completedAt,
  });

  // Terminal dispatch-state mapping (D7): uncertainty is never success.
  const toState =
    classification.resultStatus === "SUCCEEDED"
      ? "SUCCEEDED"
      : classification.resultStatus === "PENDING_EXTERNAL"
        ? "ACKNOWLEDGED"
        : classification.resultStatus === "UNCERTAIN"
          ? "UNCERTAIN"
          : "FAILED";
  const finalAction = await transitionDispatchState({
    userId: ctx.userId,
    executionActionId: action.executionActionId,
    expectedVersion: dispatched.version,
    fromStates: ["DISPATCHED"],
    toState,
    executor: db,
  });
  await emitLifecycleFact(db, deps, ctx, {
    executionActionId: action.executionActionId,
    attemptId,
    lifecycleType: "result_recorded",
    fromState: "DISPATCHED",
    toState,
    reasonCode: classification.resultStatus,
  });

  // D8 — retry/recovery candidate state only; never a self-authorized retry.
  if (
    classification.resultStatus === "FAILED_RETRYABLE" ||
    classification.resultStatus === "UNCERTAIN" ||
    classification.resultStatus === "PENDING_EXTERNAL"
  ) {
    const reasonCode =
      classification.resultStatus === "FAILED_RETRYABLE"
        ? "ATTEMPT_FAILED_RETRYABLE"
        : classification.resultStatus === "UNCERTAIN"
          ? "ATTEMPT_UNCERTAIN"
          : "RESULT_PENDING_EXTERNAL";
    await emitLifecycleFact(db, deps, ctx, {
      executionActionId: action.executionActionId,
      attemptId,
      lifecycleType: "retry_candidate_emitted",
      fromState: toState,
      toState,
      reasonCode,
    });
  }

  return {
    executionAction: envelopeView(finalAction),
    attempt: attemptView(attemptResult.row, {
      resultStatus: classification.resultStatus,
      resultHash,
      failureClass: classification.failureClass,
      uncertaintyClass: classification.uncertaintyClass,
      externalReference: classification.externalReference,
      completedAt,
    }),
    classification,
  };
}

async function recordAttemptResult(
  db: ExecutionStoreExecutor | undefined,
  userId: number,
  attemptId: string,
  result: {
    resultStatus: string;
    resultHash: string;
    failureClass: string;
    uncertaintyClass: string;
    externalReference: string | null;
    completedAt: string | null;
  }
): Promise<void> {
  const existing = await getExecutionAttemptById(userId, attemptId, db);
  if (!existing) {
    throw new ExecutionStateConflictError("ATTEMPT_NOT_FOUND", `attempt ${attemptId} not found.`);
  }
  if (existing.resultStatus !== null && existing.resultStatus !== "PENDING_EXTERNAL") {
    // Duplicate result delivery converges to the recorded terminal result.
    return;
  }
  const dbx = resolveExecutionDb(db);
  await dbx
    .update(executionAttempts)
    .set({
      resultStatus: result.resultStatus,
      resultHash: result.resultHash,
      failureClass: result.failureClass,
      uncertaintyClass: result.uncertaintyClass,
      externalReference: result.externalReference,
      completedAt: result.completedAt,
    } as never)
    .where(
      and(
        eq(executionAttempts.userId, userId),
        eq(executionAttempts.attemptId, attemptId),
        or(isNull(executionAttempts.resultStatus), eq(executionAttempts.resultStatus, "PENDING_EXTERNAL"))
      )
    );
  const updated = await getExecutionAttemptById(userId, attemptId, db);
  if (!updated || updated.resultStatus !== result.resultStatus) {
    throw new ExecutionStateConflictError("INVALID_DISPATCH_STATE", "attempt result lost a race.");
  }
}

function attemptView(
  row: ExecutionAttemptRow,
  result: {
    resultStatus: string;
    resultHash: string;
    failureClass: string;
    uncertaintyClass: string;
    externalReference: string | null;
    completedAt: string | null;
  }
): Record<string, unknown> {
  return {
    attemptId: row.attemptId,
    executionActionId: row.executionActionId,
    attemptNumber: row.attemptNumber,
    dispatchFingerprint: row.dispatchFingerprint,
    adapterType: row.adapterType,
    capability: row.capability,
    resultStatus: result.resultStatus,
    resultHash: result.resultHash,
    failureClass: result.failureClass,
    uncertaintyClass: result.uncertaintyClass,
    externalReference: result.externalReference,
    startedAt: row.startedAt,
    completedAt: result.completedAt,
  };
}

// ─── Callback binding (PENDING_EXTERNAL resolution) ───

export interface RecordExecutionResultOutcome {
  readonly attempt: Record<string, unknown> | null;
  readonly classification: ClassifiedExecutionResult | null;
  readonly pending: boolean;
}

export async function recordExecutionResult(
  db: ExecutionStoreExecutor | undefined,
  deps: ExecutionCoordinationServiceDeps,
  ctx: ExecutionAuthContext,
  rawInput: unknown
): Promise<RecordExecutionResultOutcome> {
  const parsed = recordExecutionResultSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ExecutionInputError(
      "EXECUTION_INPUT_MALFORMED",
      `record result input malformed: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }
  const input: RecordExecutionResultInput = parsed.data as RecordExecutionResultInput;
  const nowIso = clock(deps);

  const attempt = await getExecutionAttemptById(ctx.userId, input.attemptId, db);
  if (!attempt) {
    throw new ExecutionInputError("ATTEMPT_NOT_FOUND", `attempt ${input.attemptId} is unknown.`);
  }
  const action = await getExecutionActionById(ctx.userId, attempt.executionActionId, db);
  if (!action) {
    throw new ExecutionInputError("EXECUTION_ACTION_NOT_FOUND", "attempt's execution action is unknown.");
  }

  // Forged reference rejection: the callback must name the issued reference.
  const issuedReference = deriveExternalReference(attempt.attemptId);
  const storedReference = attempt.externalReference ?? issuedReference;
  if (input.externalReference !== undefined && input.externalReference !== storedReference) {
    throw new ExecutionInputError(
      "EXTERNAL_REFERENCE_MISMATCH",
      "callback reference does not match the attempt's server-issued reference."
    );
  }

  if (attempt.resultStatus !== null && attempt.resultStatus !== "PENDING_EXTERNAL") {
    return { attempt: null, classification: null, pending: false }; // duplicate callback converges
  }

  // Outcomes are sourced server-side from the bound adapter's callback queue.
  const adapter = deps.adapters.resolve(action.adapterType as never);
  if (!adapter) {
    throw new ExecutionUpstreamError("ADAPTER_UNAVAILABLE", `no adapter bound for class ${action.adapterType}.`);
  }
  const raw = await adapter.dispatch({
    payload: { capability: action.capability, callbackPoll: true, attemptId: attempt.attemptId },
    externalReference: storedReference,
    dispatchFingerprint: attempt.dispatchFingerprint,
  });
  const classification = classifyAdapterOutcome(raw, storedReference);
  if (classification.resultStatus === "PENDING_EXTERNAL") {
    return { attempt: null, classification: null, pending: true }; // still awaiting
  }

  const resultHash = deriveResultHash({
    attemptId: attempt.attemptId,
    resultStatus: classification.resultStatus,
    failureClass: classification.failureClass,
    uncertaintyClass: classification.uncertaintyClass,
    externalReference: classification.externalReference,
    classifiedResult: classification.classifiedResult,
  });
  await recordAttemptResult(db, ctx.userId, attempt.attemptId, {
    resultStatus: classification.resultStatus,
    resultHash,
    failureClass: classification.failureClass,
    uncertaintyClass: classification.uncertaintyClass,
    externalReference: classification.externalReference,
    completedAt: nowIso,
  });

  const toState =
    classification.resultStatus === "SUCCEEDED"
      ? "SUCCEEDED"
      : classification.resultStatus === "UNCERTAIN"
        ? "UNCERTAIN"
        : "FAILED";
  const currentAction = await getExecutionActionById(ctx.userId, action.executionActionId, db);
  if (currentAction && currentAction.dispatchState === "ACKNOWLEDGED") {
    await transitionDispatchState({
      userId: ctx.userId,
      executionActionId: action.executionActionId,
      expectedVersion: currentAction.version,
      fromStates: ["ACKNOWLEDGED"],
      toState,
      executor: db,
    });
    await emitLifecycleFact(db, deps, ctx, {
      executionActionId: action.executionActionId,
      attemptId: attempt.attemptId,
      lifecycleType: "result_recorded",
      fromState: "ACKNOWLEDGED",
      toState,
      reasonCode: classification.resultStatus,
    });
  }

  const updated = await getExecutionAttemptById(ctx.userId, attempt.attemptId, db);
  return {
    attempt: updated
      ? attemptView(updated, {
          resultStatus: updated.resultStatus ?? classification.resultStatus,
          resultHash: updated.resultHash ?? resultHash,
          failureClass: updated.failureClass,
          uncertaintyClass: updated.uncertaintyClass,
          externalReference: updated.externalReference,
          completedAt: updated.completedAt,
        })
      : null,
    classification,
    pending: false,
  };
}

// ─── Reads + D11 recovery projection ───

export async function getExecutionAction(
  db: ExecutionStoreExecutor | undefined,
  ctx: ExecutionAuthContext,
  executionActionId: string
): Promise<Record<string, unknown> | null> {
  const row = await getExecutionActionById(ctx.userId, executionActionId, db);
  return row ? envelopeView(row) : null;
}

export async function listExecutionAttempts(
  db: ExecutionStoreExecutor | undefined,
  ctx: ExecutionAuthContext,
  executionActionId: string,
  limit = 50
): Promise<Record<string, unknown>[]> {
  const rows = await listExecutionAttemptsForAction(ctx.userId, executionActionId, limit, db);
  return rows.map((row) => ({
    attemptId: row.attemptId,
    executionActionId: row.executionActionId,
    attemptNumber: row.attemptNumber,
    dispatchFingerprint: row.dispatchFingerprint,
    adapterType: row.adapterType,
    capability: row.capability,
    resultStatus: row.resultStatus,
    resultHash: row.resultHash,
    failureClass: row.failureClass,
    uncertaintyClass: row.uncertaintyClass,
    externalReference: row.externalReference,
    startedAt: row.startedAt,
    completedAt: row.completedAt,
  }));
}

function retryCandidateFor(attempt: ExecutionAttemptRow | null): { required: boolean; reason: string | null } {
  if (!attempt) return { required: false, reason: null };
  switch (attempt.resultStatus) {
    case "FAILED_RETRYABLE":
      return { required: true, reason: "ATTEMPT_FAILED_RETRYABLE" };
    case "UNCERTAIN":
      return { required: true, reason: "ATTEMPT_UNCERTAIN" };
    case "PENDING_EXTERNAL":
      return { required: true, reason: "RESULT_PENDING_EXTERNAL" };
    default:
      return { required: false, reason: null };
  }
}

export async function getRecoveryProjection(
  db: ExecutionStoreExecutor | undefined,
  ctx: ExecutionAuthContext,
  executionActionId: string
): Promise<ExecutionRecoveryProjection | null> {
  const action = await getExecutionActionById(ctx.userId, executionActionId, db);
  if (!action) return null;
  const latest = await getLatestExecutionAttemptForAction(ctx.userId, executionActionId, db);
  return buildRecoveryProjection({
    executionActionId: action.executionActionId,
    attemptId: latest?.attemptId ?? null,
    missionId: action.missionId,
    planId: action.planId,
    scheduleId: action.scheduleId,
    taskId: action.taskId,
    actionType: action.actionType,
    adapterType: action.adapterType,
    attemptNumber: latest?.attemptNumber ?? null,
    dispatchState: action.dispatchState,
    resultStatus: latest?.resultStatus ?? null,
    failureClass: latest?.failureClass ?? "NONE",
    uncertaintyClass: latest?.uncertaintyClass ?? "NONE",
    externalReference: latest?.externalReference ?? null,
    authorizationFingerprint: action.authorizationFingerprint,
    idempotencyKey: action.idempotencyKey,
    startedAt: latest?.startedAt ?? null,
    completedAt: latest?.completedAt ?? null,
    retryCandidate: retryCandidateFor(latest),
  });
}

export async function listRecoveryProjectionsForMission(
  db: ExecutionStoreExecutor | undefined,
  ctx: ExecutionAuthContext,
  missionId: string
): Promise<ExecutionRecoveryProjection[]> {
  const actions = await listExecutionActionsByMission(ctx.userId, missionId, db);
  const out: ExecutionRecoveryProjection[] = [];
  for (const action of actions) {
    const projection = await getRecoveryProjection(db, ctx, action.executionActionId);
    if (projection) out.push(projection);
  }
  return out;
}

// ─── Cancel (pre-dispatch only) ───

export async function cancelExecutionAction(
  db: ExecutionStoreExecutor | undefined,
  deps: ExecutionCoordinationServiceDeps,
  ctx: ExecutionAuthContext,
  rawInput: unknown
): Promise<{ readonly executionAction: Record<string, unknown> }> {
  const parsed = cancelExecutionActionSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new ExecutionInputError(
      "EXECUTION_INPUT_MALFORMED",
      `cancel input malformed: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }
  const input = parsed.data;
  const nowIso = clock(deps);
  const action = await getExecutionActionById(ctx.userId, input.executionActionId, db);
  if (!action) {
    throw new ExecutionInputError("EXECUTION_ACTION_NOT_FOUND", `execution action ${input.executionActionId} is unknown.`);
  }
  const cancelled = await transitionDispatchState({
    userId: ctx.userId,
    executionActionId: action.executionActionId,
    expectedVersion: input.expectedVersion,
    fromStates: ["DISPATCH_PREPARED"],
    toState: "CANCELLED",
    executor: db,
  });
  await emitLifecycleFact(db, deps, ctx, {
    executionActionId: action.executionActionId,
    attemptId: null,
    lifecycleType: "dispatch_state_changed",
    fromState: "DISPATCH_PREPARED",
    toState: "CANCELLED",
    reasonCode: "OPERATOR_CANCELLED",
  });
  await emitExecutionAudit(db, {
    eventType: "execution_attempt_lifecycle",
    occurredAt: nowIso,
    userId: ctx.userId,
    source: "user",
    outcome: "succeeded",
    businessId: action.businessId,
    metadata: {
      executionActionId: action.executionActionId,
      lifecycleType: "dispatch_state_changed",
      fromState: "DISPATCH_PREPARED",
      toState: "CANCELLED",
      reasonCode: "OPERATOR_CANCELLED",
    },
  });
  return { executionAction: envelopeView(cancelled) };
}

export { deriveGovernanceActionParamsFingerprint };
