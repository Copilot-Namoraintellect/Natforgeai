// ─── R9-B Mission Planning — service ───
//
// Deterministic, rule-first planning over frozen R9-A mission authority.
// Owns plan formation, validation, revision, readiness, cancellation and the
// read-only scheduling projection. Never schedules, never executes, never
// invokes providers, never moves budget, never decides governance, never
// mutates any upstream authority. Session userId anchors every read/write.

import { createAuditEvent } from "../audit/audit-event";
import { persistAuditEvent, type AuditDbExecutor } from "../audit/audit-store";
import {
  MAX_UNRESOLVED_ITEMS,
  MISSION_PLANNING_ENGINE_VERSION,
  canonicalJson,
  fail,
  type CreatePlanInput,
  type PlanReasonCode,
  type PlanStatus,
} from "./mission-planning-contract";
import {
  deriveConstraintSetFingerprint,
  deriveListFingerprint,
  derivePlanFingerprint,
  derivePlanId,
  derivePlanLifecycleEventId,
  derivePlanScopeKey,
  deriveTaskFingerprint,
  deriveTaskId,
  deriveTaskSetFingerprint,
} from "./mission-planning-identity";
import {
  isMissionPlanningConsumable,
  type MissionAuthorityProjection,
  type MissionAuthorityReadPort,
} from "./mission-planning-mission-seam";
import {
  TASK_TEMPLATES,
  classifyCapabilities,
  deriveTaskObjective,
  deriveTaskTypeSequence,
  isTaskProhibited,
  type MissionConstraintRecord,
} from "./mission-planning-templates";
import {
  getPlan,
  insertPlan,
  insertPlanLifecycleEvent,
  insertTask,
  listPlanLifecycleRows,
  listPlanRows,
  listTaskRows,
  updatePlanStatus,
  updatePlanSupersedes,
  updateTaskStatus,
  type MissionPlanRecord,
  type MissionPlanTaskRecord,
  type MissionPlanningStoreExecutor,
} from "./mission-planning-store";
import {
  buildSchedulingProjection,
  validateSchedulingProjection,
  type MissionPlanningToSchedulingProjection,
} from "./mission-planning-projection";

export interface MissionPlanningDeps {
  /** Frozen R9-A mission authority read port — absence fails closed. */
  readonly missionAuthority: MissionAuthorityReadPort;
  /** Injected clock (deterministic in tests). Defaults to system time. */
  readonly now?: () => Date;
}

function resolveNow(deps: MissionPlanningDeps): Date {
  return deps.now ? deps.now() : new Date();
}

function asAuditExecutor(executor: MissionPlanningStoreExecutor): AuditDbExecutor {
  return executor as unknown as AuditDbExecutor;
}

function parseJson(value: unknown): unknown {
  if (typeof value === "string") {
    try {
      return JSON.parse(value);
    } catch {
      return null;
    }
  }
  return value;
}

function asConstraintRecords(raw: readonly unknown[]): MissionConstraintRecord[] {
  const out: MissionConstraintRecord[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    out.push({
      constraintType: String(r.constraintType ?? ""),
      statement: String(r.statement ?? ""),
      referenceValue: typeof r.referenceValue === "string" ? r.referenceValue : null,
      amountMinorUnits: typeof r.amountMinorUnits === "number" ? r.amountMinorUnits : null,
      currency: typeof r.currency === "string" ? r.currency : null,
    });
  }
  return out;
}

function isTerminalPlanStatus(status: string): boolean {
  return status === "SUPERSEDED" || status === "CANCELLED" || status === "INVALIDATED";
}

/** Advisory-wording injection suspicion (inert bounded text only). */
export function detectInjectionSuspicion(text: string): boolean {
  const patterns = [
    /ignore\s+(all\s+)?(previous|prior|above)\s+instructions/i,
    / disregard /i,
    /\bdeliver\b.{0,40}\b(consequences|harm|damage)\b/i,
    /\byou\s+(are|will\s+become)\b/i,
    /\b(system\s+prompt|jailbreak|DAN\b)/i,
  ];
  return patterns.some((p) => p.test(text));
}

// ─── Mission resolution + eligibility (fail closed) ───

async function resolveEligibleMission(input: {
  deps: MissionPlanningDeps;
  userId: number;
  missionId: string;
}): Promise<{ projection: MissionAuthorityProjection; material: import("./mission-planning-mission-seam").MissionAuthorityMaterial; constraints: MissionConstraintRecord[] }> {
  const port = input.deps.missionAuthority;
  if (!port) fail("MISSION_AUTHORITY_UNAVAILABLE", "mission authority read port is not bound");
  const read = await port.getMissionForPlanning({
    userId: input.userId,
    missionId: input.missionId,
    now: resolveNow(input.deps),
  });
  if (!read) fail("MISSION_NOT_FOUND", `mission ${input.missionId} not found for tenant`);
  const { projection, material } = read;
  if (!isMissionPlanningConsumable(projection)) {
    fail(
      "MISSION_NOT_ELIGIBLE",
      `mission ${input.missionId} is not planning-consumable (status=${projection.status}, freshness=${projection.freshness}, scope=${projection.governanceAuthorityScope})`
    );
  }
  // Ownership: business scope must be exactly the owning business.
  if (projection.scope.businessScope !== projection.businessId) {
    fail("MISSION_SCOPE_VIOLATION", "mission business scope does not match the owning business");
  }
  const owned = await port.verifyBusinessOwnership({
    userId: input.userId,
    businessId: projection.businessId,
  });
  if (!owned) fail("MISSION_NOT_FOUND", "mission business is unknown to the tenant");
  // Constraint tamper check: verbatim set must re-derive the bound fingerprint.
  const constraints = asConstraintRecords(projection.constraints);
  const constraintSetFingerprint = deriveConstraintSetFingerprint(constraints);
  if (constraintSetFingerprint !== material.constraintSetFingerprint) {
    fail("MISSION_CONSTRAINT_VIOLATION", "mission constraint set does not re-derive the bound fingerprint");
  }
  return { projection, material, constraints };
}

// ─── Plan views ───

export interface MissionPlanTaskView {
  readonly taskId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly missionId: string;
  readonly businessId: number;
  readonly taskType: string;
  readonly taskSequence: number;
  readonly taskObjective: string;
  readonly objectiveWordingDraft: string | null;
  readonly requiredInputs: readonly unknown[];
  readonly expectedOutputs: readonly unknown[];
  readonly requiredCapabilities: readonly unknown[];
  readonly constraints: readonly unknown[];
  readonly preconditions: readonly unknown[];
  readonly postconditions: readonly unknown[];
  readonly governanceClass: string;
  readonly sideEffectClass: string;
  readonly executionClass: string;
  readonly capabilityStatus: string;
  readonly governanceCharacteristics: Record<string, unknown>;
  readonly status: string;
  readonly taskFingerprint: string;
}

export interface MissionPlanView {
  readonly planId: string;
  readonly planVersion: number;
  readonly missionId: string;
  readonly businessId: number;
  readonly missionAuthorityVersion: string;
  readonly boundMissionVersion: number;
  readonly planScopeKey: string;
  readonly taskIds: readonly string[];
  readonly completenessStatus: string;
  readonly status: PlanStatus;
  readonly freshness: "current" | "stale";
  readonly validFrom: string;
  readonly validUntil: string;
  readonly supersedesPlanId: string | null;
  readonly planFingerprint: string;
  readonly modelAssistanceFlagged: boolean;
  readonly missionConstraints: readonly unknown[];
  readonly planningAssumptions: readonly unknown[];
  readonly unresolvedItems: readonly unknown[];
  readonly missionObjective: {
    readonly objectiveId: string;
    readonly objectiveStatement: string;
    readonly objectiveType: string;
  };
  readonly version: number;
  readonly tasks: readonly MissionPlanTaskView[];
}

function toTaskView(row: MissionPlanTaskRecord): MissionPlanTaskView {
  return {
    taskId: row.taskId,
    planId: row.planId,
    planVersion: row.planVersion,
    missionId: row.missionId,
    businessId: row.businessId,
    taskType: row.taskType,
    taskSequence: row.taskSequence,
    taskObjective: row.taskObjective,
    objectiveWordingDraft: row.objectiveWordingDraft,
    requiredInputs: (parseJson(row.requiredInputs) as unknown[]) ?? [],
    expectedOutputs: (parseJson(row.expectedOutputs) as unknown[]) ?? [],
    requiredCapabilities: (parseJson(row.requiredCapabilities) as unknown[]) ?? [],
    constraints: (parseJson(row.constraints) as unknown[]) ?? [],
    preconditions: (parseJson(row.preconditions) as unknown[]) ?? [],
    postconditions: (parseJson(row.postconditions) as unknown[]) ?? [],
    governanceClass: row.governanceClass,
    sideEffectClass: row.sideEffectClass,
    executionClass: row.executionClass,
    capabilityStatus: row.capabilityStatus,
    governanceCharacteristics:
      (parseJson(row.governanceCharacteristics) as Record<string, unknown>) ?? {},
    status: row.status,
    taskFingerprint: row.taskFingerprint,
  };
}

/** Effective plan status: upstream mission demotions apply on read. */
function effectivePlanStatus(input: {
  plan: MissionPlanRecord;
  missionStatus: string | null;
  missionFreshness: "current" | "stale" | null;
  nowMs: number;
}): PlanStatus {
  const stored = input.plan.status as PlanStatus;
  if (isTerminalPlanStatus(stored)) return stored;
  const expired = Date.parse(input.plan.validUntil) < input.nowMs;
  if (input.missionStatus === "INVALIDATED") return "INVALIDATED";
  if (input.missionStatus === "BLOCKED") return "BLOCKED";
  if (input.missionStatus === "CANCELLED") return "CANCELLED";
  if (input.missionStatus === "SUPERSEDED") return "SUPERSEDED";
  if (expired || input.missionFreshness === "stale") return "STALE";
  return stored;
}

async function toPlanView(input: {
  deps: MissionPlanningDeps;
  executor: MissionPlanningStoreExecutor;
  plan: MissionPlanRecord;
  mission: MissionAuthorityProjection | null;
  nowMs: number;
}): Promise<MissionPlanView> {
  const taskRows = await listTaskRows(input.executor, input.plan.userId, input.plan.planId);
  const mission = input.mission;
  const status = effectivePlanStatus({
    plan: input.plan,
    missionStatus: mission ? mission.status : null,
    missionFreshness: mission ? mission.freshness : null,
    nowMs: input.nowMs,
  });
  return {
    planId: input.plan.planId,
    planVersion: input.plan.planVersion,
    missionId: input.plan.missionId,
    businessId: input.plan.businessId,
    missionAuthorityVersion: input.plan.missionAuthorityVersion,
    boundMissionVersion: input.plan.boundMissionVersion,
    planScopeKey: input.plan.planScopeKey,
    taskIds: (parseJson(input.plan.taskIds) as string[]) ?? [],
    completenessStatus: input.plan.completenessStatus,
    status,
    freshness: status === "STALE" ? "stale" : "current",
    validFrom: input.plan.validFrom,
    validUntil: input.plan.validUntil,
    supersedesPlanId: input.plan.supersedesPlanId,
    planFingerprint: input.plan.planFingerprint,
    modelAssistanceFlagged: input.plan.modelAssistanceFlagged,
    missionConstraints: (parseJson(input.plan.missionConstraints) as unknown[]) ?? [],
    planningAssumptions: (parseJson(input.plan.planningAssumptions) as unknown[]) ?? [],
    unresolvedItems: (parseJson(input.plan.unresolvedItems) as unknown[]) ?? [],
    missionObjective: mission
      ? {
          objectiveId: mission.objectiveId,
          objectiveStatement: mission.objectiveStatement,
          objectiveType: mission.objectiveType,
        }
      : { objectiveId: "", objectiveStatement: "", objectiveType: "" },
    version: input.plan.version,
    tasks: taskRows.map(toTaskView),
  };
}

async function resolveMissionProjection(input: {
  deps: MissionPlanningDeps;
  userId: number;
  missionId: string;
}): Promise<MissionAuthorityProjection | null> {
  const port = input.deps.missionAuthority;
  if (!port) return null;
  const read = await port.getMissionForPlanning({
    userId: input.userId,
    missionId: input.missionId,
    now: resolveNow(input.deps),
  });
  return read ? read.projection : null;
}

// ─── Plan formation (B1–B7) ───

export async function createPlanForUser(input: {
  userId: number;
  input: CreatePlanInput;
  deps: MissionPlanningDeps;
  executor: MissionPlanningStoreExecutor;
}): Promise<{ plan: MissionPlanView; convergence: "created" | "idempotent_replay" }> {
  const now = resolveNow(input.deps);
  const nowMs = now.getTime();
  const { projection, material, constraints } = await resolveEligibleMission({
    deps: input.deps,
    userId: input.userId,
    missionId: input.input.missionId,
  });

  const planScopeKey = derivePlanScopeKey(material.scopeKey);
  const constraintSetFingerprint = deriveConstraintSetFingerprint(constraints);

  // Rule-first decomposition (B3) + closed model-assistance boundary (B4).
  let sequence = deriveTaskTypeSequence(projection.missionType, constraints);
  const unresolved: Array<Record<string, unknown>> = [];
  let modelAssistanceFlagged = false;

  const draftWording = input.input.modelAssistance?.draftWording;
  if (draftWording) {
    modelAssistanceFlagged = detectInjectionSuspicion(draftWording);
  }
  const proposed = input.input.modelAssistance?.proposedTaskTypes ?? [];
  for (const proposedType of proposed) {
    const template = TASK_TEMPLATES[proposedType];
    if (!template) {
      fail("UNKNOWN_TASK_TYPE", `model-proposed task type ${String(proposedType)} is outside the closed vocabulary`);
    }
    if (sequence.includes(proposedType)) continue; // already derived by rules
    const prohibition = isTaskProhibited(proposedType, constraints);
    if (prohibition.prohibited) {
      unresolved.push({
        itemType: proposedType,
        description: `Model-proposed task ${proposedType} prohibited by mission constraint`,
        reasonCode: "PROHIBITED_BY_MISSION_CONSTRAINT",
        blocking: false,
      });
      continue;
    }
    const capabilityStatus = classifyCapabilities(template.requiredCapabilities);
    if (capabilityStatus === "SUPPORTED" || capabilityStatus === "CONDITIONALLY_SUPPORTED") {
      sequence = [...sequence, proposedType];
    } else {
      unresolved.push({
        itemType: proposedType,
        description: `Model-proposed task ${proposedType} requires unavailable capability (${capabilityStatus})`,
        reasonCode: "MODEL_PROPOSAL_REJECTED",
        blocking: false,
      });
    }
  }

  // Build task specs; prohibited / infeasible work becomes unresolved items.
  // Specs carry everything except identity — taskIds bind the final planId,
  // and the planId binds the task-set fingerprint (no circular identity).
  interface TaskSpec {
    readonly taskType: (typeof sequence)[number];
    readonly taskObjective: string;
    readonly template: (typeof TASK_TEMPLATES)[keyof typeof TASK_TEMPLATES];
    readonly capabilityStatus: "SUPPORTED" | "CONDITIONALLY_SUPPORTED";
    readonly executionClass: string;
    readonly governanceClass: string;
    readonly objectiveWordingDraft: string | null;
  }
  const taskSpecs: TaskSpec[] = [];
  let wordingDraftConsumed = false;
  for (let i = 0; i < sequence.length; i++) {
    const taskType = sequence[i];
    const prohibition = isTaskProhibited(taskType, constraints);
    if (prohibition.prohibited) {
      unresolved.push({
        itemType: taskType,
        description: `Task ${taskType} prohibited by mission constraint (${String(
          prohibition.matchedConstraint?.statement ?? ""
        ).slice(0, 120)})`,
        reasonCode: "PROHIBITED_BY_MISSION_CONSTRAINT",
        blocking: false,
      });
      continue;
    }
    const template = TASK_TEMPLATES[taskType];
    const capabilityStatus = classifyCapabilities(template.requiredCapabilities);
    if (capabilityStatus === "UNRESOLVED" || capabilityStatus === "UNSUPPORTED") {
      unresolved.push({
        itemType: taskType,
        description: `Task ${taskType} requires unavailable capability (${capabilityStatus})`,
        reasonCode: "UNSUPPORTED_CAPABILITY",
        blocking: false,
      });
      continue;
    }
    const taskObjective = deriveTaskObjective({
      taskType,
      missionId: projection.missionId,
      missionType: projection.missionType,
      objectiveType: projection.objectiveType,
      planScopeKey,
    });
    const requiresProvider =
      capabilityStatus === "CONDITIONALLY_SUPPORTED" &&
      template.requiredCapabilities.some(
        (cap) =>
          cap === "social_publishing" ||
          cap === "email_messaging" ||
          cap === "video_generation" ||
          cap === "market_research" ||
          cap === "budget_reallocation"
      );
    const executionClass = requiresProvider
      ? "REQUIRES_PROVIDER_AVAILABILITY"
      : template.executionClass;
    const governanceClass =
      constraints.some((c) => c.constraintType === "HUMAN_REVIEW_REQUIRED") &&
      template.sideEffectClass !== "NONE"
        ? "HUMAN_REVIEW_REQUIRED"
        : template.governanceClass;
    const attachDraft =
      !wordingDraftConsumed && draftWording ? draftWording.slice(0, 500) : null;
    if (attachDraft) wordingDraftConsumed = true;
    taskSpecs.push({
      taskType,
      taskObjective,
      template,
      capabilityStatus,
      executionClass,
      governanceClass,
      objectiveWordingDraft: attachDraft,
    });
  }

  // Plan identity binds mission + authority version + plan version + scope +
  // task set + constraints. Convergence rule (contract §3): when a non-
  // terminal plan already exists for this mission on the identical
  // authoritative basis, the request converges to it (idempotent_replay) —
  // a plain duplicate create never mints a new version. Only an explicit
  // revision (predecessor superseded first) or changed authority material
  // advances the version.
  const existingPlans = await listPlanRows(input.executor, input.userId, {
    missionId: projection.missionId,
  });
  const taskIdentityCores = taskSpecs.map((s) => ({
    taskType: s.taskType,
    taskObjective: s.taskObjective,
    inputsFingerprint: deriveListFingerprint(s.template.requiredInputs),
    outputsFingerprint: deriveListFingerprint(s.template.expectedOutputs),
    constraintsFingerprint: constraintSetFingerprint,
  }));
  const taskSetFingerprint = deriveTaskSetFingerprint(taskIdentityCores);
  const activeExisting = existingPlans.filter((p) => !isTerminalPlanStatus(p.status));
  if (
    activeExisting.length > 0 &&
    activeExisting.every((p) => p.missionAuthorityVersion !== material.missionFingerprint)
  ) {
    // The mission re-materialised under the same identity — tampering or
    // authority drift. Legitimate change is governed supersession (a new
    // mis1:), never an in-place edit; planning fails closed.
    fail(
      "PLAN_MISSION_AUTHORITY_DRIFT",
      "mission material fingerprint drifted under the same mission identity"
    );
  }
  const matchingBasis = activeExisting.filter(
    (p) =>
      p.taskSetFingerprint === taskSetFingerprint &&
      p.constraintSetFingerprint === constraintSetFingerprint &&
      p.missionAuthorityVersion === material.missionFingerprint
  );
  if (matchingBasis.length > 0) {
    const existing = matchingBasis.sort((a, b) => b.planVersion - a.planVersion)[0];
    // Replay must reproduce the exact stored material under the same anchor;
    // a different fingerprint under the same basis is a conflicting replay.
    const replayPlanId = derivePlanId({
      userId: input.userId,
      businessId: projection.businessId,
      missionId: projection.missionId,
      missionAuthorityVersion: material.missionFingerprint,
      planVersion: existing.planVersion,
      planScopeKey,
      taskSetFingerprint,
      constraintSetFingerprint,
    });
    if (replayPlanId !== existing.planId) {
      fail("PLAN_REPLAY_CONFLICT", `plan ${existing.planId} anchor diverged under replay`);
    }
    const replayFingerprint = derivePlanFingerprint({
      planId: existing.planId,
      missionId: projection.missionId,
      missionAuthorityVersion: material.missionFingerprint,
      taskSetFingerprint,
      constraintSetFingerprint,
      unresolvedItemsFingerprint: deriveListFingerprint(unresolved.slice(0, MAX_UNRESOLVED_ITEMS).map((u) => canonicalJson(u))),
    });
    if (replayFingerprint !== existing.planFingerprint) {
      fail(
        "PLAN_REPLAY_CONFLICT",
        `plan ${existing.planId} exists with a different material fingerprint — conflicting replay`
      );
    }
    const mission = await resolveMissionProjection({
      deps: input.deps,
      userId: input.userId,
      missionId: existing.missionId,
    });
    return {
      plan: await toPlanView({
        deps: input.deps,
        executor: input.executor,
        plan: existing,
        mission,
        nowMs,
      }),
      convergence: "idempotent_replay",
    };
  }
  const planVersion = existingPlans.reduce((max, p) => Math.max(max, p.planVersion), 0) + 1;
  const planId = derivePlanId({
    userId: input.userId,
    businessId: projection.businessId,
    missionId: projection.missionId,
    missionAuthorityVersion: material.missionFingerprint,
    planVersion,
    planScopeKey,
    taskSetFingerprint,
    constraintSetFingerprint,
  });

  // Task identities bind the final planId (contract §3).
  const boundedTaskRows: MissionPlanTaskRecord[] = taskSpecs.map((s, idx) => {
    const taskId = deriveTaskId({
      userId: input.userId,
      businessId: projection.businessId,
      missionId: projection.missionId,
      planId,
      taskType: s.taskType,
      taskObjective: s.taskObjective,
      inputsFingerprint: deriveListFingerprint(s.template.requiredInputs),
      outputsFingerprint: deriveListFingerprint(s.template.expectedOutputs),
      constraintsFingerprint: constraintSetFingerprint,
    });
    const taskFingerprint = deriveTaskFingerprint({
      taskId,
      taskType: s.taskType,
      taskObjective: s.taskObjective,
      requiredInputs: [...s.template.requiredInputs],
      expectedOutputs: [...s.template.expectedOutputs],
      requiredCapabilities: [...s.template.requiredCapabilities],
      constraintsFingerprint: constraintSetFingerprint,
      preconditions: s.template.preconditions.map((p) => ({ ...p })),
      postconditions: s.template.postconditions.map((p) => ({ ...p })),
      governanceClass: s.governanceClass,
      sideEffectClass: s.template.sideEffectClass,
      executionClass: s.executionClass,
      capabilityStatus: s.capabilityStatus,
    });
    return {
      taskId,
      planId,
      planVersion: 0,
      userId: input.userId,
      businessId: projection.businessId,
      missionId: projection.missionId,
      taskType: s.taskType,
      taskSequence: idx + 1,
      taskObjective: s.taskObjective,
      objectiveWordingDraft: s.objectiveWordingDraft,
      requiredInputs: [...s.template.requiredInputs],
      expectedOutputs: [...s.template.expectedOutputs],
      requiredCapabilities: [...s.template.requiredCapabilities],
      constraints: constraints.map((c) => ({ ...c })),
      preconditions: s.template.preconditions.map((p) => ({ ...p })),
      postconditions: s.template.postconditions.map((p) => ({ ...p })),
      governanceClass: s.governanceClass,
      sideEffectClass: s.template.sideEffectClass,
      executionClass: s.executionClass,
      capabilityStatus: s.capabilityStatus,
      governanceCharacteristics: { ...s.template.characteristics },
      status:
        s.governanceClass === "HUMAN_REVIEW_REQUIRED" ? "GOVERNANCE_REVIEW_REQUIRED" : "VALIDATED",
      taskFingerprint,
    };
  });

  const unresolvedItems = unresolved.slice(0, MAX_UNRESOLVED_ITEMS);
  const unresolvedItemsFingerprint = deriveListFingerprint(
    unresolvedItems.map((u) => canonicalJson(u))
  );
  const planFingerprint = derivePlanFingerprint({
    planId,
    missionId: projection.missionId,
    missionAuthorityVersion: material.missionFingerprint,
    taskSetFingerprint,
    constraintSetFingerprint,
    unresolvedItemsFingerprint,
  });

  const completenessStatus =
    boundedTaskRows.length === 0
      ? "INCOMPLETE"
      : unresolvedItems.length > 0
        ? "COMPLETE_WITH_UNRESOLVED"
        : "COMPLETE";
  const status: PlanStatus =
    completenessStatus === "INCOMPLETE"
      ? "DRAFT"
      : boundedTaskRows.some((t) => t.governanceClass === "HUMAN_REVIEW_REQUIRED") ||
          projection.strategicRisk === "HIGH" ||
          projection.strategicRisk === "CRITICAL"
        ? "REVIEW_REQUIRED"
        : "VALIDATED";

  const validUntilMs = Math.min(
    Date.parse(projection.validity.validUntil),
    nowMs + 30 * 24 * 3600_000
  );
  const finalTaskRows = boundedTaskRows.map((t) => ({ ...t, planVersion }));

  const planRow: MissionPlanRecord = {
    planId,
    planVersion,
    userId: input.userId,
    businessId: projection.businessId,
    missionId: projection.missionId,
    missionAuthorityVersion: material.missionFingerprint,
    boundMissionVersion: material.boundMissionVersion,
    planScopeKey,
    taskIds: finalTaskRows.map((t) => t.taskId),
    taskSetFingerprint,
    constraintSetFingerprint,
    missionConstraints: constraints.map((c) => ({ ...c })),
    planningAssumptions: (input.input.planningAssumptions ?? []).map((a) => ({ ...a })),
    unresolvedItems,
    completenessStatus,
    status,
    validFrom: now.toISOString(),
    validUntil: new Date(validUntilMs).toISOString(),
    supersedesPlanId: null,
    planFingerprint,
    modelAssistanceFlagged,
    version: 1,
  };

  const inserted = await insertPlan(input.executor, planRow);
  if (!inserted.inserted) {
    // Idempotent replay: identical authoritative basis converges, zero events.
    const existing = await getPlan(input.executor, input.userId, planId);
    if (!existing) fail("PLAN_REPLAY_CONFLICT", `plan ${planId} converged but could not be re-read`);
    const mission = await resolveMissionProjection({
      deps: input.deps,
      userId: input.userId,
      missionId: existing.missionId,
    });
    return {
      plan: await toPlanView({
        deps: input.deps,
        executor: input.executor,
        plan: existing,
        mission,
        nowMs,
      }),
      convergence: "idempotent_replay",
    };
  }

  for (const taskRow of finalTaskRows) {
    await insertTask(input.executor, taskRow);
  }
  const lifecycleId = derivePlanLifecycleEventId({
    planId,
    lifecycleType: "formation",
    targetStatus: status,
    successorPlanId: null,
    occurredAt: now.toISOString(),
    reasonCode:
      status === "REVIEW_REQUIRED"
        ? "GOVERNANCE_REVIEW_HINTED"
        : status === "DRAFT"
          ? "UNRESOLVED_WORK_PRESENT"
          : "MISSION_GOVERNED_AND_CURRENT",
  });
  await insertPlanLifecycleEvent(input.executor, {
    lifecycleEventId: lifecycleId,
    userId: input.userId,
    planId,
    lifecycleType: "formation",
    targetStatus: status,
    successorPlanId: null,
    occurredAt: now.toISOString(),
    reasonCode:
      status === "REVIEW_REQUIRED"
        ? "GOVERNANCE_REVIEW_HINTED"
        : status === "DRAFT"
          ? "UNRESOLVED_WORK_PRESENT"
          : "MISSION_GOVERNED_AND_CURRENT",
  });

  await persistAuditEvent(
    createAuditEvent({
      eventType: "mission_plan_created",
      occurredAt: now.toISOString(),
      userId: input.userId,
      source: "system",
      outcome: "succeeded",
      campaignId: null,
      businessId: projection.businessId,
      workflowOperationId: null,
      metadata: {
        planId,
        planVersion,
        missionId: projection.missionId,
        missionType: projection.missionType,
        status,
        completenessStatus,
        taskCount: finalTaskRows.length,
        unresolvedCount: unresolvedItems.length,
        strategicRisk: projection.strategicRisk,
        engineVersion: MISSION_PLANNING_ENGINE_VERSION,
        planFingerprint,
        taskSetFingerprint,
        constraintSetFingerprint,
        modelAssistanceFlagged,
        convergence: "created",
      },
    }),
    asAuditExecutor(input.executor)
  );

  return {
    plan: await toPlanView({
      deps: input.deps,
      executor: input.executor,
      plan: planRow,
      mission: projection,
      nowMs,
    }),
    convergence: "created",
  };
}

// ─── Reads ───

export async function getPlanForUser(input: {
  userId: number;
  planId: string;
  deps: MissionPlanningDeps;
  executor: MissionPlanningStoreExecutor;
}): Promise<MissionPlanView> {
  const plan = await getPlan(input.executor, input.userId, input.planId);
  if (!plan) fail("PLAN_NOT_FOUND", `plan ${input.planId} not found`);
  const mission = await resolveMissionProjection({
    deps: input.deps,
    userId: input.userId,
    missionId: plan.missionId,
  });
  return toPlanView({
    deps: input.deps,
    executor: input.executor,
    plan,
    mission,
    nowMs: resolveNow(input.deps).getTime(),
  });
}

export async function listPlansForUser(input: {
  userId: number;
  missionId?: string;
  status?: string;
  deps: MissionPlanningDeps;
  executor: MissionPlanningStoreExecutor;
}): Promise<MissionPlanView[]> {
  const rows = await listPlanRows(input.executor, input.userId, {
    missionId: input.missionId,
    status: input.status,
  });
  const nowMs = resolveNow(input.deps).getTime();
  const out: MissionPlanView[] = [];
  for (const row of rows) {
    const mission = await resolveMissionProjection({
      deps: input.deps,
      userId: input.userId,
      missionId: row.missionId,
    });
    out.push(await toPlanView({ deps: input.deps, executor: input.executor, plan: row, mission, nowMs }));
  }
  return out;
}

export async function listPlanLifecycleForUser(input: {
  userId: number;
  planId: string;
  executor: MissionPlanningStoreExecutor;
}): Promise<readonly unknown[]> {
  const plan = await getPlan(input.executor, input.userId, input.planId);
  if (!plan) fail("PLAN_NOT_FOUND", `plan ${input.planId} not found`);
  return listPlanLifecycleRows(input.executor, input.userId, input.planId);
}

// ─── Scheduling projection (B9; read-only) ───

export async function getSchedulingHandoffForUser(input: {
  userId: number;
  planId: string;
  deps: MissionPlanningDeps;
  executor: MissionPlanningStoreExecutor;
}): Promise<{
  contractVersion: "mission-planning-to-scheduling/v1";
  projection: MissionPlanningToSchedulingProjection;
  schedulingConsumable: boolean;
}> {
  const plan = await getPlan(input.executor, input.userId, input.planId);
  if (!plan) fail("PLAN_NOT_FOUND", `plan ${input.planId} not found`);
  const mission = await resolveMissionProjection({
    deps: input.deps,
    userId: input.userId,
    missionId: plan.missionId,
  });
  const taskRows = await listTaskRows(input.executor, input.userId, plan.planId);
  const projection = validateSchedulingProjection(
    buildSchedulingProjection({
      plan: plan as unknown as Record<string, unknown>,
      tasks: taskRows as unknown as Record<string, unknown>[],
      missionObjective: mission
        ? {
            objectiveId: mission.objectiveId,
            objectiveStatement: mission.objectiveStatement,
            objectiveType: mission.objectiveType,
          }
        : { objectiveId: "", objectiveStatement: "", objectiveType: "" },
      nowMs: resolveNow(input.deps).getTime(),
    })
  );
  const effective = effectivePlanStatus({
    plan,
    missionStatus: mission ? mission.status : null,
    missionFreshness: mission ? mission.freshness : null,
    nowMs: resolveNow(input.deps).getTime(),
  });
  return {
    contractVersion: projection.contractVersion,
    projection,
    schedulingConsumable:
      projection.schedulingEligibility && effective === "READY_FOR_SCHEDULING",
  };
}

// ─── Lifecycle (B8) ───

async function persistLifecycle(input: {
  executor: MissionPlanningStoreExecutor;
  userId: number;
  planId: string;
  lifecycleType: string;
  targetStatus: string;
  successorPlanId: string | null;
  occurredAt: string;
  reasonCode: PlanReasonCode;
  businessId: number;
  metadata?: Record<string, unknown>;
}): Promise<void> {
  const lifecycleEventId = derivePlanLifecycleEventId({
    planId: input.planId,
    lifecycleType: input.lifecycleType,
    targetStatus: input.targetStatus,
    successorPlanId: input.successorPlanId,
    occurredAt: input.occurredAt,
    reasonCode: input.reasonCode,
  });
  const inserted = await insertPlanLifecycleEvent(input.executor, {
    lifecycleEventId,
    userId: input.userId,
    planId: input.planId,
    lifecycleType: input.lifecycleType,
    targetStatus: input.targetStatus,
    successorPlanId: input.successorPlanId,
    occurredAt: input.occurredAt,
    reasonCode: input.reasonCode,
  });
  if (!inserted.inserted) return; // convergence emits zero events
  await persistAuditEvent(
    createAuditEvent({
      eventType: "mission_plan_lifecycle",
      occurredAt: input.occurredAt,
      userId: input.userId,
      source: "system",
      outcome: "succeeded",
      campaignId: null,
      businessId: input.businessId,
      workflowOperationId: null,
      metadata: {
        planId: input.planId,
        lifecycleType: input.lifecycleType,
        targetStatus: input.targetStatus,
        successorPlanId: input.successorPlanId,
        reasonCode: input.reasonCode,
        ...(input.metadata ?? {}),
      },
    }),
    asAuditExecutor(input.executor)
  );
}

async function reassertMissionHealth(input: {
  deps: MissionPlanningDeps;
  userId: number;
  missionId: string;
  expectedAuthorityVersion: string;
}): Promise<{ projection: MissionAuthorityProjection }> {
  const { projection, material } = await resolveEligibleMission(input);
  if (material.missionFingerprint !== input.expectedAuthorityVersion) {
    fail(
      "PLAN_MISSION_AUTHORITY_DRIFT",
      "mission material fingerprint drifted under the same mission identity"
    );
  }
  return { projection };
}

export async function markPlanReadyForScheduling(input: {
  userId: number;
  planId: string;
  expectedVersion: number;
  deps: MissionPlanningDeps;
  executor: MissionPlanningStoreExecutor;
}): Promise<MissionPlanView> {
  const now = resolveNow(input.deps);
  const plan = await getPlan(input.executor, input.userId, input.planId);
  if (!plan) fail("PLAN_NOT_FOUND", `plan ${input.planId} not found`);
  await reassertMissionHealth({
    deps: input.deps,
    userId: input.userId,
    missionId: plan.missionId,
    expectedAuthorityVersion: plan.missionAuthorityVersion,
  });
  if (plan.status !== "VALIDATED") {
    fail("PLAN_STATE_CONFLICT", `plan ${input.planId} is ${plan.status}; only VALIDATED plans become ready`);
  }
  await updatePlanStatus(input.executor, {
    userId: input.userId,
    planId: input.planId,
    expectedVersion: input.expectedVersion,
    status: "READY_FOR_SCHEDULING",
  });
  const tasks = await listTaskRows(input.executor, input.userId, input.planId);
  for (const task of tasks) {
    if (task.status === "VALIDATED") {
      await updateTaskStatus(input.executor, { userId: input.userId, taskId: task.taskId, status: "READY_FOR_SCHEDULING" });
    }
  }
  await persistLifecycle({
    executor: input.executor,
    userId: input.userId,
    planId: input.planId,
    lifecycleType: "readiness",
    targetStatus: "READY_FOR_SCHEDULING",
    successorPlanId: null,
    occurredAt: now.toISOString(),
    reasonCode: "PLAN_READY_FOR_SCHEDULING",
    businessId: plan.businessId,
  });
  const updated = await getPlan(input.executor, input.userId, input.planId);
  if (!updated) fail("PLAN_NOT_FOUND", `plan ${input.planId} not found`);
  const mission = await resolveMissionProjection({
    deps: input.deps,
    userId: input.userId,
    missionId: updated.missionId,
  });
  return toPlanView({ deps: input.deps, executor: input.executor, plan: updated, mission, nowMs: now.getTime() });
}

export async function revisePlanForUser(input: {
  userId: number;
  planId: string;
  expectedVersion: number;
  deps: MissionPlanningDeps;
  executor: MissionPlanningStoreExecutor;
}): Promise<{ plan: MissionPlanView; predecessor: MissionPlanView }> {
  const now = resolveNow(input.deps);
  const predecessor = await getPlan(input.executor, input.userId, input.planId);
  if (!predecessor) fail("PLAN_NOT_FOUND", `plan ${input.planId} not found`);
  if (isTerminalPlanStatus(predecessor.status)) {
    fail("PLAN_STATE_CONFLICT", `plan ${input.planId} is terminal (${predecessor.status})`);
  }
  const { projection } = await reassertMissionHealth({
    deps: input.deps,
    userId: input.userId,
    missionId: predecessor.missionId,
    expectedAuthorityVersion: predecessor.missionAuthorityVersion,
  });
  void projection;
  // Supersede the predecessor and mint the next plan version.
  await updatePlanStatus(input.executor, {
    userId: input.userId,
    planId: predecessor.planId,
    expectedVersion: input.expectedVersion,
    status: "SUPERSEDED",
  });
  await persistLifecycle({
    executor: input.executor,
    userId: input.userId,
    planId: predecessor.planId,
    lifecycleType: "supersession",
    targetStatus: "SUPERSEDED",
    successorPlanId: null,
    occurredAt: now.toISOString(),
    reasonCode: "SUPERSEDED_BY_SUCCESSOR",
    businessId: predecessor.businessId,
  });
  const created = await createPlanForUser({
    userId: input.userId,
    input: { missionId: predecessor.missionId },
    deps: input.deps,
    executor: input.executor,
  });
  // Bind the exact predecessor on the successor row (immutable lineage) and
  // return the fresh successor view (supersedes lineage included).
  await updatePlanSupersedes(input.executor, {
    userId: input.userId,
    planId: created.plan.planId,
    supersedesPlanId: predecessor.planId,
  });
  const successorView = await getPlanForUser({
    userId: input.userId,
    planId: created.plan.planId,
    deps: input.deps,
    executor: input.executor,
  });
  const predecessorView = await getPlanForUser({
    userId: input.userId,
    planId: predecessor.planId,
    deps: input.deps,
    executor: input.executor,
  });
  return { plan: successorView, predecessor: predecessorView };
}

export async function cancelPlanForUser(input: {
  userId: number;
  planId: string;
  expectedVersion: number;
  reasonCode?: PlanReasonCode;
  deps: MissionPlanningDeps;
  executor: MissionPlanningStoreExecutor;
}): Promise<MissionPlanView> {
  const now = resolveNow(input.deps);
  const plan = await getPlan(input.executor, input.userId, input.planId);
  if (!plan) fail("PLAN_NOT_FOUND", `plan ${input.planId} not found`);
  if (isTerminalPlanStatus(plan.status)) {
    fail("PLAN_STATE_CONFLICT", `plan ${input.planId} is terminal (${plan.status})`);
  }
  await updatePlanStatus(input.executor, {
    userId: input.userId,
    planId: input.planId,
    expectedVersion: input.expectedVersion,
    status: "CANCELLED",
  });
  await persistLifecycle({
    executor: input.executor,
    userId: input.userId,
    planId: input.planId,
    lifecycleType: "cancellation",
    targetStatus: "CANCELLED",
    successorPlanId: null,
    occurredAt: now.toISOString(),
    reasonCode: input.reasonCode ?? "OPERATOR_CANCELLED",
    businessId: plan.businessId,
  });
  const updated = await getPlan(input.executor, input.userId, input.planId);
  if (!updated) fail("PLAN_NOT_FOUND", `plan ${input.planId} not found`);
  const mission = await resolveMissionProjection({
    deps: input.deps,
    userId: input.userId,
    missionId: updated.missionId,
  });
  return toPlanView({ deps: input.deps, executor: input.executor, plan: updated, mission, nowMs: now.getTime() });
}
