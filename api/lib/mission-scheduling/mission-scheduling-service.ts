// ─── R9-C Dependency & Scheduling Intelligence — service ───
//
// Server-side orchestration of the dependency & scheduling authority.
// Authority rules:
// - the client names missions/plans/tasks and bounded declaration material
//   only; identity, readiness, risk, ordering, requiresApproval, statuses,
//   fingerprints and validity are server-derived (z.strictObject boundary);
// - mission authority is re-verified against durable R9-A rows on every call;
//   cross-tenant / cross-business declarations fail closed;
// - dependency edges are immutable, hash-bound and cycle-checked against the
//   full plan graph — no agent or model can override cycle detection;
// - schedules are deterministic (content-addressed identity); identical
//   inputs converge by replay, changed inputs mint superseding schedules;
// - R9-F approval evidence is read-only: scheduling may set
//   requiresApproval=true, never ALLOW; R9-D must call R9-F's consumption
//   gate independently;
// - scheduling never writes mission/governance/approval tables, never invokes
//   providers, never moves budget, never grants capability. No EXECUTING
//   status exists in this stream.

import { canonicalJson, sha256Hex } from "../conversion/conversion-contract";
import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent } from "../audit/audit-store";
import {
  MISSION_SCHEDULING_STATE_PORT_VERSION,
  MissionSchedulingError,
  MissionSchedulingIdentityConflictError,
  MissionSchedulingInputError,
  MissionSchedulingOwnershipError,
  MissionSchedulingValidationError,
  SCHEDULABLE_MISSION_STATUSES,
  isSchedulableMissionStatus,
  missionTaskPlanPortSchema,
  produceMissionScheduleSchema,
  recordMissionDependencySchema,
  type MissionSchedulingDuplicateClassification,
  type MissionSchedulingStatePort,
  type MissionTaskPlanPort,
  type ProduceMissionScheduleInput,
  type RecordMissionDependencyInput,
} from "./mission-scheduling-contract";
import {
  deriveDependencyEvidenceHash,
  deriveDependencyId,
  deriveEvidenceSetHash,
  derivePlanFingerprint,
  deriveScheduleFingerprint,
  deriveScheduleId,
  deriveScheduleLifecycleEventId,
} from "./mission-scheduling-identity";
import { buildDependencyGraph } from "./mission-scheduling-graph";
import { produceScheduleCore, type ScheduleCoreOutput } from "./mission-scheduling-engine";
import type { MissionSchedulingGovernanceAuthority } from "./mission-scheduling-governance-seam";
import type { MissionSchedulingUpstreamAuthority } from "./mission-scheduling-upstream-seam";
import {
  assertDependencyEvidenceIntegrity,
  assertDependencyIdentityIntegrity,
  findTaskScopeInTenant,
  getCurrentPlanSnapshot,
  getScheduleByScheduleId,
  insertDependencyEdge,
  insertPlanSnapshot,
  insertSchedule,
  insertScheduleLifecycleEvent,
  listDependencies,
  listScheduleLifecycleEvents,
  listSchedules,
  transitionScheduleStatus,
  type MissionSchedulingStoreExecutor,
} from "./mission-scheduling-store";
import {
  buildMissionExecutionProjection,
  type MissionExecutionProjection,
} from "./mission-scheduling-projection";
import type {
  MissionDependencyEdgeRow,
  MissionScheduleLifecycleEventRow,
  MissionScheduleRow,
} from "@db/schema";

export interface MissionSchedulingServiceDeps {
  readonly upstream: MissionSchedulingUpstreamAuthority;
  readonly governance: MissionSchedulingGovernanceAuthority;
}

export interface MissionSchedulingAuthContext {
  readonly userId: number;
}

// ─── Audit (deterministic per durable effect; convergence emits zero) ───

async function emitSchedulingAudit(
  db: MissionSchedulingStoreExecutor | undefined,
  input: Parameters<typeof createAuditEvent>[0]
): Promise<void> {
  try {
    const event = createAuditEvent(input);
    await persistAuditEvent(event, db as never);
  } catch (err) {
    console.error(
      `[MissionScheduling] Failed to persist ${input.eventType} audit event:`,
      (err as Error)?.message
    );
  }
}

// ─── Mission verification ───

async function resolveOwnedMission(
  deps: MissionSchedulingServiceDeps,
  userId: number,
  missionId: string
) {
  const global = await deps.upstream.resolveMissionGlobal(missionId);
  if (!global) {
    throw new MissionSchedulingInputError("UNKNOWN_MISSION", `mission ${missionId} is unknown.`);
  }
  if (global.userId !== userId) {
    throw new MissionSchedulingOwnershipError(
      "CROSS_TENANT_DEPENDENCY",
      "the referenced mission belongs to a different tenant."
    );
  }
  const mission = await deps.upstream.resolveMission(userId, missionId);
  if (!mission) {
    throw new MissionSchedulingInputError("UNKNOWN_MISSION", `mission ${missionId} is unknown.`);
  }
  return mission;
}

function assertMissionSchedulable(mission: { status: string; validUntil: string }, nowIso: string): void {
  if (!isSchedulableMissionStatus(mission.status)) {
    throw new MissionSchedulingValidationError(
      "MISSION_NOT_SCHEDULABLE",
      `mission status ${mission.status} is not schedulable (${SCHEDULABLE_MISSION_STATUSES.join("/")} only). No schedule produced.`
    );
  }
  if (Date.parse(nowIso) > Date.parse(mission.validUntil)) {
    throw new MissionSchedulingValidationError(
      "MISSION_EXPIRED",
      "mission validity has expired; expired authority cannot be scheduled as current. No schedule produced."
    );
  }
}

function parseJsonArray(value: unknown): string[] {
  if (Array.isArray(value)) return value.map(String);
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.map(String) : [];
    } catch {
      return [];
    }
  }
  return [];
}

// ─── C1 — plan registration (typed input port) ───

export interface RegisterMissionTaskPlanResult {
  readonly missionId: string;
  readonly planId: string;
  readonly businessId: number;
  readonly planFingerprint: string;
  readonly duplicateClassification: MissionSchedulingDuplicateClassification;
}

export async function registerMissionTaskPlan(
  db: MissionSchedulingStoreExecutor | undefined,
  deps: MissionSchedulingServiceDeps,
  ctx: MissionSchedulingAuthContext,
  rawInput: unknown
): Promise<RegisterMissionTaskPlanResult> {
  const parsed = missionTaskPlanPortSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new MissionSchedulingInputError(
      "PLAN_PORT_MALFORMED",
      `mission-task-plan/v1 port document is malformed: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }
  const plan: MissionTaskPlanPort = parsed.data;
  const mission = await resolveOwnedMission(deps, ctx.userId, plan.missionId);
  const planFingerprint = derivePlanFingerprint({
    tenantUserId: ctx.userId,
    businessId: mission.businessId,
    missionId: plan.missionId,
    planId: plan.planId,
    plan,
  });
  const planHash = sha256Hex(canonicalJson({ v: 1, planDocument: plan }));
  const result = await insertPlanSnapshot(
    {
      userId: ctx.userId,
      businessId: mission.businessId,
      missionId: plan.missionId,
      planId: plan.planId,
      planDocument: plan,
      supportedCapabilities: [...plan.supportedCapabilities].sort(),
      taskIds: plan.tasks.map((task) => task.taskId).sort(),
      planFingerprint,
      planHash,
    },
    db
  );
  return {
    missionId: plan.missionId,
    planId: plan.planId,
    businessId: mission.businessId,
    planFingerprint,
    duplicateClassification: result.duplicateClassification,
  };
}

// ─── C2/C3 — dependency recording with full-graph cycle validation ───

export interface RecordMissionDependencyResult {
  readonly dependency: MissionDependencyEdgeRow;
  readonly duplicateClassification: MissionSchedulingDuplicateClassification;
  readonly graph: { readonly acyclic: true; readonly taskCount: number; readonly edgeCount: number };
}

async function classifyUnknownEndpoint(
  userId: number,
  mission: { missionId: string; businessId: number },
  planId: string,
  endpoint: string,
  which: "predecessor" | "successor",
  db: MissionSchedulingStoreExecutor | undefined
): Promise<never> {
  const scope = await findTaskScopeInTenant(userId, endpoint, db);
  if (scope && scope.businessId !== mission.businessId) {
    throw new MissionSchedulingOwnershipError(
      "CROSS_BUSINESS_DEPENDENCY",
      `dependency ${which} ${endpoint} belongs to a different business.`
    );
  }
  if (scope && scope.missionId !== mission.missionId) {
    throw new MissionSchedulingValidationError(
      "CROSS_MISSION_DEPENDENCY",
      `dependency ${which} ${endpoint} belongs to a different mission.`
    );
  }
  if (scope && scope.planId !== planId) {
    throw new MissionSchedulingValidationError(
      "CROSS_PLAN_DEPENDENCY",
      `dependency ${which} ${endpoint} belongs to plan ${scope.planId}, not ${planId}.`
    );
  }
  throw new MissionSchedulingValidationError(
    which === "predecessor" ? "UNKNOWN_PREDECESSOR_TASK" : "UNKNOWN_SUCCESSOR_TASK",
    `dependency ${which} ${endpoint} is not a task of plan ${planId}.`
  );
}

export async function recordMissionDependency(
  db: MissionSchedulingStoreExecutor | undefined,
  deps: MissionSchedulingServiceDeps,
  ctx: MissionSchedulingAuthContext,
  rawInput: unknown,
  nowIso: string
): Promise<RecordMissionDependencyResult> {
  const parsed = recordMissionDependencySchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new MissionSchedulingInputError(
      "SCHEDULING_INPUT_MALFORMED",
      `dependency declaration is malformed: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }
  const input: RecordMissionDependencyInput = parsed.data;
  const mission = await resolveOwnedMission(deps, ctx.userId, input.missionId);
  const snapshot = await getCurrentPlanSnapshot(ctx.userId, input.missionId, input.planId, db);
  if (!snapshot) {
    throw new MissionSchedulingInputError(
      "UNKNOWN_PLAN",
      `plan ${input.planId} is not registered for mission ${input.missionId}.`
    );
  }
  const taskIds = new Set(parseJsonArray(snapshot.taskIds));
  let { predecessorTaskId, successorTaskId } = input;
  if (input.dependencyType === "MUTUAL_EXCLUSION") {
    const pair =
      predecessorTaskId <= successorTaskId
        ? [predecessorTaskId, successorTaskId]
        : [successorTaskId, predecessorTaskId];
    predecessorTaskId = pair[0];
    successorTaskId = pair[1];
  }
  if (predecessorTaskId === successorTaskId) {
    throw new MissionSchedulingValidationError(
      "SELF_DEPENDENCY",
      `task ${predecessorTaskId} cannot form a ${input.dependencyType} dependency with itself.`
    );
  }
  if (!taskIds.has(predecessorTaskId)) {
    await classifyUnknownEndpoint(ctx.userId, mission, input.planId, predecessorTaskId, "predecessor", db);
  }
  if (!taskIds.has(successorTaskId)) {
    await classifyUnknownEndpoint(ctx.userId, mission, input.planId, successorTaskId, "successor", db);
  }

  const existing = await listDependencies(
    ctx.userId,
    { missionId: input.missionId, planId: input.planId, limit: 1000 },
    db
  );
  for (const row of existing) {
    assertDependencyEvidenceIntegrity(row);
    assertDependencyIdentityIntegrity(row);
  }
  const candidateEdges = [
    ...existing.map((row) => ({
      predecessorTaskId: row.predecessorTaskId,
      successorTaskId: row.successorTaskId,
      dependencyType: row.dependencyType as RecordMissionDependencyInput["dependencyType"],
      hardOrSoft: row.hardOrSoft as RecordMissionDependencyInput["hardOrSoft"],
    })),
    {
      predecessorTaskId,
      successorTaskId,
      dependencyType: input.dependencyType,
      hardOrSoft: input.hardOrSoft,
    },
  ];
  // Full-graph validation including the candidate edge: self/direct/indirect
  // cycles, unknown tasks and size limits all fail closed here.
  const graph = buildDependencyGraph({ taskIds: [...taskIds], edges: candidateEdges });

  const identity = {
    tenantUserId: ctx.userId,
    businessId: mission.businessId,
    missionId: input.missionId,
    planId: input.planId,
    predecessorTaskId,
    successorTaskId,
    dependencyType: input.dependencyType,
    hardOrSoft: input.hardOrSoft,
    source: input.source,
    reason: input.reason ?? null,
  };
  const dependencyId = deriveDependencyId(identity);
  const evidenceHash = deriveDependencyEvidenceHash(identity);
  const result = await insertDependencyEdge(
    {
      dependencyId,
      userId: ctx.userId,
      businessId: mission.businessId,
      missionId: input.missionId,
      planId: input.planId,
      predecessorTaskId,
      successorTaskId,
      dependencyType: input.dependencyType,
      reason: input.reason ?? null,
      hardOrSoft: input.hardOrSoft,
      source: input.source,
      evidenceHash,
    },
    db
  );
  if (result.inserted) {
    await emitSchedulingAudit(db, {
      eventType: "mission_dependency_recorded",
      occurredAt: nowIso,
      userId: ctx.userId,
      source: "system",
      outcome: "succeeded",
      businessId: mission.businessId,
      artifactId: dependencyId,
      metadata: {
        dependencyId,
        missionId: input.missionId,
        planId: input.planId,
        predecessorTaskId,
        successorTaskId,
        dependencyType: input.dependencyType,
        hardOrSoft: input.hardOrSoft,
        source: input.source,
        taskCount: graph.taskIds.length,
        edgeCount: graph.edges.length,
      },
    });
  }
  return {
    dependency: result.row,
    duplicateClassification: result.duplicateClassification,
    graph: { acyclic: true, taskCount: graph.taskIds.length, edgeCount: graph.edges.length },
  };
}

// ─── C5–C9 — deterministic schedule production ───

export interface ProduceMissionScheduleResult {
  readonly schedule: MissionScheduleRow;
  readonly projection: MissionExecutionProjection;
  readonly lifecycle: readonly MissionScheduleLifecycleEventRow[];
  readonly duplicateClassification: MissionSchedulingDuplicateClassification;
}

export async function produceMissionSchedule(
  db: MissionSchedulingStoreExecutor | undefined,
  deps: MissionSchedulingServiceDeps,
  ctx: MissionSchedulingAuthContext,
  rawInput: unknown,
  nowIso: string
): Promise<ProduceMissionScheduleResult> {
  const parsed = produceMissionScheduleSchema.safeParse(rawInput);
  if (!parsed.success) {
    throw new MissionSchedulingInputError(
      "SCHEDULING_INPUT_MALFORMED",
      `schedule request is malformed: ${parsed.error.issues[0]?.message ?? "unknown"}`
    );
  }
  const input: ProduceMissionScheduleInput = parsed.data;
  const mission = await resolveOwnedMission(deps, ctx.userId, input.missionId);
  assertMissionSchedulable(mission, nowIso);
  const snapshot = await getCurrentPlanSnapshot(ctx.userId, input.missionId, input.planId, db);
  if (!snapshot) {
    throw new MissionSchedulingInputError(
      "UNKNOWN_PLAN",
      `plan ${input.planId} is not registered for mission ${input.missionId}.`
    );
  }
  const plan = snapshot.planDocument as unknown as MissionTaskPlanPort;
  const taskIds = new Set(parseJsonArray(snapshot.taskIds));
  const state: MissionSchedulingStatePort = input.executionState ?? {
    portVersion: MISSION_SCHEDULING_STATE_PORT_VERSION,
    completedTaskIds: [],
    succeededTaskIds: [],
  };
  const completed = new Set(state.completedTaskIds);
  const succeeded = new Set(state.succeededTaskIds);
  for (const id of completed) {
    if (!taskIds.has(id)) {
      throw new MissionSchedulingValidationError(
        "EXECUTION_STATE_INVALID",
        `execution state names unknown completed task ${id}.`
      );
    }
  }
  for (const id of succeeded) {
    if (!completed.has(id)) {
      throw new MissionSchedulingValidationError(
        "EXECUTION_STATE_INVALID",
        `succeeded task ${id} is not in completedTaskIds.`
      );
    }
  }

  const edgeRows = await listDependencies(
    ctx.userId,
    { missionId: input.missionId, planId: input.planId, limit: 1000 },
    db
  );
  for (const row of edgeRows) {
    assertDependencyEvidenceIntegrity(row);
    assertDependencyIdentityIntegrity(row);
  }
  const graph = buildDependencyGraph({
    taskIds: [...taskIds],
    edges: edgeRows.map((row) => ({
      predecessorTaskId: row.predecessorTaskId,
      successorTaskId: row.successorTaskId,
      dependencyType: row.dependencyType as RecordMissionDependencyInput["dependencyType"],
      hardOrSoft: row.hardOrSoft as RecordMissionDependencyInput["hardOrSoft"],
    })),
  });
  const graphHash = sha256Hex(
    canonicalJson({
      v: 1,
      tenantUserId: ctx.userId,
      businessId: mission.businessId,
      missionId: input.missionId,
      planId: input.planId,
      taskIds: graph.taskIds,
      edges: graph.edges,
    })
  );

  // Approval evidence: R9-F reads only. Tasks that gate others via
  // REQUIRES_APPROVAL edges, plus tasks whose plan characteristics require
  // approval, must show a current ALLOW — otherwise blocked, never fabricated.
  const approvalRelevant = new Set<string>();
  for (const edge of graph.edges) {
    if (edge.dependencyType === "REQUIRES_APPROVAL" && edge.hardOrSoft === "HARD") {
      approvalRelevant.add(edge.predecessorTaskId);
    }
  }
  for (const task of plan.tasks) {
    if (task.governanceCharacteristics.requiresApproval) approvalRelevant.add(task.taskId);
  }
  const approvalEvidence = new Map<string, boolean>();
  for (const taskId of [...approvalRelevant].sort()) {
    approvalEvidence.set(
      taskId,
      await deps.governance.resolveTaskApproval(ctx.userId, mission.businessId, input.missionId, taskId, nowIso)
    );
  }
  const governanceAvailable = await deps.governance.isAvailable();

  const supportedCapabilities = new Set(parseJsonArray(snapshot.supportedCapabilities));

  // Prior active schedule (if any) for supersession + sequence comparison.
  const priorSchedules = await listSchedules(
    ctx.userId,
    { missionId: input.missionId, planId: input.planId, limit: 100 },
    db
  );
  const priorActive = priorSchedules.find((row) =>
    ["PROPOSED", "VALIDATED", "READY", "BLOCKED"].includes(row.status)
  );
  const taskById = new Map(plan.tasks.map((task) => [task.taskId, task]));
  const sideEffectSignature = (taskId: string): string | null => {
    const task = taskById.get(taskId);
    if (!task) return null;
    const g = task.governanceCharacteristics;
    return `${taskId}:${g.sideEffectClass}:${g.financialExposure ? "F" : "-"}:${g.irreversible ? "I" : "-"}`;
  };
  const priorSideEffectSequence = priorActive
    ? (priorActive.orderedTaskIds as unknown as string[])
        .map(sideEffectSignature)
        .filter((value): value is string => value !== null)
    : null;

  const core: ScheduleCoreOutput = produceScheduleCore({
    tenantUserId: ctx.userId,
    businessId: mission.businessId,
    missionId: input.missionId,
    planId: input.planId,
    planFingerprint: snapshot.planFingerprint,
    missionStatus: mission.status,
    missionValidFrom: mission.validFrom,
    missionValidUntil: mission.validUntil,
    tasks: plan.tasks,
    graph,
    completedTaskIds: completed,
    succeededTaskIds: succeeded,
    approvalEvidence,
    supportedCapabilities,
    nowIso,
    priorSideEffectSequence,
  });

  const approvalEvidenceHash = deriveEvidenceSetHash({
    approvals: [...approvalEvidence.entries()]
      .map(([taskId, satisfied]) => ({ taskId, satisfied }))
      .sort((a, b) => (a.taskId < b.taskId ? -1 : 1)),
    governanceAvailable,
  });
  const capabilityEvidenceHash = deriveEvidenceSetHash({
    supportedCapabilities: [...supportedCapabilities].sort(),
  });

  const identityInput = {
    tenantUserId: ctx.userId,
    businessId: mission.businessId,
    missionId: input.missionId,
    planId: input.planId,
    planFingerprint: snapshot.planFingerprint,
    graphHash,
    stateViewHash: core.stateViewHash,
    approvalEvidenceHash,
    capabilityEvidenceHash,
    orderedTaskIds: core.orderedTaskIds,
    parallelGroups: core.parallelGroups,
    blockingStates: core.blockingStates,
    readinessHash: core.readinessHash,
    validUntil: core.validUntil,
  };
  const scheduleId = deriveScheduleId(identityInput);
  const scheduleFingerprint = deriveScheduleFingerprint(identityInput);

  const existing = await getScheduleByScheduleId(ctx.userId, scheduleId, db);
  if (existing) {
    // Same scheduleId replayed: identical material converges (idempotent
    // replay, zero new effects). Drifted material under the same identity is
    // conflicting replay and fails closed.
    if (existing.scheduleFingerprint !== scheduleFingerprint) {
      throw new MissionSchedulingIdentityConflictError(
        "SCHEDULING_REPLAY_CONFLICT",
        `schedule ${scheduleId} exists with a conflicting fingerprint; replay drift fails closed.`
      );
    }
    const lifecycle = await listScheduleLifecycleEvents(ctx.userId, scheduleId, db);
    return {
      schedule: existing,
      projection: buildMissionExecutionProjection(existing, edgeRows, lifecycle, snapshot, { governanceAvailable }),
      lifecycle,
      duplicateClassification: "idempotent_replay",
    };
  }

  // Supersede the prior active schedule (lineage preserved via msl1 facts).
  if (priorActive) {
    await transitionScheduleStatus(ctx.userId, priorActive.scheduleId, priorActive.version, "SUPERSEDED", db);
    const supersessionFactId = deriveScheduleLifecycleEventId({
      scheduleId: priorActive.scheduleId,
      lifecycleType: "supersession",
      targetStatus: "SUPERSEDED",
      successorScheduleId: scheduleId,
      occurredAt: nowIso,
      reasonCode: "SUPERSEDED_BY_SUCCESSOR",
    });
    const supersessionFact = await insertScheduleLifecycleEvent(
      {
        lifecycleEventId: supersessionFactId,
        userId: ctx.userId,
        scheduleId: priorActive.scheduleId,
        lifecycleType: "supersession",
        targetStatus: "SUPERSEDED",
        successorScheduleId: scheduleId,
        sourceIdentity: null,
        occurredAt: nowIso,
        reasonCode: "SUPERSEDED_BY_SUCCESSOR",
      },
      db
    );
    if (supersessionFact.inserted) {
      await emitSchedulingAudit(db, {
        eventType: "mission_schedule_lifecycle",
        occurredAt: nowIso,
        userId: ctx.userId,
        source: "system",
        outcome: "succeeded",
        artifactId: priorActive.scheduleId,
        metadata: {
          scheduleId: priorActive.scheduleId,
          lifecycleType: "supersession",
          targetStatus: "SUPERSEDED",
          successorScheduleId: scheduleId,
        },
      });
    }
  }

  const status = core.blockingStates.length === 0 ? "READY" : "BLOCKED";
  const governanceRequirements = {
    requiresApproval: core.requiresApproval,
    reasonCodes: core.governanceReasonCodes,
    authorityScope: "RECOMMENDATION_ONLY",
    consumptionGate: "R9-F assertMissionActionConsumable (downstream-owned; scheduling never invokes it)",
    governanceAuthorityUnavailable: !governanceAvailable,
  };

  const inserted = await insertSchedule(
    {
      scheduleId,
      userId: ctx.userId,
      businessId: mission.businessId,
      missionId: input.missionId,
      planId: input.planId,
      planFingerprint: snapshot.planFingerprint,
      status,
      orderedTaskIds: [...core.orderedTaskIds],
      parallelGroups: core.parallelGroups.map((group) => [...group]),
      blockingStates: core.blockingStates.map((report) => ({
        taskId: report.taskId,
        readiness: report.readiness,
        reasons: [...report.reasons],
      })),
      dependencyRefs: edgeRows.map((row) => row.dependencyId).sort(),
      governanceRequirements,
      riskClass: core.riskClass,
      requiresApproval: core.requiresApproval,
      graphHash,
      stateViewHash: core.stateViewHash,
      readinessHash: core.readinessHash,
      approvalEvidenceHash,
      capabilityEvidenceHash,
      scheduleFingerprint,
      validFrom: nowIso,
      validUntil: core.validUntil,
      supersedesScheduleId: priorActive?.scheduleId ?? null,
      producedAt: nowIso,
      version: 1,
    },
    db
  );

  const creationFactId = deriveScheduleLifecycleEventId({
    scheduleId,
    lifecycleType: "creation",
    targetStatus: "PROPOSED",
    successorScheduleId: null,
    occurredAt: nowIso,
    reasonCode: "GRAPH_VALIDATED",
  });
  const validationFactId = deriveScheduleLifecycleEventId({
    scheduleId,
    lifecycleType: "validation",
    targetStatus: status,
    successorScheduleId: null,
    occurredAt: nowIso,
    reasonCode: status === "READY" ? "ALL_TASKS_READY" : "TASKS_BLOCKED",
  });
  await insertScheduleLifecycleEvent(
    {
      lifecycleEventId: creationFactId,
      userId: ctx.userId,
      scheduleId,
      lifecycleType: "creation",
      targetStatus: "PROPOSED",
      successorScheduleId: null,
      sourceIdentity: null,
      occurredAt: nowIso,
      reasonCode: "GRAPH_VALIDATED",
    },
    db
  );
  await insertScheduleLifecycleEvent(
    {
      lifecycleEventId: validationFactId,
      userId: ctx.userId,
      scheduleId,
      lifecycleType: "validation",
      targetStatus: status,
      successorScheduleId: null,
      sourceIdentity: null,
      occurredAt: nowIso,
      reasonCode: status === "READY" ? "ALL_TASKS_READY" : "TASKS_BLOCKED",
    },
    db
  );
  await emitSchedulingAudit(db, {
    eventType: "mission_schedule_committed",
    occurredAt: nowIso,
    userId: ctx.userId,
    source: "system",
    outcome: "succeeded",
    businessId: mission.businessId,
    artifactId: scheduleId,
    metadata: {
      scheduleId,
      missionId: input.missionId,
      planId: input.planId,
      status,
      riskClass: core.riskClass,
      requiresApproval: core.requiresApproval,
      governanceReasonCodes: core.governanceReasonCodes,
      orderedCount: core.orderedTaskIds.length,
      blockedCount: core.blockingStates.length,
      supersedesScheduleId: priorActive?.scheduleId ?? null,
    },
  });

  const lifecycle = await listScheduleLifecycleEvents(ctx.userId, scheduleId, db);
  return {
    schedule: inserted.row,
    projection: buildMissionExecutionProjection(inserted.row, edgeRows, lifecycle, snapshot, { governanceAvailable }),
    lifecycle,
    duplicateClassification: inserted.duplicateClassification,
  };
}

// ─── Reads ───

export interface GetMissionScheduleResult {
  readonly schedule: MissionScheduleRow;
  readonly lifecycle: readonly MissionScheduleLifecycleEventRow[];
  readonly projection: MissionExecutionProjection;
}

export async function getMissionSchedule(
  db: MissionSchedulingStoreExecutor | undefined,
  deps: MissionSchedulingServiceDeps,
  ctx: MissionSchedulingAuthContext,
  scheduleId: string
): Promise<GetMissionScheduleResult> {
  const row = await getScheduleByScheduleId(ctx.userId, scheduleId, db);
  if (!row) {
    throw new MissionSchedulingError(
      "SCHEDULE_NOT_FOUND",
      `schedule ${scheduleId} not found for the authenticated tenant.`
    );
  }
  const lifecycle = await listScheduleLifecycleEvents(ctx.userId, scheduleId, db);
  const edges = await listDependencies(ctx.userId, { missionId: row.missionId, planId: row.planId, limit: 1000 }, db);
  for (const edge of edges) assertDependencyEvidenceIntegrity(edge);
  const snapshot = await getCurrentPlanSnapshot(ctx.userId, row.missionId, row.planId, db);
  const governanceAvailable = await deps.governance.isAvailable();
  return {
    schedule: row,
    lifecycle,
    projection: buildMissionExecutionProjection(row, edges, lifecycle, snapshot, { governanceAvailable }),
  };
}

// ─── Lifecycle operations ───

export async function cancelMissionSchedule(
  db: MissionSchedulingStoreExecutor | undefined,
  ctx: MissionSchedulingAuthContext,
  input: { scheduleId: string; expectedVersion: number },
  nowIso: string
) {
  const row = await getScheduleByScheduleId(ctx.userId, input.scheduleId, db);
  if (!row) {
    throw new MissionSchedulingError("SCHEDULE_NOT_FOUND", `schedule ${input.scheduleId} not found.`);
  }
  if (!["PROPOSED", "VALIDATED", "READY", "BLOCKED"].includes(row.status)) {
    throw new MissionSchedulingValidationError(
      "SCHEDULE_NOT_CANCELLABLE",
      `schedule status ${row.status} cannot be cancelled (terminal/superseded).`
    );
  }
  const updated = await transitionScheduleStatus(ctx.userId, input.scheduleId, input.expectedVersion, "CANCELLED", db);
  const factId = deriveScheduleLifecycleEventId({
    scheduleId: input.scheduleId,
    lifecycleType: "cancellation",
    targetStatus: "CANCELLED",
    successorScheduleId: null,
    occurredAt: nowIso,
    reasonCode: "OPERATOR_CANCELLED",
  });
  await insertScheduleLifecycleEvent(
    {
      lifecycleEventId: factId,
      userId: ctx.userId,
      scheduleId: input.scheduleId,
      lifecycleType: "cancellation",
      targetStatus: "CANCELLED",
      successorScheduleId: null,
      sourceIdentity: null,
      occurredAt: nowIso,
      reasonCode: "OPERATOR_CANCELLED",
    },
    db
  );
  await emitSchedulingAudit(db, {
    eventType: "mission_schedule_lifecycle",
    occurredAt: nowIso,
    userId: ctx.userId,
    source: "system",
    outcome: "succeeded",
    artifactId: input.scheduleId,
    metadata: {
      scheduleId: input.scheduleId,
      lifecycleType: "cancellation",
      targetStatus: "CANCELLED",
      successorScheduleId: null,
    },
  });
  return { schedule: updated };
}

export interface SweepMissionScheduleExpiryResult {
  readonly staledScheduleIds: string[];
}

export async function sweepMissionScheduleExpiry(
  db: MissionSchedulingStoreExecutor | undefined,
  ctx: MissionSchedulingAuthContext,
  input: { businessId?: number } | undefined,
  nowIso: string
): Promise<SweepMissionScheduleExpiryResult> {
  const rows = await listSchedules(ctx.userId, { limit: 500 }, db);
  const staled: string[] = [];
  for (const row of rows) {
    if (!["PROPOSED", "VALIDATED", "READY", "BLOCKED"].includes(row.status)) continue;
    if (input?.businessId !== undefined && Number(row.businessId) !== input.businessId) continue;
    if (Date.parse(nowIso) <= Date.parse(row.validUntil)) continue;
    await transitionScheduleStatus(ctx.userId, row.scheduleId, row.version, "STALE", db);
    const factId = deriveScheduleLifecycleEventId({
      scheduleId: row.scheduleId,
      lifecycleType: "staleness",
      targetStatus: "STALE",
      successorScheduleId: null,
      occurredAt: nowIso,
      reasonCode: "SCHEDULE_EXPIRED",
    });
    await insertScheduleLifecycleEvent(
      {
        lifecycleEventId: factId,
        userId: ctx.userId,
        scheduleId: row.scheduleId,
        lifecycleType: "staleness",
        targetStatus: "STALE",
        successorScheduleId: null,
        sourceIdentity: null,
        occurredAt: nowIso,
        reasonCode: "SCHEDULE_EXPIRED",
      },
      db
    );
    await emitSchedulingAudit(db, {
      eventType: "mission_schedule_lifecycle",
      occurredAt: nowIso,
      userId: ctx.userId,
      source: "system",
      outcome: "succeeded",
      artifactId: row.scheduleId,
      metadata: {
        scheduleId: row.scheduleId,
        lifecycleType: "staleness",
        targetStatus: "STALE",
        successorScheduleId: null,
      },
    });
    staled.push(row.scheduleId);
  }
  return { staledScheduleIds: staled };
}

export type { MissionDependencyEdgeRow };
