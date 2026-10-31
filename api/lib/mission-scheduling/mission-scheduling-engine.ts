// ─── R9-C Dependency & Scheduling Intelligence — deterministic engine ───
//
// PURE deterministic scheduling (C5), contention handling (C6), time-window
// honouring (C7) and the governance surface (C9). No I/O, no clock ownership
// (the clock is injected), no model: identical authoritative inputs always
// produce the same ordering, the same parallel groups and the same schedule
// identity. The engine never grants capability, never weakens governance and
// never emits execution authority.

import {
  MISSION_SCHEDULING_GOVERNANCE_REASON_CODES,
  type MissionSchedulingGovernanceReasonCode,
  type MissionSchedulingRiskClass,
  type MissionTaskSpec,
} from "./mission-scheduling-contract";
import { computeKahnLevels, type ValidatedMissionGraph } from "./mission-scheduling-graph";
import { deriveReadinessHash, deriveStateViewHash } from "./mission-scheduling-identity";
import { deriveTaskReadiness, type ReadinessContext, type TaskReadinessReport } from "./mission-scheduling-readiness";

export interface SchedulingEngineInput {
  readonly tenantUserId: number;
  readonly businessId: number;
  readonly missionId: string;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly missionStatus: string;
  readonly missionValidFrom: string;
  readonly missionValidUntil: string;
  readonly tasks: readonly MissionTaskSpec[];
  readonly graph: ValidatedMissionGraph;
  readonly completedTaskIds: ReadonlySet<string>;
  readonly succeededTaskIds: ReadonlySet<string>;
  readonly approvalEvidence: ReadonlyMap<string, boolean>;
  readonly supportedCapabilities: ReadonlySet<string>;
  readonly nowIso: string;
  /** Side-effect signature of the prior approved/active schedule, if any. */
  readonly priorSideEffectSequence: readonly string[] | null;
}

export interface ScheduleCoreOutput {
  readonly orderedTaskIds: readonly string[];
  readonly parallelGroups: readonly (readonly string[])[];
  readonly blockingStates: readonly TaskReadinessReport[];
  readonly readiness: readonly TaskReadinessReport[];
  readonly readinessHash: string;
  readonly stateViewHash: string;
  readonly riskClass: MissionSchedulingRiskClass;
  readonly requiresApproval: boolean;
  readonly governanceReasonCodes: readonly MissionSchedulingGovernanceReasonCode[];
  readonly validUntil: string;
}

const RISK_RANK: Readonly<Record<MissionSchedulingRiskClass, number>> = Object.freeze({
  LOW: 0,
  MEDIUM: 1,
  HIGH: 2,
  CRITICAL: 3,
});

function riskClassOfRank(rank: number): MissionSchedulingRiskClass {
  return rank >= 3 ? "CRITICAL" : rank === 2 ? "HIGH" : rank === 1 ? "MEDIUM" : "LOW";
}

/**
 * Deterministic server-derived scheduling risk (raise-only). Urgency may
 * raise risk when the mission window is nearly closed; no time pressure, task
 * reordering or model narrative may ever lower it (charter principle 9).
 */
export function deriveSchedulingRisk(input: {
  tasks: readonly MissionTaskSpec[];
  missionValidFrom: string;
  missionValidUntil: string;
  nowIso: string;
}): MissionSchedulingRiskClass {
  let rank = 0;
  for (const task of input.tasks) {
    const g = task.governanceCharacteristics;
    if (g.financialExposure || g.sideEffectClass === "FINANCIAL") rank = Math.max(rank, RISK_RANK.MEDIUM);
    if (g.irreversible || g.sideEffectClass === "IRREVERSIBLE") rank = Math.max(rank, RISK_RANK.MEDIUM);
    if (g.sideEffectClass === "EXTERNAL_SIDE_EFFECT") rank = Math.max(rank, RISK_RANK.LOW);
    if (g.declaredRiskClass) rank = Math.max(rank, RISK_RANK[g.declaredRiskClass]);
  }
  const fromMs = Date.parse(input.missionValidFrom);
  const untilMs = Date.parse(input.missionValidUntil);
  const nowMs = Date.parse(input.nowIso);
  if (!Number.isNaN(fromMs) && !Number.isNaN(untilMs) && untilMs > fromMs) {
    const remainingFraction = (untilMs - nowMs) / (untilMs - fromMs);
    if (remainingFraction < 0.25) rank = Math.min(rank + 1, RISK_RANK.CRITICAL);
  }
  return riskClassOfRank(rank);
}

function resourceKeysOf(task: MissionTaskSpec): string[] {
  return task.constraints
    .filter((constraint) => constraint.constraintType === "EXCLUSIVE_RESOURCE")
    .map((constraint) => (constraint as { resourceKey: string }).resourceKey)
    .sort();
}

function contend(
  a: MissionTaskSpec,
  b: MissionTaskSpec,
  exclusion: ReadonlyMap<string, readonly string[]>
): boolean {
  if ((exclusion.get(a.taskId) ?? []).includes(b.taskId)) return true;
  const aKeys = resourceKeysOf(a);
  const bKeys = resourceKeysOf(b);
  if (aKeys.length === 0 || bKeys.length === 0) return false;
  return aKeys.some((key) => bKeys.includes(key));
}

/**
 * Produce the deterministic schedule core. Throws (no schedule produced) on
 * cycle/malformed graph; returns blocked reports rather than throwing when
 * tasks are legitimately unready — a blocked schedule is still durable
 * evidence of the blocking state.
 */
export function produceScheduleCore(input: SchedulingEngineInput): ScheduleCoreOutput {
  const taskById = new Map(input.tasks.map((task) => [task.taskId, task]));

  const readinessCtx: ReadinessContext = {
    missionId: input.missionId,
    missionStatus: input.missionStatus,
    missionValidUntil: input.missionValidUntil,
    tasks: input.tasks,
    graph: input.graph,
    completedTaskIds: input.completedTaskIds,
    succeededTaskIds: input.succeededTaskIds,
    approvalEvidence: input.approvalEvidence,
    supportedCapabilities: input.supportedCapabilities,
    nowIso: input.nowIso,
  };
  const readinessMap = deriveTaskReadiness(readinessCtx);
  const readiness = input.graph.taskIds.map((taskId) => readinessMap.get(taskId)!);

  // Kahn levels from hard ordering edges (deterministic).
  const levels = computeKahnLevels(input.graph.taskIds, input.graph.adjacency);

  // Parallel slots: within each dependency level, greedily pack lexicographically
  // sorted ready tasks into the first slot with no contention. Contention =
  // declared MUTUAL_EXCLUSION edge or shared EXCLUSIVE_RESOURCE key (C6).
  const parallelGroups: string[][] = [];
  const orderedTaskIds: string[] = [];
  for (const level of levels) {
    const slots: string[][] = [];
    for (const taskId of level) {
      const report = readinessMap.get(taskId)!;
      if (report.readiness !== "READY_FOR_SCHEDULING") continue; // blocked/stale tasks hold no slot
      const task = taskById.get(taskId)!;
      let placed = false;
      for (const slot of slots) {
        if (slot.every((otherId) => !contend(task, taskById.get(otherId)!, input.graph.exclusionAdjacency))) {
          slot.push(taskId);
          placed = true;
          break;
        }
      }
      if (!placed) slots.push([taskId]);
    }
    for (const slot of slots) {
      slot.sort();
      parallelGroups.push(slot);
      orderedTaskIds.push(...slot);
    }
  }

  const blockingStates = readiness.filter(
    (report) => report.readiness !== "READY_FOR_SCHEDULING"
  );

  const readinessHash = deriveReadinessHash({
    tenantUserId: input.tenantUserId,
    businessId: input.businessId,
    missionId: input.missionId,
    planId: input.planId,
    readiness,
  });
  const stateViewHash = deriveStateViewHash({
    tenantUserId: input.tenantUserId,
    businessId: input.businessId,
    missionId: input.missionId,
    planId: input.planId,
    completedTaskIds: [...input.completedTaskIds],
    succeededTaskIds: [...input.succeededTaskIds],
  });

  const riskClass = deriveSchedulingRisk({
    tasks: input.tasks,
    missionValidFrom: input.missionValidFrom,
    missionValidUntil: input.missionValidUntil,
    nowIso: input.nowIso,
  });

  // Governance surface (C9): scheduling may require approval, never grant it.
  const governanceReasonCodes = new Set<MissionSchedulingGovernanceReasonCode>();
  for (const task of input.tasks) {
    if (task.governanceCharacteristics.requiresApproval) {
      governanceReasonCodes.add("REQUIRES_APPROVAL_MATERIAL");
    }
    if (
      task.governanceCharacteristics.irreversible ||
      task.governanceCharacteristics.financialExposure ||
      task.governanceCharacteristics.sideEffectClass === "FINANCIAL" ||
      task.governanceCharacteristics.sideEffectClass === "IRREVERSIBLE"
    ) {
      governanceReasonCodes.add("SIDE_EFFECT_REVIEW");
    }
  }
  for (const edge of input.graph.edges) {
    if (edge.dependencyType === "REQUIRES_APPROVAL" && edge.hardOrSoft === "HARD") {
      if (input.approvalEvidence.get(edge.predecessorTaskId) !== true) {
        governanceReasonCodes.add("APPROVAL_EVIDENCE_MISSING");
      }
    }
  }
  if (RISK_RANK[riskClass] >= RISK_RANK.HIGH) governanceReasonCodes.add("RISK_REVIEW");
  const sideEffectSequence = orderedTaskIds.map((taskId) => {
    const task = taskById.get(taskId)!;
    const g = task.governanceCharacteristics;
    return `${taskId}:${g.sideEffectClass}:${g.financialExposure ? "F" : "-"}:${g.irreversible ? "I" : "-"}`;
  });
  if (
    input.priorSideEffectSequence !== null &&
    JSON.stringify(sideEffectSequence) !== JSON.stringify(input.priorSideEffectSequence)
  ) {
    governanceReasonCodes.add("SEQUENCE_CHANGED");
  }
  const sortedReasons = [...governanceReasonCodes]
    .filter((code) => (MISSION_SCHEDULING_GOVERNANCE_REASON_CODES as readonly string[]).includes(code))
    .sort() as MissionSchedulingGovernanceReasonCode[];

  return {
    orderedTaskIds,
    parallelGroups,
    blockingStates,
    readiness,
    readinessHash,
    stateViewHash,
    riskClass,
    requiresApproval: sortedReasons.length > 0,
    governanceReasonCodes: sortedReasons,
    validUntil: input.missionValidUntil,
  };
}
