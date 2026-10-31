// ─── R9-C Dependency & Scheduling Intelligence — execution-order projection ───
//
// Frozen read-only downstream projection (C10) for the future R9-D execution
// coordination stream: docs/contracts/mission-scheduling-to-execution-contract.md.
// Exact key allowlist — asserted exact in acceptance. Verbatim disclaimers
// travel with every projection: a schedule is deterministic ordering
// evidence, never execution authorization. R9-D must call R9-F's consumption
// gate (assertMissionActionConsumable) independently for every material
// action; this projection authorizes nothing.

import { MISSION_SCHEDULING_PROJECTION_VERSION } from "./mission-scheduling-contract";
import type {
  MissionDependencyEdgeRow,
  MissionScheduleLifecycleEventRow,
  MissionScheduleRow,
  MissionTaskPlanSnapshotRow,
} from "@db/schema";

export const MISSION_SCHEDULING_DISCLAIMER =
  "A mission schedule is deterministic ordering evidence only — never execution authorization. It records " +
  "which tasks may be sequenced, which may run in parallel, and which are blocked. Scheduling consumed " +
  "mission and governance authority read-only; it never mutates mission objective, task definition, " +
  "governance state or capability.";

export const MISSION_EXECUTION_DISCLAIMER =
  "schedule != execution authorization. No task, provider, campaign, budget, approval or billing state may " +
  "be mutated from this projection. A schedulable task is not an executable task: R9-D must obtain R9-F " +
  "governance consumption (assertMissionActionConsumable) for every material action before execution. " +
  "mission != task; recommendation != execution authorization; readiness != authorization.";

export const MISSION_EXECUTION_PROJECTION_FIELD_KEYS = [
  "contractVersion",
  "scheduleId",
  "missionId",
  "planId",
  "planFingerprint",
  "status",
  "orderedTaskIds",
  "parallelGroups",
  "dependencyRefs",
  "blockingStates",
  "constraints",
  "governanceRequirements",
  "riskClass",
  "validity",
  "evidence",
  "limitations",
  "scheduleClaimed",
  "executionClaimed",
  "schedulingDisclaimer",
  "executionDisclaimer",
] as const;

export type MissionExecutionProjectionKey = (typeof MISSION_EXECUTION_PROJECTION_FIELD_KEYS)[number];

export interface MissionExecutionProjection {
  readonly contractVersion: typeof MISSION_SCHEDULING_PROJECTION_VERSION;
  readonly scheduleId: string;
  readonly missionId: string;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly status: string;
  readonly orderedTaskIds: readonly string[];
  readonly parallelGroups: readonly (readonly string[])[];
  readonly dependencyRefs: readonly unknown[];
  readonly blockingStates: readonly unknown[];
  readonly constraints: readonly unknown[];
  readonly governanceRequirements: unknown;
  readonly riskClass: string;
  readonly validity: { readonly validFrom: string; readonly validUntil: string };
  readonly evidence: unknown;
  readonly limitations: readonly string[];
  readonly scheduleClaimed: false;
  readonly executionClaimed: false;
  readonly schedulingDisclaimer: typeof MISSION_SCHEDULING_DISCLAIMER;
  readonly executionDisclaimer: typeof MISSION_EXECUTION_DISCLAIMER;
}

function parseArray(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (typeof value === "string") {
    try {
      const parsed: unknown = JSON.parse(value);
      return Array.isArray(parsed) ? parsed : [];
    } catch {
      return [];
    }
  }
  return [];
}

export function buildMissionExecutionProjection(
  schedule: MissionScheduleRow,
  edges: readonly MissionDependencyEdgeRow[],
  lifecycle: readonly MissionScheduleLifecycleEventRow[],
  snapshot: MissionTaskPlanSnapshotRow | null,
  options: { governanceAvailable: boolean }
): MissionExecutionProjection {
  const blockingStates = parseArray(schedule.blockingStates);
  const orderedTaskIds = parseArray(schedule.orderedTaskIds).map(String);
  const dependencyRefs = [...edges]
    .sort((a, b) => (a.dependencyId < b.dependencyId ? -1 : a.dependencyId > b.dependencyId ? 1 : 0))
    .map((edge) => ({
      dependencyId: edge.dependencyId,
      predecessorTaskId: edge.predecessorTaskId,
      successorTaskId: edge.successorTaskId,
      dependencyType: edge.dependencyType,
      hardOrSoft: edge.hardOrSoft,
      source: edge.source,
    }));

  // Constraints are projected from the accepted plan material (scheduling
  // never widens them): time windows + exclusive resources of ordered tasks.
  const constraints: unknown[] = [];
  if (snapshot) {
    const plan = snapshot.planDocument as { tasks?: Array<{ taskId: string; constraints?: unknown[] }> };
    const byId = new Map((plan.tasks ?? []).map((task) => [task.taskId, task]));
    for (const taskId of orderedTaskIds) {
      const task = byId.get(taskId);
      for (const constraint of parseArray(task?.constraints)) {
        constraints.push({ taskId, ...(constraint as Record<string, unknown>) });
      }
    }
  }

  const limitations: string[] = [
    "schedule != execution authorization",
    "readiness != authorization: R9-F consumption gate required downstream",
    "parallel groups are scheduling-level concurrency hints, not execution guarantees",
    "capability evidence is plan-declared contract material; scheduling cannot widen it",
  ];
  if (!options.governanceAvailable) {
    limitations.push(
      "governance authority unavailable at production time: approval evidence degraded to unsatisfied (fail-closed)"
    );
  }
  void lifecycle;

  return {
    contractVersion: MISSION_SCHEDULING_PROJECTION_VERSION,
    scheduleId: schedule.scheduleId,
    missionId: schedule.missionId,
    planId: schedule.planId,
    planFingerprint: schedule.planFingerprint,
    status: schedule.status,
    orderedTaskIds,
    parallelGroups: parseArray(schedule.parallelGroups).map((group) => parseArray(group).map(String)),
    dependencyRefs,
    blockingStates,
    constraints,
    governanceRequirements: schedule.governanceRequirements,
    riskClass: schedule.riskClass,
    validity: { validFrom: schedule.validFrom, validUntil: schedule.validUntil },
    evidence: {
      graphHash: schedule.graphHash,
      stateViewHash: schedule.stateViewHash,
      readinessHash: schedule.readinessHash,
      approvalEvidenceHash: schedule.approvalEvidenceHash,
      capabilityEvidenceHash: schedule.capabilityEvidenceHash,
      scheduleFingerprint: schedule.scheduleFingerprint,
    },
    limitations,
    scheduleClaimed: false,
    executionClaimed: false,
    schedulingDisclaimer: MISSION_SCHEDULING_DISCLAIMER,
    executionDisclaimer: MISSION_EXECUTION_DISCLAIMER,
  };
}
