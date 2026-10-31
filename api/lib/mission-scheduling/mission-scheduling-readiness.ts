// ─── R9-C Dependency & Scheduling Intelligence — task readiness ───
//
// PURE deterministic readiness derivation (C4). Readiness is derived from
// authoritative scheduling state only: the validated dependency graph, the
// accepted plan material, the execution-state view (untrusted, visibly
// bound), R9-F approval evidence (read-only), capability evidence (plan
// contract, never widened) and mission/task validity windows. No model, no
// client authority: readiness can never be supplied, only derived.
//
// Readiness != execution authorization: READY_FOR_SCHEDULING says a task may
// occupy a scheduling slot — R9-D must still pass R9-F's consumption gate
// before any material action.

import {
  MissionSchedulingValidationError,
  isSchedulableMissionStatus,
  type MissionDependencyType,
  type MissionTaskReadiness,
  type MissionTaskSpec,
} from "./mission-scheduling-contract";
import type { ValidatedMissionGraph } from "./mission-scheduling-graph";

export interface TaskReadinessReport {
  readonly taskId: string;
  readonly readiness: MissionTaskReadiness;
  readonly reasons: readonly string[];
}

export interface ReadinessContext {
  readonly missionId: string;
  /** R9-A mission status (verbatim, read-only). */
  readonly missionStatus: string;
  readonly missionValidUntil: string;
  readonly tasks: readonly MissionTaskSpec[];
  readonly graph: ValidatedMissionGraph;
  readonly completedTaskIds: ReadonlySet<string>;
  readonly succeededTaskIds: ReadonlySet<string>;
  /** Current R9-F approval evidence per task id (read-only; true = ALLOW current). */
  readonly approvalEvidence: ReadonlyMap<string, boolean>;
  /** Capability contract declared by the plan; scheduling can never widen it. */
  readonly supportedCapabilities: ReadonlySet<string>;
  /** Injected clock (ISO string). */
  readonly nowIso: string;
}

function taskWindow(task: MissionTaskSpec): { notBefore: string | null; notAfter: string | null } {
  const notBefores: string[] = [];
  const notAfters: string[] = [];
  for (const constraint of task.constraints) {
    if (constraint.constraintType === "TIME_WINDOW") {
      if (constraint.notBefore) notBefores.push(constraint.notBefore);
      if (constraint.notAfter) notAfters.push(constraint.notAfter);
    }
  }
  const notBefore = notBefores.length > 0 ? [...notBefores].sort()[0] : null;
  const notAfter = notAfters.length > 0 ? [...notAfters].sort().slice(-1)[0] : null;
  return { notBefore, notAfter };
}

function requiresApprovalGate(type: MissionDependencyType): boolean {
  return type === "REQUIRES_APPROVAL";
}

/**
 * Deterministic per-task readiness. Precedence (first match wins):
 * INVALID > STALE > BLOCKED_DEPENDENCY > BLOCKED_APPROVAL >
 * BLOCKED_CAPABILITY > BLOCKED_TIME_WINDOW > BLOCKED_CONSTRAINT > READY.
 */
export function deriveTaskReadiness(ctx: ReadinessContext): Map<string, TaskReadinessReport> {
  const nowMs = Date.parse(ctx.nowIso);
  if (Number.isNaN(nowMs)) {
    throw new MissionSchedulingValidationError("SCHEDULING_INPUT_MALFORMED", "scheduling clock is malformed.");
  }
  const missionExpired = nowMs > Date.parse(ctx.missionValidUntil);
  const missionSchedulable = isSchedulableMissionStatus(ctx.missionStatus);
  const taskById = new Map(ctx.tasks.map((task) => [task.taskId, task]));
  const reports = new Map<string, TaskReadinessReport>();

  // Hard ordering requirements per successor. REQUIRES_CAPABILITY edges are
  // evaluated at the capability precedence level (they never masquerade as
  // dependency blocks).
  const unmetBySuccessor = new Map<string, string[]>();
  const capabilityMissBySuccessor = new Map<string, string[]>();
  const approvalGateBySuccessor = new Map<string, string[]>();
  for (const edge of ctx.graph.edges) {
    if (edge.hardOrSoft !== "HARD") continue;
    if (edge.dependencyType === "MUTUAL_EXCLUSION") continue;
    if (requiresApprovalGate(edge.dependencyType)) {
      const list = approvalGateBySuccessor.get(edge.successorTaskId) ?? [];
      list.push(edge.predecessorTaskId);
      approvalGateBySuccessor.set(edge.successorTaskId, list);
      continue;
    }
    if (edge.dependencyType === "REQUIRES_CAPABILITY") {
      const succ = taskById.get(edge.successorTaskId);
      const missing = (succ?.requiredCapabilities ?? []).filter((cap) => !ctx.supportedCapabilities.has(cap));
      if (missing.length > 0) {
        capabilityMissBySuccessor.set(edge.successorTaskId, missing);
      }
      continue;
    }
    let satisfied: boolean;
    if (edge.dependencyType === "REQUIRES_COMPLETION") {
      satisfied = ctx.completedTaskIds.has(edge.predecessorTaskId);
    } else if (edge.dependencyType === "REQUIRES_SUCCESS") {
      satisfied = ctx.succeededTaskIds.has(edge.predecessorTaskId);
    } else if (edge.dependencyType === "REQUIRES_OUTPUT") {
      const pred = taskById.get(edge.predecessorTaskId);
      satisfied =
        ctx.succeededTaskIds.has(edge.predecessorTaskId) && (pred?.postconditions.length ?? 0) > 0;
    } else if (edge.dependencyType === "REQUIRES_TIME_WINDOW") {
      const succ = taskById.get(edge.successorTaskId);
      const { notAfter } = succ ? taskWindow(succ) : { notAfter: null };
      satisfied = notAfter === null || nowMs <= Date.parse(notAfter);
    } else {
      satisfied = true;
    }
    if (!satisfied) {
      const list = unmetBySuccessor.get(edge.successorTaskId) ?? [];
      list.push(`${edge.dependencyType}:${edge.predecessorTaskId}`);
      unmetBySuccessor.set(edge.successorTaskId, list);
    }
  }

  for (const taskId of ctx.graph.taskIds) {
    const task = taskById.get(taskId);
    const reasons: string[] = [];
    let readiness: MissionTaskReadiness;

    if (!task || !missionSchedulable) {
      readiness = "INVALID";
      reasons.push(task ? `MISSION_STATUS:${ctx.missionStatus}` : "TASK_NOT_IN_PLAN");
    } else if (missionExpired || (task.validity !== null && nowMs > Date.parse(task.validity.validUntil))) {
      readiness = "STALE";
      reasons.push(missionExpired ? "MISSION_VALIDITY_EXPIRED" : "TASK_VALIDITY_EXPIRED");
    } else {
      const unmet = (unmetBySuccessor.get(taskId) ?? []).slice().sort();
      const approvalGates = (approvalGateBySuccessor.get(taskId) ?? []).slice().sort();
      const unmetApprovals = approvalGates.filter((pred) => ctx.approvalEvidence.get(pred) !== true);
      const missingCapabilities = [
        ...new Set([
          ...task.requiredCapabilities.filter((cap) => !ctx.supportedCapabilities.has(cap)),
          ...(capabilityMissBySuccessor.get(taskId) ?? []),
        ]),
      ].sort();
      const { notBefore, notAfter } = taskWindow(task);
      const windowFuture = notBefore !== null && nowMs < Date.parse(notBefore);
      const windowExpired = notAfter !== null && nowMs > Date.parse(notAfter);
      const taskApprovalRequired =
        task.governanceCharacteristics.requiresApproval && ctx.approvalEvidence.get(taskId) !== true;

      if (unmet.length > 0) {
        readiness = "BLOCKED_DEPENDENCY";
        reasons.push(...unmet.map((entry) => `UNMET_${entry}`));
      } else if (unmetApprovals.length > 0 || taskApprovalRequired) {
        readiness = "BLOCKED_APPROVAL";
        reasons.push(...unmetApprovals.map((pred) => `APPROVAL_GATE:${pred}`));
        if (taskApprovalRequired) reasons.push("TASK_REQUIRES_APPROVAL");
      } else if (missingCapabilities.length > 0) {
        readiness = "BLOCKED_CAPABILITY";
        reasons.push(...missingCapabilities.map((cap) => `MISSING_CAPABILITY:${cap}`));
      } else if (windowFuture || windowExpired) {
        readiness = "BLOCKED_TIME_WINDOW";
        reasons.push(windowFuture ? `WINDOW_NOT_OPEN:${notBefore}` : `WINDOW_CLOSED:${notAfter}`);
      } else {
        readiness = "READY_FOR_SCHEDULING";
      }
    }
    reports.set(taskId, { taskId, readiness, reasons });
  }
  return reports;
}
