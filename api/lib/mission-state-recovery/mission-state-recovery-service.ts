// ─── R9-E Mission State, Recovery & Observability — orchestration service ───
//
// Orchestrates observation, derivation and recovery coordination:
// pure input validation → server-side ownership re-verification →
// upstream authority loading (seams, read-only) → deterministic derivation
// (pure) → identity + immutable-core hashes → insert-first persistence →
// recovery candidate proposals (advisory) → frozen R9-F governance binding /
// consumption → append-only timeline → deterministic audit. Every step is
// idempotent (durable unique anchors + replay), so a crash/restart converges
// to one durable record per observation.
//
// This service authorizes nothing and executes nothing: recovery proposals
// are advisory, recovery authorization is R9-F authority consumed read-only
// through the frozen gate, and execution is handed back to R9-D as a
// read-only handoff projection. No upstream (R9-A/B/C/D/F) table is ever
// written. No provider, shell, SQL-from-input, or secret is ever touched.

import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import {
  DISPATCHED_STALE_MS,
  GOVERNANCE_DECISION_NOT_FOUND,
  GOVERNANCE_NOT_CONSUMABLE,
  INVALID_RECOVERY_STATUS,
  MISSION_NOT_CURRENT,
  MISSION_STATE_CONFLICT,
  MISSION_STATE_INPUT_MALFORMED,
  MISSION_STATE_TAMPER,
  OBSERVATION_VALIDITY_MS,
  PENDING_EXTERNAL_STALE_MS,
  RECOVERY_CANDIDATE_NOT_CURRENT,
  RECOVERY_SCOPE_DRIFT,
  RECOVERY_TYPE_GOVERNANCE_ACTION,
  RECOVERY_TYPE_GOVERNANCE_SUBJECT,
  TASK_NOT_IN_MISSION,
  UNKNOWN_MISSION,
  UNKNOWN_RECOVERY_CANDIDATE,
  UNKNOWN_TASK,
  canTransitionRecoveryStatus,
  type MissionDuplicateClassification,
  type MissionRecoveryType,
} from "./mission-state-recovery-contract";
import {
  deriveCanonicalRecoveryParams,
  deriveMissionStateId,
  deriveRecoveryActionParamsFingerprint,
  deriveRecoveryCandidateId,
  deriveRecoveryLifecycleId,
  deriveRecoveryProposalHash,
  deriveStateDerivationHash,
  deriveTaskStateHash,
  deriveTaskStateId,
  deriveTimelineEventId,
  deriveTimelineSubjectHash,
  type RecoveryScope,
} from "./mission-state-recovery-identity";
import {
  deriveMissionHealth,
  deriveTaskOperationalState,
  selectRecoveryType,
  toTaskStateCore,
  type TaskOperationalDerivation,
} from "./mission-state-derivation";
import {
  createInMemoryMissionExecutionAuthority,
  createMissionExecutionAuthority,
  type ExecutionActionView,
  type ExecutionAttemptView,
  type MissionExecutionAuthority,
} from "./mission-execution-seam";
import {
  assertRecoveryActionConsumable,
  createInMemoryRecoveryGovernanceAuthority,
  createRecoveryGovernanceAuthority,
  type RecoveryGovernanceAuthority,
} from "./mission-recovery-governance-seam";
import {
  createInMemoryMissionStateUpstreamAuthority,
  createMissionStateUpstreamAuthority,
  type MissionStateUpstreamAuthority,
  type PlanAuthorityView,
  type ScheduleAuthorityView,
  type TaskAuthorityView,
} from "./mission-state-upstream-seam";
import {
  getLatestMissionStateRecord,
  getMissionRecoveryCandidateById,
  insertMissionRecoveryCandidate,
  insertMissionStateRecord,
  insertMissionTaskState,
  insertMissionTimelineEvent,
  listLatestMissionTaskStates,
  listMissionRecoveryCandidates,
  listMissionTimelineEvents,
  transitionRecoveryStatus,
  type MissionStateStoreExecutor,
} from "./mission-state-recovery-store";
import {
  buildMissionControlProjection,
  type MissionControlProjection,
  type MissionControlRecoveryProjection,
  type MissionControlTaskStateProjection,
} from "./mission-state-projection";
import type {
  MissionRecoveryCandidateRow,
  MissionStateRecordRow,
  MissionTaskStateRow,
} from "@db/schema";
import {
  CROSS_BUSINESS_MISSION,
  CROSS_TENANT_MISSION,
  MissionStateConflictError,
  MissionStateIdentityConflictError,
  MissionStateInputError,
  MissionStateOwnershipError,
  MissionStateTamperError,
} from "./mission-state-recovery-contract";

export interface MissionStateServiceDeps {
  /** Injectable upstream port (production reads R9-A/B/C; tests inject fakes). */
  upstream?: MissionStateUpstreamAuthority;
  /** Injectable execution port (production reads R9-D; tests inject fakes). */
  execution?: MissionExecutionAuthority;
  /** Injectable governance port (production reads R9-F; tests inject fakes). */
  governance?: RecoveryGovernanceAuthority;
  /** Store executor override (fake-DB harness). */
  store?: MissionStateStoreExecutor;
  /** Server clock override (ISO-8601 UTC) — tests only. */
  now?: string;
}

export interface ObserveMissionStateResult {
  readonly missionState: MissionStateRecordRow;
  readonly taskStates: readonly MissionTaskStateRow[];
  readonly recoveryCandidates: readonly MissionRecoveryCandidateRow[];
  readonly duplicateClassification: MissionDuplicateClassification;
  readonly healthClass: string;
}

// ─── World loading (read-only upstream assembly) ───

interface MissionWorld {
  readonly mission: import("./mission-state-upstream-seam").MissionAuthorityView;
  readonly plan: PlanAuthorityView;
  readonly schedule: ScheduleAuthorityView | null;
  readonly tasks: readonly TaskAuthorityView[];
  readonly actions: readonly ExecutionActionView[];
  readonly attemptsByAction: ReadonlyMap<string, readonly ExecutionAttemptView[]>;
}

function depsUpstream(deps: MissionStateServiceDeps): MissionStateUpstreamAuthority {
  return deps.upstream ?? createMissionStateUpstreamAuthority();
}

function depsExecution(deps: MissionStateServiceDeps): MissionExecutionAuthority {
  return deps.execution ?? createMissionExecutionAuthority();
}

function depsGovernance(deps: MissionStateServiceDeps): RecoveryGovernanceAuthority {
  return deps.governance ?? createRecoveryGovernanceAuthority();
}

function nowIso(deps: MissionStateServiceDeps): string {
  if (deps.now) return deps.now;
  return new Date().toISOString();
}

/**
 * Loads and cross-validates the authoritative world for a mission. Every row
 * is tenant-anchored (session userId) and business-consistent; cross-tenant /
 * cross-business references fail closed before any derivation.
 */
async function loadWorld(
  userId: number,
  input: { missionId: string; planId?: string; scheduleId?: string },
  deps: MissionStateServiceDeps
): Promise<MissionWorld> {
  const upstream = depsUpstream(deps);
  const execution = depsExecution(deps);

  const mission = await upstream.resolveMission(userId, input.missionId);
  if (!mission) {
    const scope = await upstream.resolveMissionGlobal(input.missionId);
    if (scope) {
      throw new MissionStateOwnershipError(CROSS_TENANT_MISSION, "mission belongs to a different tenant.");
    }
    throw new MissionStateInputError(UNKNOWN_MISSION, `mission ${input.missionId} not found for this tenant.`);
  }

  let schedule: ScheduleAuthorityView | null = null;
  if (input.scheduleId) {
    schedule = await upstream.resolveSchedule(userId, input.scheduleId);
    if (!schedule) {
      const scope = await upstream.resolveScheduleGlobal(input.scheduleId);
      if (scope) {
        if (scope.userId !== userId) {
          throw new MissionStateOwnershipError(CROSS_TENANT_MISSION, "schedule belongs to a different tenant.");
        }
        throw new MissionStateOwnershipError(CROSS_BUSINESS_MISSION, "schedule belongs to a different business.");
      }
      throw new MissionStateInputError(UNKNOWN_MISSION, `schedule ${input.scheduleId} not found for this tenant.`);
    }
    if (schedule.missionId !== mission.missionId) {
      throw new MissionStateOwnershipError(CROSS_BUSINESS_MISSION, "schedule does not belong to the named mission.");
    }
    if (schedule.businessId !== mission.businessId || schedule.userId !== mission.userId) {
      throw new MissionStateOwnershipError(CROSS_BUSINESS_MISSION, "schedule scope does not match mission scope.");
    }
  }

  const planId = input.planId ?? schedule?.planId ?? "";
  if (!planId) {
    throw new MissionStateInputError(UNKNOWN_MISSION, "a planId or scheduleId reference is required.");
  }
  const plan = await upstream.resolvePlan(userId, planId);
  if (!plan) {
    throw new MissionStateInputError(UNKNOWN_MISSION, `plan ${planId} not found for this tenant.`);
  }
  if (plan.missionId !== mission.missionId) {
    throw new MissionStateOwnershipError(CROSS_BUSINESS_MISSION, "plan does not belong to the named mission.");
  }
  if (plan.businessId !== mission.businessId || plan.userId !== mission.userId) {
    throw new MissionStateOwnershipError(CROSS_BUSINESS_MISSION, "plan scope does not match mission scope.");
  }

  if (schedule && schedule.planFingerprint && plan.planFingerprint && schedule.planFingerprint !== plan.planFingerprint) {
    // Schedule built over a different plan revision — drift, not authority.
    throw new MissionStateConflictError(MISSION_STATE_CONFLICT, "schedule plan fingerprint does not match the current plan.");
  }

  const tasks = await upstream.resolveTasksForPlan(userId, plan.planId);
  for (const task of tasks) {
    if (task.userId !== mission.userId || task.businessId !== mission.businessId || task.missionId !== mission.missionId) {
      throw new MissionStateOwnershipError(CROSS_BUSINESS_MISSION, `task ${task.taskId} scope does not match mission scope.`);
    }
  }

  const actions = await execution.listActionsForMission(userId, mission.missionId);
  const attemptsByAction = new Map<string, readonly ExecutionAttemptView[]>();
  for (const action of actions) {
    if (action.userId !== mission.userId || action.businessId !== mission.businessId) continue;
    attemptsByAction.set(action.executionActionId, await execution.listAttemptsForAction(userId, action.executionActionId));
  }

  return { mission, plan, schedule, tasks, actions, attemptsByAction };
}

// ─── Audit (deterministic per durable effect; convergence emits zero) ───

async function emitAudit(
  deps: MissionStateServiceDeps,
  input: {
    eventType: "mission_state_derived" | "mission_recovery_candidate_proposed" | "mission_recovery_lifecycle";
    userId: number;
    businessId: number;
    occurredAt: string;
    metadata: Record<string, unknown>;
  }
): Promise<void> {
  const event = createAuditEvent({
    eventType: input.eventType,
    occurredAt: input.occurredAt,
    userId: input.userId,
    source: "system",
    outcome: "succeeded",
    businessId: input.businessId,
    metadata: input.metadata,
  });
  await persistAuditEvent(event, deps.store);
}

// ─── Timeline (append-only observability) ───

async function recordTimeline(
  deps: MissionStateServiceDeps,
  input: {
    userId: number;
    businessId: number;
    missionId: string;
    scheduleId: string | null;
    taskId: string | null;
    recoveryCandidateId: string | null;
    eventType: string;
    eventLabel: string;
    fromStatus: string | null;
    toStatus: string | null;
    occurredAt: string;
    subject: Record<string, unknown>;
  }
): Promise<void> {
  const subjectHash = deriveTimelineSubjectHash(input.subject);
  const timelineEventId = deriveTimelineEventId({
    eventType: input.eventType,
    missionId: input.missionId,
    scheduleId: input.scheduleId,
    taskId: input.taskId,
    recoveryCandidateId: input.recoveryCandidateId,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    occurredAt: input.occurredAt,
    subjectHash,
  });
  const eventHash = sha256Hex(
    canonicalJson({
      v: 1,
      timelineEventId,
      eventType: input.eventType,
      eventLabel: input.eventLabel,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      occurredAt: input.occurredAt,
      subjectHash,
    })
  );
  await insertMissionTimelineEvent(
    {
      timelineEventId,
      userId: input.userId,
      businessId: input.businessId,
      missionId: input.missionId,
      scheduleId: input.scheduleId,
      taskId: input.taskId,
      recoveryCandidateId: input.recoveryCandidateId,
      eventType: input.eventType,
      eventLabel: input.eventLabel.slice(0, 64),
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      occurredAt: input.occurredAt,
      eventHash,
    },
    deps.store
  );
}

// ─── Derivation + persistence ───

interface DerivedObservation {
  readonly taskDerivations: ReadonlyMap<string, TaskOperationalDerivation>;
  readonly requiredTaskIds: readonly string[];
  readonly driftTaskIds: readonly string[];
  readonly health: ReturnType<typeof deriveMissionHealth>;
  readonly stateDerivationHash: string;
  readonly latestExecutionRefs: readonly string[];
}

function deriveWorld(world: MissionWorld, deps: MissionStateServiceDeps): DerivedObservation {
  const nowMs = Date.parse(nowIso(deps));
  const scheduleTaskSet = new Set(world.schedule ? world.schedule.orderedTaskIds : []);
  const actionsByTask = new Map<string, ExecutionActionView[]>();
  for (const action of world.actions) {
    const list = actionsByTask.get(action.taskId) ?? [];
    list.push(action);
    actionsByTask.set(action.taskId, list);
  }

  const taskDerivations = new Map<string, TaskOperationalDerivation>();
  const requiredTaskIds: string[] = [];
  const cores: ReturnType<typeof toTaskStateCore>[] = [];

  for (const task of world.tasks) {
    const inCurrentSchedule = scheduleTaskSet.size === 0 ? true : scheduleTaskSet.has(task.taskId);
    const blocking = world.schedule?.blockingStates.find((b) => b.taskId === task.taskId) ?? null;
    const actions = actionsByTask.get(task.taskId) ?? [];
    const attempts = actions.flatMap((a) => [...(world.attemptsByAction.get(a.executionActionId) ?? [])]);
    const derivation = deriveTaskOperationalState({
      task,
      inCurrentSchedule,
      scheduleBlocking: blocking,
      actions,
      attempts,
      missionStatus: world.mission.status,
      scheduleStatus: world.schedule?.status ?? "READY",
      nowMs,
      pendingExternalStaleMs: PENDING_EXTERNAL_STALE_MS,
      dispatchedStaleMs: DISPATCHED_STALE_MS,
    });
    taskDerivations.set(task.taskId, derivation);
    cores.push(toTaskStateCore(derivation, task.taskId));
    if (inCurrentSchedule) requiredTaskIds.push(task.taskId);
  }

  // Drift: execution actions bound to tasks outside the current schedule.
  const driftTaskIds = world.actions
    .filter((a) => scheduleTaskSet.size > 0 && !scheduleTaskSet.has(a.taskId))
    .map((a) => a.taskId);

  const stateDerivationHash = deriveStateDerivationHash({
    missionFingerprint: world.mission.missionFingerprint || world.mission.missionId,
    planFingerprint: world.plan.planFingerprint || world.plan.planId,
    scheduleFingerprint: world.schedule?.scheduleFingerprint || world.schedule?.scheduleId || "",
    missionStatus: world.mission.status,
    planStatus: world.plan.status,
    scheduleStatus: world.schedule?.status ?? "READY",
    taskStateCores: cores,
    nowBucket: new Date(nowMs).toISOString().slice(0, 15), // 10-minute bucket
  });

  const requiredStates = requiredTaskIds.map((id) => taskDerivations.get(id) as TaskOperationalDerivation);
  const health = deriveMissionHealth({
    missionStatus: world.mission.status,
    planStatus: world.plan.status,
    scheduleStatus: world.schedule?.status ?? "READY",
    requiredStates,
    driftNoteCount: driftTaskIds.length,
  });

  const latestExecutionRefs = [...world.actions]
    .sort((a, b) => b.executionActionId.localeCompare(a.executionActionId))
    .slice(0, 100)
    .flatMap((a) => [a.executionActionId]);

  return { taskDerivations, requiredTaskIds, driftTaskIds, health, stateDerivationHash, latestExecutionRefs };
}

function buildScope(input: {
  world: MissionWorld;
  taskId: string;
  derivation: TaskOperationalDerivation;
}): RecoveryScope {
  const { world, taskId, derivation } = input;
  const action = derivation.latestActionId
    ? world.actions.find((a) => a.executionActionId === derivation.latestActionId) ?? null
    : null;
  return {
    missionId: world.mission.missionId,
    planId: world.plan.planId,
    scheduleId: world.schedule?.scheduleId ?? "",
    taskId,
    executionActionId: action?.executionActionId ?? null,
    latestAttemptId: derivation.latestAttemptId,
    actionType: action?.actionType ?? null,
    adapterType: action?.adapterType ?? null,
    capability: action?.capability ?? null,
    actionParametersHash: action?.actionParametersHash ?? null,
  };
}

async function persistCandidate(input: {
  deps: MissionStateServiceDeps;
  userId: number;
  world: MissionWorld;
  taskId: string;
  derivation: TaskOperationalDerivation;
  recoveryType: MissionRecoveryType;
  occurredAt: string;
  reason?: string;
}): Promise<{ row: MissionRecoveryCandidateRow; duplicateClassification: MissionDuplicateClassification }> {
  const { deps, userId, world, taskId, derivation, recoveryType, occurredAt } = input;
  const scope = buildScope({ world, taskId, derivation });
  const proposalHash = deriveRecoveryProposalHash({
    tenantUserId: userId,
    businessId: world.mission.businessId,
    missionId: world.mission.missionId,
    planId: world.plan.planId,
    scheduleId: world.schedule?.scheduleId ?? "",
    taskId,
    executionActionId: scope.executionActionId,
    latestAttemptId: scope.latestAttemptId,
    failureClass: derivation.failureClass,
    uncertaintyClass: derivation.uncertaintyClass,
    recoveryType,
    scope,
  });
  const recoveryCandidateId = deriveRecoveryCandidateId({
    tenantUserId: userId,
    businessId: world.mission.businessId,
    missionId: world.mission.missionId,
    taskId,
    latestAttemptId: scope.latestAttemptId,
    recoveryType,
    recoveryProposalHash: proposalHash,
  });
  const result = await insertMissionRecoveryCandidate(
    {
      recoveryCandidateId,
      userId,
      businessId: world.mission.businessId,
      missionId: world.mission.missionId,
      planId: world.plan.planId,
      scheduleId: world.schedule?.scheduleId ?? "",
      taskId,
      executionActionId: scope.executionActionId,
      latestAttemptId: scope.latestAttemptId,
      failureClass: derivation.failureClass,
      uncertaintyClass: derivation.uncertaintyClass,
      recoveryType,
      status: "PROPOSED",
      scope: scope as unknown as Record<string, unknown>,
      proposalHash,
      governanceDecisionId: null,
      governanceStatus: null,
      consumedAuthorization: null,
      supersededByRecoveryId: null,
      validUntil: null,
      version: 1,
    },
    deps.store
  );
  if (result.duplicateClassification === "none") {
    await recordTimeline(deps, {
      userId,
      businessId: world.mission.businessId,
      missionId: world.mission.missionId,
      scheduleId: world.schedule?.scheduleId ?? null,
      taskId,
      recoveryCandidateId,
      eventType: "recovery_candidate_proposed",
      eventLabel: `recovery_candidate_proposed:${recoveryType}`,
      fromStatus: null,
      toStatus: "PROPOSED",
      occurredAt,
      subject: { recoveryCandidateId, recoveryType, taskId, latestAttemptId: scope.latestAttemptId },
    });
    await emitAudit(deps, {
      eventType: "mission_recovery_candidate_proposed",
      userId,
      businessId: world.mission.businessId,
      occurredAt,
      metadata: {
        recoveryCandidateId,
        missionId: world.mission.missionId,
        taskId,
        recoveryType,
        latestAttemptId: scope.latestAttemptId ?? null,
        failureClass: derivation.failureClass,
        uncertaintyClass: derivation.uncertaintyClass,
        advisoryOnly: true,
      },
    });
  }
  return result;
}

/**
 * Observes a mission: derives deterministic operational state from the
 * authoritative world and persists it (insert-new-version). Identical
 * observation input converges (`idempotent_replay`, zero extra events).
 */
export async function observeMissionState(
  userId: number,
  input: { missionId: string; planId?: string; scheduleId?: string },
  deps: MissionStateServiceDeps = {}
): Promise<ObserveMissionStateResult> {
  const occurredAt = nowIso(deps);
  const world = await loadWorld(userId, input, deps);
  const derived = deriveWorld(world, deps);

  // Persist per-task states (insert-first, deterministic identities).
  const taskStateRows: MissionTaskStateRow[] = [];
  for (const task of world.tasks) {
    const derivation = derived.taskDerivations.get(task.taskId) as TaskOperationalDerivation;
    const stateHash = deriveTaskStateHash(toTaskStateCore(derivation, task.taskId));
    const taskStateId = deriveTaskStateId({
      tenantUserId: userId,
      businessId: world.mission.businessId,
      missionId: world.mission.missionId,
      planId: world.plan.planId,
      scheduleId: world.schedule?.scheduleId ?? "",
      taskId: task.taskId,
      latestAttemptId: derivation.latestAttemptId,
      taskStateHash: stateHash,
    });
    const write = await insertMissionTaskState(
      {
        taskStateId,
        userId,
        businessId: world.mission.businessId,
        missionId: world.mission.missionId,
        planId: world.plan.planId,
        scheduleId: world.schedule?.scheduleId ?? "",
        taskId: task.taskId,
        latestAttemptId: derivation.latestAttemptId,
        status: derivation.status,
        failureClass: derivation.failureClass,
        uncertaintyClass: derivation.uncertaintyClass,
        retryEligibility: derivation.retryEligibility,
        recoveryRequired: derivation.recoveryRequired,
        blockingReasons: [...derivation.blockingReasons],
        uncertainties: [...derivation.uncertainties],
        lastUpdatedAt: occurredAt,
        stateHash,
        version: 1,
      },
      deps.store
    );
    taskStateRows.push(write.row);
    if (write.duplicateClassification === "none") {
      await recordTimeline(deps, {
        userId,
        businessId: world.mission.businessId,
        missionId: world.mission.missionId,
        scheduleId: world.schedule?.scheduleId ?? null,
        taskId: task.taskId,
        recoveryCandidateId: null,
        eventType: "task_state_derived",
        eventLabel: `task_state_derived:${derivation.status}`,
        fromStatus: null,
        toStatus: derivation.status,
        occurredAt,
        subject: { taskStateId, taskId: task.taskId, status: derivation.status, failureClass: derivation.failureClass },
      });
      if (derivation.uncertainties.length > 0) {
        // Uncertainty stays visible — never folded into success (contract §11).
        await recordTimeline(deps, {
          userId,
          businessId: world.mission.businessId,
          missionId: world.mission.missionId,
          scheduleId: world.schedule?.scheduleId ?? null,
          taskId: task.taskId,
          recoveryCandidateId: null,
          eventType: "uncertainty_observed",
          eventLabel: `uncertainty_observed:${derivation.uncertaintyClass}`,
          fromStatus: null,
          toStatus: derivation.uncertaintyClass,
          occurredAt,
          subject: { taskStateId, taskId: task.taskId, uncertainties: [...derivation.uncertainties] },
        });
      }
    }
  }

  // Recovery candidates for tasks that require recovery (advisory only).
  const candidates: MissionRecoveryCandidateRow[] = [];
  for (const task of world.tasks) {
    const derivation = derived.taskDerivations.get(task.taskId) as TaskOperationalDerivation;
    if (!derivation.recoveryRequired) continue;
    const recoveryType = selectRecoveryType(derivation);
    if (!recoveryType) continue;
    const write = await persistCandidate({
      deps,
      userId,
      world,
      taskId: task.taskId,
      derivation,
      recoveryType,
      occurredAt,
    });
    candidates.push(write.row);
  }

  // Mission state record.
  const byStatus: Record<string, number> = {};
  for (const row of taskStateRows) {
    byStatus[row.status] = (byStatus[row.status] ?? 0) + 1;
  }
  const requiredSucceeded = derived.requiredTaskIds.filter(
    (id) => derived.taskDerivations.get(id)?.status === "SUCCEEDED"
  ).length;
  const missionStateId = deriveMissionStateId({
    tenantUserId: userId,
    businessId: world.mission.businessId,
    missionId: world.mission.missionId,
    planId: world.plan.planId,
    scheduleId: world.schedule?.scheduleId ?? "",
    stateDerivationHash: derived.stateDerivationHash,
  });
  const missionWrite = await insertMissionStateRecord(
    {
      missionStateId,
      userId,
      businessId: world.mission.businessId,
      missionId: world.mission.missionId,
      planId: world.plan.planId,
      scheduleId: world.schedule?.scheduleId ?? "",
      missionStatus: world.mission.status,
      healthClass: derived.health.healthClass,
      taskSummary: {
        total: taskStateRows.length,
        byStatus,
        requiredTotal: derived.requiredTaskIds.length,
        requiredSucceeded,
        driftTaskCount: derived.driftTaskIds.length,
      },
      latestExecutionRefs: [...derived.latestExecutionRefs],
      blockingReasons: [...derived.health.blockingReasons],
      uncertainties: [...derived.health.uncertainties],
      recoveryCandidateIds: candidates.map((c) => c.recoveryCandidateId),
      observedAt: occurredAt,
      derivedFromVersion: derived.stateDerivationHash,
      validUntil: new Date(Date.parse(occurredAt) + OBSERVATION_VALIDITY_MS).toISOString(),
      version: 1,
    },
    deps.store
  );
  if (missionWrite.duplicateClassification === "none") {
    await recordTimeline(deps, {
      userId,
      businessId: world.mission.businessId,
      missionId: world.mission.missionId,
      scheduleId: world.schedule?.scheduleId ?? null,
      taskId: null,
      recoveryCandidateId: null,
      eventType: "mission_state_derived",
      eventLabel: `mission_state_derived:${derived.health.healthClass}`,
      fromStatus: null,
      toStatus: derived.health.healthClass,
      occurredAt,
      subject: { missionStateId, healthClass: derived.health.healthClass, missionStatus: world.mission.status },
    });
    await emitAudit(deps, {
      eventType: "mission_state_derived",
      userId,
      businessId: world.mission.businessId,
      occurredAt,
      metadata: {
        missionStateId,
        missionId: world.mission.missionId,
        scheduleId: world.schedule?.scheduleId ?? null,
        missionStatus: world.mission.status,
        healthClass: derived.health.healthClass,
        derivedFromVersion: derived.stateDerivationHash,
        duplicate: false,
      },
    });
  }

  return {
    missionState: missionWrite.row,
    taskStates: taskStateRows,
    recoveryCandidates: candidates,
    duplicateClassification: missionWrite.duplicateClassification,
    healthClass: derived.health.healthClass,
  };
}

// ─── Read-only operator surface ───

export async function getMissionState(
  userId: number,
  input: { missionId: string; scheduleId?: string },
  deps: MissionStateServiceDeps = {}
): Promise<MissionStateRecordRow | null> {
  return getLatestMissionStateRecord(userId, input.missionId, input.scheduleId ?? null, deps.store);
}

export async function listMissionTaskStates(
  userId: number,
  input: { missionId: string; limit?: number },
  deps: MissionStateServiceDeps = {}
): Promise<MissionTaskStateRow[]> {
  // Ownership: the mission must resolve for this tenant before rows surface.
  const upstream = depsUpstream(deps);
  const mission = await upstream.resolveMission(userId, input.missionId);
  if (!mission) {
    const scope = await upstream.resolveMissionGlobal(input.missionId);
    if (scope) throw new MissionStateOwnershipError(CROSS_TENANT_MISSION, "mission belongs to a different tenant.");
    throw new MissionStateInputError(UNKNOWN_MISSION, `mission ${input.missionId} not found for this tenant.`);
  }
  const rows = await listLatestMissionTaskStates(userId, input.missionId, input.limit ?? 200, deps.store);
  return rows.filter((r) => r.businessId === mission.businessId);
}

export async function listExecutionAttemptsForMission(
  userId: number,
  input: { missionId: string; taskId?: string; limit?: number },
  deps: MissionStateServiceDeps = {}
): Promise<readonly ExecutionAttemptView[]> {
  const upstream = depsUpstream(deps);
  const mission = await upstream.resolveMission(userId, input.missionId);
  if (!mission) {
    const scope = await upstream.resolveMissionGlobal(input.missionId);
    if (scope) throw new MissionStateOwnershipError(CROSS_TENANT_MISSION, "mission belongs to a different tenant.");
    throw new MissionStateInputError(UNKNOWN_MISSION, `mission ${input.missionId} not found for this tenant.`);
  }
  const execution = depsExecution(deps);
  const actions = input.taskId
    ? await execution.listActionsForTask(userId, input.missionId, input.taskId)
    : await execution.listActionsForMission(userId, input.missionId);
  const attempts: ExecutionAttemptView[] = [];
  for (const action of actions) {
    attempts.push(...(await execution.listAttemptsForAction(userId, action.executionActionId)));
  }
  return attempts
    .filter((a) => a.businessId === mission.businessId)
    .sort((a, b) => b.attemptId.localeCompare(a.attemptId))
    .slice(0, input.limit ?? 100);
}

export async function listRecoveryCandidates(
  userId: number,
  input: { missionId: string; taskId?: string; status?: string; limit?: number },
  deps: MissionStateServiceDeps = {}
): Promise<MissionRecoveryCandidateRow[]> {
  const upstream = depsUpstream(deps);
  const mission = await upstream.resolveMission(userId, input.missionId);
  if (!mission) {
    const scope = await upstream.resolveMissionGlobal(input.missionId);
    if (scope) throw new MissionStateOwnershipError(CROSS_TENANT_MISSION, "mission belongs to a different tenant.");
    throw new MissionStateInputError(UNKNOWN_MISSION, `mission ${input.missionId} not found for this tenant.`);
  }
  const rows = await listMissionRecoveryCandidates(
    userId,
    input.missionId,
    { taskId: input.taskId, status: input.status },
    input.limit ?? 100,
    deps.store
  );
  return rows.filter((r) => r.businessId === mission.businessId);
}

export async function getRecoveryCandidate(
  userId: number,
  input: { recoveryCandidateId: string },
  deps: MissionStateServiceDeps = {}
): Promise<MissionRecoveryCandidateRow> {
  const row = await getMissionRecoveryCandidateById(userId, input.recoveryCandidateId, deps.store);
  if (!row) {
    throw new MissionStateInputError(UNKNOWN_RECOVERY_CANDIDATE, `recovery candidate ${input.recoveryCandidateId} not found.`);
  }
  return row;
}

export async function getOperationalTimeline(
  userId: number,
  input: { missionId: string; limit?: number },
  deps: MissionStateServiceDeps = {}
): Promise<Awaited<ReturnType<typeof listMissionTimelineEvents>>> {
  const upstream = depsUpstream(deps);
  const mission = await upstream.resolveMission(userId, input.missionId);
  if (!mission) {
    const scope = await upstream.resolveMissionGlobal(input.missionId);
    if (scope) throw new MissionStateOwnershipError(CROSS_TENANT_MISSION, "mission belongs to a different tenant.");
    throw new MissionStateInputError(UNKNOWN_MISSION, `mission ${input.missionId} not found for this tenant.`);
  }
  const rows = await listMissionTimelineEvents(userId, input.missionId, input.limit ?? 200, deps.store);
  return rows.filter((r) => r.businessId === mission.businessId);
}

export async function getMissionHealth(
  userId: number,
  input: { missionId: string; planId?: string; scheduleId?: string },
  deps: MissionStateServiceDeps = {}
): Promise<{ missionId: string; healthClass: string; missionStatus: string; derivedFromVersion: string | null; observedAt: string | null }> {
  const record = await getLatestMissionStateRecord(userId, input.missionId, input.scheduleId ?? null, deps.store);
  if (record) {
    return {
      missionId: input.missionId,
      healthClass: record.healthClass,
      missionStatus: record.missionStatus,
      derivedFromVersion: record.derivedFromVersion,
      observedAt: record.observedAt,
    };
  }
  // No observation yet: derive on the fly from the authoritative world
  // (read-only, never persisted) so health is never fabricated and never
  // client-set. A plan/schedule reference is required to load that world.
  if (!input.planId && !input.scheduleId) {
    throw new MissionStateInputError(
      MISSION_STATE_INPUT_MALFORMED,
      "no mission observation exists; provide planId or scheduleId to derive health read-only."
    );
  }
  const world = await loadWorld(userId, { missionId: input.missionId, planId: input.planId, scheduleId: input.scheduleId }, deps);
  const derived = deriveWorld(world, deps);
  return {
    missionId: input.missionId,
    healthClass: derived.health.healthClass,
    missionStatus: world.mission.status,
    derivedFromVersion: null,
    observedAt: null,
  };
}

// ─── Recovery proposal + governance binding + consumption ───

export async function proposeRecovery(
  userId: number,
  input: { missionId: string; scheduleId: string; taskId: string; recoveryType: MissionRecoveryType; reason?: string },
  deps: MissionStateServiceDeps = {}
): Promise<{ candidate: MissionRecoveryCandidateRow; duplicateClassification: MissionDuplicateClassification }> {
  const occurredAt = nowIso(deps);
  const world = await loadWorld(userId, { missionId: input.missionId, scheduleId: input.scheduleId }, deps);
  if (!world.schedule) {
    throw new MissionStateInputError(UNKNOWN_MISSION, "scheduleId is required for recovery proposals.");
  }
  const task = world.tasks.find((t) => t.taskId === input.taskId);
  if (!task) {
    const anyTask = await depsUpstream(deps).resolveTask(userId, input.taskId);
    if (anyTask) {
      throw new MissionStateOwnershipError(CROSS_BUSINESS_MISSION, "task does not belong to the named mission scope.");
    }
    throw new MissionStateInputError(UNKNOWN_TASK, `task ${input.taskId} not found in mission scope.`);
  }
  const scheduleTaskSet = new Set(world.schedule.orderedTaskIds);
  const actions = world.actions.filter((a) => a.taskId === input.taskId);
  const attempts = actions.flatMap((a) => [...(world.attemptsByAction.get(a.executionActionId) ?? [])]);
  const derivation = deriveTaskOperationalState({
    task,
    inCurrentSchedule: scheduleTaskSet.size === 0 ? true : scheduleTaskSet.has(input.taskId),
    scheduleBlocking: world.schedule.blockingStates.find((b) => b.taskId === input.taskId) ?? null,
    actions,
    attempts,
    missionStatus: world.mission.status,
    scheduleStatus: world.schedule.status,
    nowMs: Date.parse(occurredAt),
    pendingExternalStaleMs: PENDING_EXTERNAL_STALE_MS,
    dispatchedStaleMs: DISPATCHED_STALE_MS,
  });
  if (input.recoveryType === "RETRY") {
    // A retry candidate preserves the EXACT failed attempt and is only
    // proposal-eligible after an explicit retryable failure — never inferred.
    if (derivation.status !== "FAILED_RETRYABLE" || !derivation.latestAttemptId) {
      throw new MissionStateConflictError(
        MISSION_STATE_CONFLICT,
        `retry proposals require a FAILED_RETRYABLE task state with an authoritative attempt; got ${derivation.status}.`
      );
    }
  }
  const write = await persistCandidate({
    deps,
    userId,
    world,
    taskId: input.taskId,
    derivation,
    recoveryType: input.recoveryType,
    occurredAt,
    reason: input.reason,
  });
  return { candidate: write.row, duplicateClassification: write.duplicateClassification };
}

export async function bindRecoveryGovernance(
  userId: number,
  input: { recoveryCandidateId: string; governanceDecisionId: string },
  deps: MissionStateServiceDeps = {}
): Promise<{ candidate: MissionRecoveryCandidateRow; verdict: "AUTHORIZED" | "REVIEW_REQUIRED" | "BLOCKED"; reason: string | null }> {
  const occurredAt = nowIso(deps);
  const candidate = await getMissionRecoveryCandidateById(userId, input.recoveryCandidateId, deps.store);
  if (!candidate) {
    throw new MissionStateInputError(UNKNOWN_RECOVERY_CANDIDATE, `recovery candidate ${input.recoveryCandidateId} not found.`);
  }
  if (!["PROPOSED", "REVIEW_REQUIRED"].includes(candidate.status)) {
    throw new MissionStateTamperError(INVALID_RECOVERY_STATUS, `candidate in status ${candidate.status} cannot be governance-bound.`);
  }
  const governance = depsGovernance(deps);
  const decision = await governance.resolveDecision(userId, input.governanceDecisionId);
  if (!decision) {
    const scope = await governance.resolveDecisionGlobal(input.governanceDecisionId);
    if (scope) {
      if (scope.userId !== userId) {
        throw new MissionStateOwnershipError(CROSS_TENANT_MISSION, "governance decision belongs to a different tenant.");
      }
      throw new MissionStateOwnershipError(CROSS_BUSINESS_MISSION, "governance decision belongs to a different business.");
    }
    throw new MissionStateInputError(GOVERNANCE_DECISION_NOT_FOUND, `decision ${input.governanceDecisionId} not found.`);
  }
  if (decision.businessId !== candidate.businessId) {
    throw new MissionStateOwnershipError(CROSS_BUSINESS_MISSION, "governance decision business does not match the candidate.");
  }
  if (decision.missionRef !== candidate.missionId) {
    throw new MissionStateConflictError(MISSION_STATE_CONFLICT, "governance decision mission does not match the candidate.");
  }

  const scope = candidate.scope as unknown as RecoveryScope;
  const canonicalParams = deriveCanonicalRecoveryParams({
    recoveryCandidateId: candidate.recoveryCandidateId,
    recoveryType: candidate.recoveryType,
    executionActionId: candidate.executionActionId,
    latestAttemptId: candidate.latestAttemptId,
    taskId: candidate.taskId,
    scope,
  });
  const paramsFingerprint = deriveRecoveryActionParamsFingerprint(canonicalParams);
  const expectedAction = {
    subjectClass: RECOVERY_TYPE_GOVERNANCE_SUBJECT[candidate.recoveryType as MissionRecoveryType],
    actionType: RECOVERY_TYPE_GOVERNANCE_ACTION[candidate.recoveryType as MissionRecoveryType],
    missionRef: candidate.missionId,
    planRef: candidate.planId,
    taskRef: candidate.taskId,
  };
  const approval = await governance.resolveApprovalForDecision(userId, decision.governanceDecisionId);
  const policyVersion = await governance.currentPolicyVersion();
  const verdict = assertRecoveryActionConsumable({
    decision,
    approval,
    expectedAction,
    expectedActionParamsFingerprint: paramsFingerprint,
    currentPolicyVersion: policyVersion,
    now: occurredAt,
  });

  if (decision.decision === "BLOCK") {
    const updated = await transitionRecoveryStatus({
      userId,
      recoveryCandidateId: candidate.recoveryCandidateId,
      expectedVersion: candidate.version,
      fromStatuses: ["PROPOSED", "REVIEW_REQUIRED"],
      toStatus: "PROPOSED",
      set: { governanceDecisionId: decision.governanceDecisionId, governanceStatus: "BLOCKED" },
      executor: deps.store,
    });
    return { candidate: updated, verdict: "BLOCKED", reason: verdict.consumable === false ? verdict.reason : null };
  }

  if (verdict.consumable) {
    const from = candidate.status;
    const updated = await transitionRecoveryStatus({
      userId,
      recoveryCandidateId: candidate.recoveryCandidateId,
      expectedVersion: candidate.version,
      fromStatuses: ["PROPOSED", "REVIEW_REQUIRED"],
      toStatus: "AUTHORIZED",
      set: {
        governanceDecisionId: decision.governanceDecisionId,
        governanceStatus: "AUTHORIZED",
        consumedAuthorization: verdict.authorization as unknown as Record<string, unknown>,
        validUntil: verdict.authorization.expiresAt || null,
      },
      executor: deps.store,
    });
    await recordRecoveryLifecycle(deps, {
      userId,
      businessId: candidate.businessId,
      missionId: candidate.missionId,
      candidate,
      lifecycleType: "governance_authorized",
      fromStatus: from,
      toStatus: "AUTHORIZED",
      occurredAt,
      reason: decision.decision === "ALLOW" ? "GOVERNANCE_ALLOW" : "APPROVAL_BOUND",
    });
    return { candidate: updated, verdict: "AUTHORIZED", reason: null };
  }

  if (decision.decision === "REVIEW_REQUIRED") {
    const from = candidate.status;
    if (candidate.status === "PROPOSED") {
      const updated = await transitionRecoveryStatus({
        userId,
        recoveryCandidateId: candidate.recoveryCandidateId,
        expectedVersion: candidate.version,
        fromStatuses: ["PROPOSED"],
        toStatus: "REVIEW_REQUIRED",
        set: { governanceDecisionId: decision.governanceDecisionId, governanceStatus: "REVIEW_REQUIRED" },
        executor: deps.store,
      });
      await recordRecoveryLifecycle(deps, {
        userId,
        businessId: candidate.businessId,
        missionId: candidate.missionId,
        candidate,
        lifecycleType: "governance_review_required",
        fromStatus: from,
        toStatus: "REVIEW_REQUIRED",
        occurredAt,
        reason: "RECOVERY_REQUIRES_FRESH_REVIEW",
      });
      return { candidate: updated, verdict: "REVIEW_REQUIRED", reason: verdict.reason };
    }
    const updated = await transitionRecoveryStatus({
      userId,
      recoveryCandidateId: candidate.recoveryCandidateId,
      expectedVersion: candidate.version,
      fromStatuses: ["REVIEW_REQUIRED"],
      toStatus: "REVIEW_REQUIRED",
      set: { governanceDecisionId: decision.governanceDecisionId, governanceStatus: "REVIEW_REQUIRED" },
      executor: deps.store,
    });
    return { candidate: updated, verdict: "REVIEW_REQUIRED", reason: verdict.reason };
  }

  // ALLOW but not consumable (expired / stale policy) — stay PROPOSED, visible.
  const updated = await transitionRecoveryStatus({
    userId,
    recoveryCandidateId: candidate.recoveryCandidateId,
    expectedVersion: candidate.version,
    fromStatuses: ["PROPOSED", "REVIEW_REQUIRED"],
    toStatus: "PROPOSED",
    set: { governanceDecisionId: decision.governanceDecisionId, governanceStatus: "NOT_CONSUMABLE" },
    executor: deps.store,
  });
  return { candidate: updated, verdict: "BLOCKED", reason: verdict.consumable === false ? verdict.reason : null };
}

async function recordRecoveryLifecycle(
  deps: MissionStateServiceDeps,
  input: {
    userId: number;
    businessId: number;
    missionId: string;
    candidate: MissionRecoveryCandidateRow;
    lifecycleType: string;
    fromStatus: string | null;
    toStatus: string;
    occurredAt: string;
    reason?: string | null;
  }
): Promise<void> {
  const lifecycleEventId = deriveRecoveryLifecycleId({
    recoveryCandidateId: input.candidate.recoveryCandidateId,
    lifecycleType: input.lifecycleType,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    occurredAt: input.occurredAt,
  });
  await recordTimeline(deps, {
    userId: input.userId,
    businessId: input.businessId,
    missionId: input.missionId,
    scheduleId: input.candidate.scheduleId,
    taskId: input.candidate.taskId,
    recoveryCandidateId: input.candidate.recoveryCandidateId,
    eventType: "recovery_lifecycle_changed",
    eventLabel: `recovery_lifecycle_changed:${input.toStatus}`,
    fromStatus: input.fromStatus,
    toStatus: input.toStatus,
    occurredAt: input.occurredAt,
    subject: {
      lifecycleEventId,
      lifecycleType: input.lifecycleType,
      recoveryCandidateId: input.candidate.recoveryCandidateId,
      reason: input.reason ?? null,
    },
  });
  await emitAudit(deps, {
    eventType: "mission_recovery_lifecycle",
    userId: input.userId,
    businessId: input.businessId,
    occurredAt: input.occurredAt,
    metadata: {
      lifecycleEventId,
      recoveryCandidateId: input.candidate.recoveryCandidateId,
      lifecycleType: input.lifecycleType,
      fromStatus: input.fromStatus,
      toStatus: input.toStatus,
      reason: input.reason ?? null,
    },
  });
}

export interface ConsumeRecoveryResult {
  readonly candidate: MissionRecoveryCandidateRow;
  /** Read-only governed execution-recovery handoff for R9-D. E never executes. */
  readonly executionRecoveryHandoff: Record<string, unknown> | null;
}

export async function consumeRecovery(
  userId: number,
  input: { recoveryCandidateId: string; expectedVersion: number },
  deps: MissionStateServiceDeps = {}
): Promise<ConsumeRecoveryResult> {
  const occurredAt = nowIso(deps);
  const candidate = await getMissionRecoveryCandidateById(userId, input.recoveryCandidateId, deps.store);
  if (!candidate) {
    throw new MissionStateInputError(UNKNOWN_RECOVERY_CANDIDATE, `recovery candidate ${input.recoveryCandidateId} not found.`);
  }
  if (candidate.status !== "AUTHORIZED") {
    throw new MissionStateTamperError(
      INVALID_RECOVERY_STATUS,
      `candidate in status ${candidate.status} is not consumable; only AUTHORIZED candidates may be consumed.`
    );
  }
  if (candidate.version !== input.expectedVersion) {
    throw new MissionStateIdentityConflictError(MISSION_STATE_CONFLICT, "stale expectedVersion for recovery consumption.");
  }

  // Scope revalidation: the candidate's bound attempt must still be the
  // latest authoritative attempt for its action — attempt supersession
  // supersedes the candidate (a fresh candidate can be proposed over the new
  // latest attempt).
  if (candidate.executionActionId && candidate.latestAttemptId) {
    const execution = depsExecution(deps);
    const attempts = await execution.listAttemptsForAction(userId, candidate.executionActionId);
    const latestByTime = attempts
      .slice()
      .sort((a, b) => {
        const ka = `${a.completedAt ?? a.startedAt ?? a.createdAt ?? ""}#${String(a.attemptNumber).padStart(8, "0")}#${a.attemptId}`;
        const kb = `${b.completedAt ?? b.startedAt ?? b.createdAt ?? ""}#${String(b.attemptNumber).padStart(8, "0")}#${b.attemptId}`;
        return kb.localeCompare(ka);
      })[0];
    if (latestByTime && latestByTime.attemptId !== candidate.latestAttemptId) {
      const updated = await transitionRecoveryStatus({
        userId,
        recoveryCandidateId: candidate.recoveryCandidateId,
        expectedVersion: candidate.version,
        fromStatuses: ["AUTHORIZED"],
        toStatus: "SUPERSEDED",
        set: { supersededByRecoveryId: null },
        executor: deps.store,
      });
      await recordRecoveryLifecycle(deps, {
        userId,
        businessId: candidate.businessId,
        missionId: candidate.missionId,
        candidate,
        lifecycleType: "attempt_superseded",
        fromStatus: "AUTHORIZED",
        toStatus: "SUPERSEDED",
        occurredAt,
        reason: "ATTEMPT_SUPERSEDED",
      });
      return { candidate: updated, executionRecoveryHandoff: null };
    }
  }

  // Immutable-core tamper check: the stored scope must re-hash to the stored
  // proposal hash. Drift means tampering — recovery scope can never silently
  // change (RECOVERY_SCOPE_DRIFT).
  const scope = candidate.scope as unknown as RecoveryScope;
  const recomputedProposalHash = deriveRecoveryProposalHash({
    tenantUserId: userId,
    businessId: candidate.businessId,
    missionId: candidate.missionId,
    planId: candidate.planId,
    scheduleId: candidate.scheduleId,
    taskId: candidate.taskId,
    executionActionId: candidate.executionActionId,
    latestAttemptId: candidate.latestAttemptId,
    failureClass: candidate.failureClass,
    uncertaintyClass: candidate.uncertaintyClass,
    recoveryType: candidate.recoveryType,
    scope,
  });
  if (recomputedProposalHash !== candidate.proposalHash) {
    const updated = await transitionRecoveryStatus({
      userId,
      recoveryCandidateId: candidate.recoveryCandidateId,
      expectedVersion: candidate.version,
      fromStatuses: ["AUTHORIZED"],
      toStatus: "INVALIDATED",
      executor: deps.store,
    });
    await recordRecoveryLifecycle(deps, {
      userId,
      businessId: candidate.businessId,
      missionId: candidate.missionId,
      candidate,
      lifecycleType: "scope_drift",
      fromStatus: "AUTHORIZED",
      toStatus: "INVALIDATED",
      occurredAt,
      reason: RECOVERY_SCOPE_DRIFT,
    });
    return { candidate: updated, executionRecoveryHandoff: null };
  }

  // Fresh governance revalidation (the frozen gate, again, at consumption).
  if (!candidate.governanceDecisionId) {
    throw new MissionStateTamperError(MISSION_STATE_TAMPER, "authorized candidate carries no governance decision binding.");
  }
  const governance = depsGovernance(deps);
  const decision = await governance.resolveDecision(userId, candidate.governanceDecisionId);
  if (!decision) {
    throw new MissionStateInputError(GOVERNANCE_DECISION_NOT_FOUND, "bound governance decision no longer exists.");
  }
  const canonicalParams = deriveCanonicalRecoveryParams({
    recoveryCandidateId: candidate.recoveryCandidateId,
    recoveryType: candidate.recoveryType,
    executionActionId: candidate.executionActionId,
    latestAttemptId: candidate.latestAttemptId,
    taskId: candidate.taskId,
    scope,
  });
  const paramsFingerprint = deriveRecoveryActionParamsFingerprint(canonicalParams);
  const approval = await governance.resolveApprovalForDecision(userId, decision.governanceDecisionId);
  const policyVersion = await governance.currentPolicyVersion();
  const verdict = assertRecoveryActionConsumable({
    decision,
    approval,
    expectedAction: {
      subjectClass: RECOVERY_TYPE_GOVERNANCE_SUBJECT[candidate.recoveryType as MissionRecoveryType],
      actionType: RECOVERY_TYPE_GOVERNANCE_ACTION[candidate.recoveryType as MissionRecoveryType],
      missionRef: candidate.missionId,
      planRef: candidate.planId,
      taskRef: candidate.taskId,
    },
    expectedActionParamsFingerprint: paramsFingerprint,
    currentPolicyVersion: policyVersion,
    now: occurredAt,
  });
  if (!verdict.consumable) {
    throw new MissionStateConflictError(
      GOVERNANCE_NOT_CONSUMABLE,
      `recovery is not consumable: ${verdict.reason}.`
    );
  }

  const updated = await transitionRecoveryStatus({
    userId,
    recoveryCandidateId: candidate.recoveryCandidateId,
    expectedVersion: candidate.version,
    fromStatuses: ["AUTHORIZED"],
    toStatus: "IN_PROGRESS",
    set: { consumedAuthorization: verdict.authorization as unknown as Record<string, unknown> },
    executor: deps.store,
  });
  await recordRecoveryLifecycle(deps, {
    userId,
    businessId: candidate.businessId,
    missionId: candidate.missionId,
    candidate,
    lifecycleType: "consumed",
    fromStatus: "AUTHORIZED",
    toStatus: "IN_PROGRESS",
    occurredAt,
    reason: "GOVERNED_RECOVERY_HANDOFF",
  });

  // Execution-recovery handoff (read-only): R9-D mints a fresh governed
  // action from this exact scope. E performs no dispatch, no execution.
  const executionRecoveryHandoff =
    candidate.recoveryType === "REQUEST_HUMAN_REVIEW" || candidate.recoveryType === "ESCALATE"
      ? null
      : {
          handoffType: "execution_recovery" as const,
          contractVersion: "mission-state-to-mission-control/v1" as const,
          recoveryCandidateId: candidate.recoveryCandidateId,
          recoveryType: candidate.recoveryType,
          scope,
          consumedAuthorization: verdict.authorization,
          handoffDisclaimer:
            "Governed recovery handoff — R9-D must mint a fresh governed execution action; this handoff authorizes nothing by itself.",
        };

  return { candidate: updated, executionRecoveryHandoff };
}

// ─── Re-evaluation (stale / drift detection) ───

export async function reevaluateMissionState(
  userId: number,
  input: { missionId: string; scheduleId?: string },
  deps: MissionStateServiceDeps = {}
): Promise<{ observation: ObserveMissionStateResult; affectedCandidateIds: string[] }> {
  const occurredAt = nowIso(deps);
  // Fresh observation re-derives everything from reloaded authority.
  const observation = await observeMissionState(userId, input, deps);

  // Candidate sweep: stale authority invalidates/stales bound candidates.
  const affectedCandidateIds: string[] = [];
  const candidates = await listMissionRecoveryCandidates(userId, input.missionId, {}, 100, deps.store);
  const world = await loadWorld(userId, input, deps);
  for (const candidate of candidates) {
    if (["SUPERSEDED", "CANCELLED", "INVALIDATED", "RESOLVED"].includes(candidate.status)) continue;
    let toStatus: string | null = null;
    let reason: string | null = null;
    if (["SUPERSEDED", "CANCELLED", "INVALIDATED"].includes(world.mission.status)) {
      toStatus = "INVALIDATED";
      reason = "MISSION_AUTHORITY_INVALID";
    } else if (world.mission.status === "STALE") {
      toStatus = "STALE";
      reason = "MISSION_STALE";
    } else if (["SUPERSEDED", "CANCELLED", "INVALIDATED"].includes(world.plan.status)) {
      toStatus = "INVALIDATED";
      reason = "PLAN_AUTHORITY_INVALID";
    } else if (world.plan.status === "STALE") {
      toStatus = "STALE";
      reason = "PLAN_STALE";
    } else if (world.schedule && ["SUPERSEDED", "CANCELLED", "INVALIDATED"].includes(world.schedule.status)) {
      toStatus = "INVALIDATED";
      reason = "SCHEDULE_AUTHORITY_INVALID";
    } else if (world.schedule && world.schedule.status === "STALE") {
      toStatus = "STALE";
      reason = "SCHEDULE_STALE";
    }
    if (toStatus && canTransitionRecoveryStatus(candidate.status as never, toStatus as never)) {
      const updated = await transitionRecoveryStatus({
        userId,
        recoveryCandidateId: candidate.recoveryCandidateId,
        expectedVersion: candidate.version,
        fromStatuses: [candidate.status],
        toStatus,
        executor: deps.store,
      });
      await recordRecoveryLifecycle(deps, {
        userId,
        businessId: candidate.businessId,
        missionId: candidate.missionId,
        candidate,
        lifecycleType: "authority_stale",
        fromStatus: candidate.status,
        toStatus,
        occurredAt,
        reason,
      });
      affectedCandidateIds.push(updated.recoveryCandidateId);
    }
  }
  return { observation, affectedCandidateIds };
}

// ─── Governed operator cancellation ───

export async function cancelRecovery(
  userId: number,
  input: { recoveryCandidateId: string; expectedVersion: number; reason: string },
  deps: MissionStateServiceDeps = {}
): Promise<MissionRecoveryCandidateRow> {
  const occurredAt = nowIso(deps);
  const candidate = await getMissionRecoveryCandidateById(userId, input.recoveryCandidateId, deps.store);
  if (!candidate) {
    throw new MissionStateInputError(UNKNOWN_RECOVERY_CANDIDATE, `recovery candidate ${input.recoveryCandidateId} not found.`);
  }
  if (!["PROPOSED", "REVIEW_REQUIRED", "AUTHORIZED", "STALE", "FAILED"].includes(candidate.status)) {
    throw new MissionStateTamperError(
      INVALID_RECOVERY_STATUS,
      `candidate in status ${candidate.status} cannot be cancelled.`
    );
  }
  if (candidate.version !== input.expectedVersion) {
    throw new MissionStateIdentityConflictError(MISSION_STATE_CONFLICT, "stale expectedVersion for recovery cancellation.");
  }
  const updated = await transitionRecoveryStatus({
    userId,
    recoveryCandidateId: candidate.recoveryCandidateId,
    expectedVersion: candidate.version,
    fromStatuses: ["PROPOSED", "REVIEW_REQUIRED", "AUTHORIZED", "STALE", "FAILED"],
    toStatus: "CANCELLED",
    executor: deps.store,
  });
  await recordTimeline(deps, {
    userId,
    businessId: candidate.businessId,
    missionId: candidate.missionId,
    scheduleId: candidate.scheduleId,
    taskId: candidate.taskId,
    recoveryCandidateId: candidate.recoveryCandidateId,
    eventType: "operator_intervention",
    eventLabel: "operator_intervention:cancel_recovery",
    fromStatus: candidate.status,
    toStatus: "CANCELLED",
    occurredAt,
    subject: { recoveryCandidateId: candidate.recoveryCandidateId, reason: input.reason.slice(0, 64) },
  });
  await recordRecoveryLifecycle(deps, {
    userId,
    businessId: candidate.businessId,
    missionId: candidate.missionId,
    candidate,
    lifecycleType: "operator_cancelled",
    fromStatus: candidate.status,
    toStatus: "CANCELLED",
    occurredAt,
    reason: input.reason.slice(0, 64),
  });
  return updated;
}

// ─── Downstream mission-control projection ───

export async function getMissionControlHandoff(
  userId: number,
  input: { missionId: string; scheduleId?: string },
  deps: MissionStateServiceDeps = {}
): Promise<MissionControlProjection> {
  const world = await loadWorld(userId, input, deps);
  const latest = await getLatestMissionStateRecord(userId, input.missionId, input.scheduleId ?? null, deps.store);
  const taskStates = await listLatestMissionTaskStates(userId, input.missionId, 200, deps.store);
  const candidates = await listMissionRecoveryCandidates(userId, input.missionId, {}, 100, deps.store);

  let missionStatus = world.mission.status;
  let healthClass: string;
  let derivedFromVersion: string;
  let observedAt: string;
  let validUntil: string;
  let taskSummary: Record<string, unknown>;
  let blockingReasons: readonly string[];
  let uncertainties: readonly string[];
  let latestExecutionRefs: readonly string[];

  if (latest) {
    missionStatus = latest.missionStatus;
    healthClass = latest.healthClass;
    derivedFromVersion = latest.derivedFromVersion;
    observedAt = latest.observedAt;
    validUntil = latest.validUntil;
    taskSummary = latest.taskSummary as Record<string, unknown>;
    blockingReasons = latest.blockingReasons as readonly string[];
    uncertainties = latest.uncertainties as readonly string[];
    latestExecutionRefs = latest.latestExecutionRefs as readonly string[];
  } else {
    // No persisted observation: derive read-only from the authoritative world
    // (never fabricated, never persisted by this read).
    const derived = deriveWorld(world, deps);
    const now = nowIso(deps);
    healthClass = derived.health.healthClass;
    derivedFromVersion = derived.stateDerivationHash;
    observedAt = now;
    validUntil = new Date(Date.parse(now) + OBSERVATION_VALIDITY_MS).toISOString();
    const byStatus: Record<string, number> = {};
    for (const task of world.tasks) {
      const d = derived.taskDerivations.get(task.taskId);
      if (d) byStatus[d.status] = (byStatus[d.status] ?? 0) + 1;
    }
    taskSummary = {
      total: world.tasks.length,
      byStatus,
      requiredTotal: derived.requiredTaskIds.length,
      requiredSucceeded: derived.requiredTaskIds.filter((id) => derived.taskDerivations.get(id)?.status === "SUCCEEDED").length,
      driftTaskCount: derived.driftTaskIds.length,
    };
    blockingReasons = derived.health.blockingReasons;
    uncertainties = derived.health.uncertainties;
    latestExecutionRefs = derived.latestExecutionRefs;
  }

  const taskStateProjections: MissionControlTaskStateProjection[] = taskStates.map((row) => ({
    taskId: row.taskId,
    status: row.status,
    failureClass: row.failureClass,
    uncertaintyClass: row.uncertaintyClass,
    retryEligibility: row.retryEligibility,
    recoveryRequired: row.recoveryRequired,
    blockingReasons: row.blockingReasons as readonly string[],
    uncertainties: row.uncertainties as readonly string[],
    latestAttemptId: row.latestAttemptId,
    lastUpdatedAt: row.lastUpdatedAt,
  }));

  const currentCandidates = candidates.filter((c) => !["SUPERSEDED", "CANCELLED", "INVALIDATED"].includes(c.status));
  const recoveryProjections: MissionControlRecoveryProjection[] = currentCandidates.map((c) => ({
    recoveryCandidateId: c.recoveryCandidateId,
    taskId: c.taskId,
    recoveryType: c.recoveryType,
    status: c.status,
    failureClass: c.failureClass,
    uncertaintyClass: c.uncertaintyClass,
    latestAttemptId: c.latestAttemptId,
    advisoryOnly: true,
  }));

  const governanceStatus = currentCandidates.some((c) => c.governanceStatus === "BLOCKED")
    ? "BLOCKED"
    : currentCandidates.some((c) => c.status === "REVIEW_REQUIRED")
      ? "REVIEW_REQUIRED"
      : currentCandidates.some((c) => c.status === "AUTHORIZED" || c.status === "IN_PROGRESS")
        ? "AUTHORIZED"
        : currentCandidates.length > 0
          ? "PROPOSED"
          : "NONE";

  return buildMissionControlProjection({
    missionId: world.mission.missionId,
    planId: world.plan.planId,
    scheduleId: world.schedule?.scheduleId ?? "",
    businessId: world.mission.businessId,
    missionStatus,
    healthClass,
    taskSummary,
    taskStates: taskStateProjections,
    latestExecutionRefs,
    blockingReasons,
    uncertainties,
    recoveryCandidates: recoveryProjections,
    governanceStatus,
    latestAuthoritativeRefs: {
      missionFingerprint: world.mission.missionFingerprint || world.mission.missionId,
      planFingerprint: world.plan.planFingerprint || world.plan.planId,
      scheduleFingerprint: world.schedule?.scheduleFingerprint || world.schedule?.scheduleId || null,
      missionStateId: latest?.missionStateId ?? null,
    },
    observedAt,
    derivedFromVersion,
    validUntil,
  });
}

// Re-exports for harness/router convenience (single surface).
export {
  createInMemoryMissionExecutionAuthority,
  createInMemoryMissionStateUpstreamAuthority,
  createInMemoryRecoveryGovernanceAuthority,
};
export type { ExecutionAttemptView, ExecutionActionView, TaskOperationalDerivation };
export { MISSION_NOT_CURRENT, RECOVERY_CANDIDATE_NOT_CURRENT, TASK_NOT_IN_MISSION };
