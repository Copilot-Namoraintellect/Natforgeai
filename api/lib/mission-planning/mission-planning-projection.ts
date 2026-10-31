// ─── R9-B Mission Planning — downstream scheduling projection (B9) ───
//
// Frozen read-only projection for R9-C/D scheduling
// (docs/contracts/mission-planning-to-scheduling-contract.md).
// 24-key exact allowlist (20-key task views) — asserted exact in acceptance.
// Verbatim disclaimers travel with every projection: a mission plan is
// bounded task-definition authority, not a schedule and never execution
// authorization. Scheduling may order tasks; scheduling may never rewrite
// task authority. This stream never schedules and never executes.

import {
  MISSION_PLANNING_TO_SCHEDULING_VERSION,
  fail,
} from "./mission-planning-contract";

export const SCHEDULING_PLANNING_DISCLAIMER =
  "A mission plan is bounded task-definition authority, not a schedule and never " +
  "execution authorization. Dependency ordering, sequencing, scheduling commits and " +
  "any execution remain downstream authority under separate governance.";

export const SCHEDULING_EXECUTION_DISCLAIMER =
  "A mission plan is never an execution authorization: no task, campaign, budget, " +
  "Business DNA, experiment, provider, payment or billing state may be mutated from " +
  "this projection. plan != schedule; task definition != execution authorization.";

export const MISSION_PLANNING_TO_SCHEDULING_FIELD_KEYS = [
  "contractVersion",
  "planId",
  "planVersion",
  "missionId",
  "businessId",
  "status",
  "freshness",
  "validUntil",
  "taskIds",
  "tasks",
  "unresolvedItems",
  "completenessStatus",
  "missionConstraints",
  "planningAssumptions",
  "missionObjective",
  "schedulingEligibility",
  "planningClaimed",
  "planningDisclaimer",
  "executionClaimed",
  "executionDisclaimer",
  "limitations",
  "missionAuthorityVersion",
  "supersedesPlanId",
  "eligibleTaskIds",
] as const;

export type MissionPlanningToSchedulingKey = (typeof MISSION_PLANNING_TO_SCHEDULING_FIELD_KEYS)[number];

export const SCHEDULING_TASK_FIELD_KEYS = [
  "taskId",
  "taskType",
  "taskSequence",
  "taskObjective",
  "requiredInputs",
  "expectedOutputs",
  "requiredCapabilities",
  "constraints",
  "preconditions",
  "postconditions",
  "governanceClass",
  "sideEffectClass",
  "executionClass",
  "capabilityStatus",
  "governanceCharacteristics",
  "status",
  "schedulable",
  "planId",
  "missionId",
  "businessId",
] as const;

export interface SchedulingTaskView {
  readonly taskId: string;
  readonly taskType: string;
  readonly taskSequence: number;
  readonly taskObjective: string;
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
  readonly schedulable: boolean;
  readonly planId: string;
  readonly missionId: string;
  readonly businessId: number;
}

export interface MissionPlanningToSchedulingProjection {
  readonly contractVersion: typeof MISSION_PLANNING_TO_SCHEDULING_VERSION;
  readonly planId: string;
  readonly planVersion: number;
  readonly missionId: string;
  readonly businessId: number;
  readonly status: string;
  readonly freshness: "current" | "stale";
  readonly validUntil: string;
  readonly taskIds: readonly string[];
  readonly tasks: readonly SchedulingTaskView[];
  readonly unresolvedItems: readonly unknown[];
  readonly completenessStatus: string;
  readonly missionConstraints: readonly unknown[];
  readonly planningAssumptions: readonly unknown[];
  readonly missionObjective: {
    readonly objectiveId: string;
    readonly objectiveStatement: string;
    readonly objectiveType: string;
  };
  readonly schedulingEligibility: boolean;
  readonly planningClaimed: false;
  readonly planningDisclaimer: string;
  readonly executionClaimed: false;
  readonly executionDisclaimer: string;
  readonly limitations: readonly string[];
  readonly missionAuthorityVersion: string;
  readonly supersedesPlanId: string | null;
  readonly eligibleTaskIds: readonly string[];
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

function asArray(raw: unknown): readonly unknown[] {
  const parsed = parseJson(raw);
  return Array.isArray(parsed) ? parsed : [];
}

function asStringArray(raw: unknown): readonly string[] {
  return asArray(raw).map(String);
}

function asObject(raw: unknown): Record<string, unknown> {
  const parsed = parseJson(raw);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

/** Build the frozen scheduling projection from durable rows (read-only). */
export function buildSchedulingProjection(input: {
  plan: Record<string, unknown>;
  tasks: ReadonlyArray<Record<string, unknown>>;
  missionObjective: { objectiveId: string; objectiveStatement: string; objectiveType: string };
  nowMs: number;
}): MissionPlanningToSchedulingProjection {
  const { plan, tasks, missionObjective, nowMs } = input;
  const status = String(plan.status ?? "");
  const validUntil = String(plan.validUntil ?? "");
  const expired = validUntil.length > 0 && Date.parse(validUntil) < nowMs;
  const freshness = expired ? "stale" : "current";
  const schedulingEligibility =
    status === "READY_FOR_SCHEDULING" && freshness === "current";
  const taskIds = asStringArray(plan.taskIds);
  const taskViews: SchedulingTaskView[] = tasks.map((t) => ({
    taskId: String(t.taskId),
    taskType: String(t.taskType),
    taskSequence: Number(t.taskSequence ?? 0),
    taskObjective: String(t.taskObjective ?? ""),
    requiredInputs: asArray(t.requiredInputs),
    expectedOutputs: asArray(t.expectedOutputs),
    requiredCapabilities: asStringArray(t.requiredCapabilities),
    constraints: asArray(t.constraints),
    preconditions: asArray(t.preconditions),
    postconditions: asArray(t.postconditions),
    governanceClass: String(t.governanceClass ?? ""),
    sideEffectClass: String(t.sideEffectClass ?? ""),
    executionClass: String(t.executionClass ?? ""),
    capabilityStatus: String(t.capabilityStatus ?? ""),
    governanceCharacteristics: asObject(t.governanceCharacteristics),
    status: String(t.status ?? ""),
    schedulable:
      schedulingEligibility &&
      String(t.status ?? "") === "READY_FOR_SCHEDULING" &&
      (String(t.capabilityStatus ?? "") === "SUPPORTED" ||
        String(t.capabilityStatus ?? "") === "CONDITIONALLY_SUPPORTED"),
    planId: String(t.planId ?? ""),
    missionId: String(t.missionId ?? ""),
    businessId: Number(t.businessId ?? 0),
  }));
  const limitations: string[] = [
    "Task ordering in this projection is derivation order, not a schedule.",
    "Scheduling may sequence tasks but may never rewrite task authority.",
    "unresolvedItems are planning work that never became task definitions.",
    "A consumable R9-F governance verdict remains required before any material effect.",
  ];
  return {
    contractVersion: MISSION_PLANNING_TO_SCHEDULING_VERSION,
    planId: String(plan.planId),
    planVersion: Number(plan.planVersion ?? 0),
    missionId: String(plan.missionId),
    businessId: Number(plan.businessId ?? 0),
    status,
    freshness,
    validUntil,
    taskIds,
    tasks: taskViews,
    unresolvedItems: asArray(plan.unresolvedItems),
    completenessStatus: String(plan.completenessStatus ?? ""),
    missionConstraints: asArray(plan.missionConstraints),
    planningAssumptions: asArray(plan.planningAssumptions),
    missionObjective,
    schedulingEligibility,
    planningClaimed: false,
    planningDisclaimer: SCHEDULING_PLANNING_DISCLAIMER,
    executionClaimed: false,
    executionDisclaimer: SCHEDULING_EXECUTION_DISCLAIMER,
    limitations,
    missionAuthorityVersion: String(plan.missionAuthorityVersion ?? ""),
    supersedesPlanId: typeof plan.supersedesPlanId === "string" ? plan.supersedesPlanId : null,
    eligibleTaskIds: schedulingEligibility ? taskViews.filter((t) => t.schedulable).map((t) => t.taskId) : [],
  };
}

/** Seam validator: exact key allowlists + frozen version + disclaimers verbatim. */
export function validateSchedulingProjection(raw: unknown): MissionPlanningToSchedulingProjection {
  if (typeof raw !== "object" || raw === null) {
    fail("PLAN_NOT_FOUND", "scheduling projection must be an object");
  }
  const keys = Object.keys(raw).sort();
  const expected = [...MISSION_PLANNING_TO_SCHEDULING_FIELD_KEYS].sort();
  if (JSON.stringify(keys) !== JSON.stringify(expected)) {
    fail("PLAN_NOT_FOUND", "scheduling projection key allowlist mismatch");
  }
  const p = raw as Record<string, unknown>;
  if (p.contractVersion !== MISSION_PLANNING_TO_SCHEDULING_VERSION) {
    fail("PLAN_NOT_FOUND", "scheduling projection version mismatch");
  }
  if (p.planningClaimed !== false || p.executionClaimed !== false) {
    fail("PLAN_NOT_FOUND", "scheduling projection must never claim planning or execution authority");
  }
  if (p.planningDisclaimer !== SCHEDULING_PLANNING_DISCLAIMER || p.executionDisclaimer !== SCHEDULING_EXECUTION_DISCLAIMER) {
    fail("PLAN_NOT_FOUND", "scheduling projection disclaimers must be verbatim");
  }
  const tasks = p.tasks;
  if (!Array.isArray(tasks)) fail("PLAN_NOT_FOUND", "scheduling projection tasks must be an array");
  const taskKeys = [...SCHEDULING_TASK_FIELD_KEYS].sort();
  for (const t of tasks) {
    if (typeof t !== "object" || t === null) fail("PLAN_NOT_FOUND", "task view must be an object");
    if (JSON.stringify(Object.keys(t).sort()) !== JSON.stringify(taskKeys)) {
      fail("PLAN_NOT_FOUND", "scheduling task view key allowlist mismatch");
    }
  }
  return raw as unknown as MissionPlanningToSchedulingProjection;
}
