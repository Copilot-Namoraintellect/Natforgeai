// ─── R9-E Mission State & Recovery — R9-A/B/C upstream authority seam ───
//
// Consumes R9-A mission authority, R9-B plan/task authority and R9-C
// scheduling evidence READ-ONLY, behind guarded information-schema checks
// (house seam pattern — R9-D's execution-upstream-seams is the model).
// The upstream tables (mission_proposals @ R9-A 273ce40, mission_plans /
// mission_plan_tasks @ R9-B a358f53, mission_schedules @ R9-C 1c5837f) are
// provisional on the frozen branches; R9-X owns canonical binding. Every row
// is re-validated at consumption: identity patterns, closed status
// vocabularies, ISO timestamps, tenant + business ownership. This seam never
// writes any upstream table, never re-derives upstream semantics, never
// widens scope.
//
// Fail-closed posture: an absent upstream table throws
// MISSION_STATE_AUTHORITY_UNAVAILABLE — state recovery never fabricates
// mission, plan or schedule state.

import { sql } from "drizzle-orm";
import { getDb } from "../../queries/connection";
import {
  MISSION_ID_PATTERN,
  MISSION_STATE_AUTHORITY_UNAVAILABLE,
  MISSION_STATE_INPUT_MALFORMED,
  R9_MISSION_STATUSES,
  R9_SCHEDULE_STATUSES,
  R9_TASK_STATUSES,
  SCHEDULE_ID_PATTERN,
  TASK_ID_PATTERN,
  MissionStateUpstreamError,
  isIsoUtc,
} from "./mission-state-recovery-contract";

export class MissionStateAuthorityUnavailable extends MissionStateUpstreamError {
  constructor(detail: string) {
    super(
      MISSION_STATE_AUTHORITY_UNAVAILABLE,
      `upstream authority unavailable (${detail}); mission state recovery cannot verify authority and fails closed.`
    );
    this.name = "MissionStateAuthorityUnavailable";
  }
}

// ─── Row views ───

export interface MissionAuthorityView {
  readonly missionId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly status: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly missionFingerprint: string;
}

export interface PlanAuthorityView {
  readonly planId: string;
  readonly planVersion: number;
  readonly userId: number;
  readonly businessId: number;
  readonly missionId: string;
  readonly status: string;
  readonly validFrom: string;
  readonly validUntil: string;
  readonly planFingerprint: string;
}

export interface TaskAuthorityView {
  readonly taskId: string;
  readonly planId: string;
  readonly planVersion: number;
  readonly userId: number;
  readonly businessId: number;
  readonly missionId: string;
  readonly taskType: string;
  readonly status: string;
  readonly requiredCapabilities: readonly string[];
  readonly constraints: readonly unknown[];
  readonly capabilityStatus: string | null;
  readonly taskFingerprint: string;
}

export interface ScheduleBlockingStateView {
  readonly taskId: string;
  readonly readiness: string;
  readonly reasons: readonly string[];
}

export interface ScheduleAuthorityView {
  readonly scheduleId: string;
  readonly userId: number;
  readonly businessId: number;
  readonly missionId: string;
  readonly planId: string;
  readonly planFingerprint: string;
  readonly status: string;
  readonly orderedTaskIds: readonly string[];
  readonly blockingStates: readonly ScheduleBlockingStateView[];
  readonly validFrom: string;
  readonly validUntil: string;
  readonly scheduleFingerprint: string;
}

export interface ScopeView {
  readonly userId: number;
  readonly businessId: number;
}

export interface MissionStateUpstreamAuthority {
  resolveMission(userId: number, missionId: string): Promise<MissionAuthorityView | null>;
  resolveMissionGlobal(missionId: string): Promise<ScopeView | null>;
  resolvePlan(userId: number, planId: string): Promise<PlanAuthorityView | null>;
  resolveTask(userId: number, taskId: string): Promise<TaskAuthorityView | null>;
  resolveTasksForPlan(userId: number, planId: string): Promise<TaskAuthorityView[]>;
  resolveSchedule(userId: number, scheduleId: string): Promise<ScheduleAuthorityView | null>;
  resolveScheduleGlobal(scheduleId: string): Promise<ScopeView | null>;
}

// ─── Shared row shapers (identical semantics in production + in-memory) ───

function parseJsonArray(value: unknown): unknown[] {
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

function toIso(value: unknown): string {
  const text = String(value ?? "");
  return isIsoUtc(text) ? text : "";
}

export function shapeMissionRow(row: Record<string, unknown>): MissionAuthorityView {
  const missionId = String(row.missionId ?? "");
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, "mission row has malformed missionId.");
  }
  const status = String(row.status ?? "");
  if (!(R9_MISSION_STATUSES as readonly string[]).includes(status)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `mission ${missionId} has unknown status ${status}.`);
  }
  const validFrom = toIso(row.validFrom);
  const validUntil = toIso(row.validUntil);
  if (!validFrom || !validUntil) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `mission ${missionId} has malformed validity.`);
  }
  return {
    missionId,
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    status,
    validFrom,
    validUntil,
    missionFingerprint: String(row.missionFingerprint ?? ""),
  };
}

export function shapePlanRow(row: Record<string, unknown>): PlanAuthorityView {
  const planId = String(row.planId ?? "");
  const missionId = String(row.missionId ?? "");
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `plan ${planId} has malformed missionId.`);
  }
  const validFrom = toIso(row.validFrom);
  const validUntil = toIso(row.validUntil);
  if (!validFrom || !validUntil) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `plan ${planId} has malformed validity.`);
  }
  const status = String(row.status ?? "");
  if (status.length === 0 || status.length > 28) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `plan ${planId} has malformed status.`);
  }
  return {
    planId,
    planVersion: Number(row.planVersion ?? 1),
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    missionId,
    status,
    validFrom,
    validUntil,
    planFingerprint: String(row.planFingerprint ?? ""),
  };
}

export function shapeTaskRow(row: Record<string, unknown>): TaskAuthorityView {
  const taskId = String(row.taskId ?? "");
  if (!TASK_ID_PATTERN.test(taskId)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, "task row has malformed taskId.");
  }
  const missionId = String(row.missionId ?? "");
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `task ${taskId} has malformed missionId.`);
  }
  const status = String(row.status ?? "");
  if (!(R9_TASK_STATUSES as readonly string[]).includes(status)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `task ${taskId} has unknown status ${status}.`);
  }
  const capabilityStatus =
    typeof row.capabilityStatus === "string" && row.capabilityStatus.length > 0 ? row.capabilityStatus : null;
  return {
    taskId,
    planId: String(row.planId ?? ""),
    planVersion: Number(row.planVersion ?? 1),
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    missionId,
    taskType: String(row.taskType ?? ""),
    status,
    requiredCapabilities: parseJsonArray(row.requiredCapabilities).map(String),
    constraints: parseJsonArray(row.constraints),
    capabilityStatus,
    taskFingerprint: String(row.taskFingerprint ?? ""),
  };
}

export function shapeScheduleRow(row: Record<string, unknown>): ScheduleAuthorityView {
  const scheduleId = String(row.scheduleId ?? "");
  if (!SCHEDULE_ID_PATTERN.test(scheduleId)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, "schedule row has malformed scheduleId.");
  }
  const missionId = String(row.missionId ?? "");
  if (!MISSION_ID_PATTERN.test(missionId)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `schedule ${scheduleId} has malformed missionId.`);
  }
  const status = String(row.status ?? "");
  if (!(R9_SCHEDULE_STATUSES as readonly string[]).includes(status)) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `schedule ${scheduleId} has unknown status ${status}.`);
  }
  const validFrom = toIso(row.validFrom);
  const validUntil = toIso(row.validUntil);
  if (!validFrom || !validUntil) {
    throw new MissionStateUpstreamError(MISSION_STATE_INPUT_MALFORMED, `schedule ${scheduleId} has malformed validity.`);
  }
  const blockingStates = parseJsonArray(row.blockingStates).map((entry) => {
    const e = (entry ?? {}) as Record<string, unknown>;
    return {
      taskId: String(e.taskId ?? ""),
      readiness: String(e.readiness ?? ""),
      reasons: parseJsonArray(e.reasons).map(String),
    };
  });
  return {
    scheduleId,
    userId: Number(row.userId),
    businessId: Number(row.businessId),
    missionId,
    planId: String(row.planId ?? ""),
    planFingerprint: String(row.planFingerprint ?? ""),
    status,
    orderedTaskIds: parseJsonArray(row.orderedTaskIds).map(String),
    blockingStates,
    validFrom,
    validUntil,
    scheduleFingerprint: String(row.scheduleFingerprint ?? ""),
  };
}

// ─── Production port: raw SQL behind guarded information-schema checks ───

type SqlExecutor = { execute: ReturnType<typeof getDb>["execute"] };

function normalizeSqlRows(result: unknown): Array<Record<string, unknown>> {
  if (Array.isArray(result)) {
    const first = result[0];
    if (Array.isArray(first)) return first as Array<Record<string, unknown>>;
    if (first && typeof first === "object") return [first as Record<string, unknown>];
    return [];
  }
  if (result && typeof result === "object" && Array.isArray((result as { rows?: unknown[] }).rows)) {
    return (result as { rows: Array<Record<string, unknown>> }).rows;
  }
  return [];
}

async function tableExists(db: SqlExecutor, table: string): Promise<boolean> {
  try {
    const rows = normalizeSqlRows(
      await db.execute(sql`
        SELECT COUNT(*) AS c FROM information_schema.TABLES
        WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ${table}
      `)
    );
    const first = rows[0];
    const count = first ? Number(first.c ?? 0) : 0;
    return Number.isInteger(count) && count > 0;
  } catch {
    return false;
  }
}

/** Injected production port. Never writes. Absent authority ⇒ throws. */
export function createMissionStateUpstreamAuthority(executor?: SqlExecutor): MissionStateUpstreamAuthority {
  const db = executor ?? getDb();

  async function guarded(table: string): Promise<void> {
    if (!(await tableExists(db, table))) throw new MissionStateAuthorityUnavailable(`table ${table} missing`);
  }

  async function rawOne(query: ReturnType<typeof sql>): Promise<Record<string, unknown> | null> {
    const rows = normalizeSqlRows(await db.execute(query));
    return rows[0] ?? null;
  }

  return {
    async resolveMission(userId, missionId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return null;
      await guarded("mission_proposals");
      const row = await rawOne(sql`
        SELECT missionId, userId, businessId, status, validFrom, validUntil, missionFingerprint
        FROM mission_proposals WHERE userId = ${userId} AND missionId = ${missionId} LIMIT 1
      `);
      if (!row) return null;
      const view = shapeMissionRow(row);
      return view.userId === userId ? view : null;
    },
    async resolveMissionGlobal(missionId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return null;
      await guarded("mission_proposals");
      const row = await rawOne(sql`
        SELECT userId, businessId FROM mission_proposals WHERE missionId = ${missionId} LIMIT 1
      `);
      return row ? { userId: Number(row.userId), businessId: Number(row.businessId) } : null;
    },
    async resolvePlan(userId, planId) {
      await guarded("mission_plans");
      const row = await rawOne(sql`
        SELECT planId, planVersion, userId, businessId, missionId, status, validFrom, validUntil, planFingerprint
        FROM mission_plans WHERE userId = ${userId} AND planId = ${planId} LIMIT 1
      `);
      if (!row) return null;
      const view = shapePlanRow(row);
      return view.userId === userId ? view : null;
    },
    async resolveTask(userId, taskId) {
      await guarded("mission_plan_tasks");
      const row = await rawOne(sql`
        SELECT taskId, planId, planVersion, userId, businessId, missionId, taskType, status,
               requiredCapabilities, constraints, capabilityStatus, taskFingerprint
        FROM mission_plan_tasks WHERE userId = ${userId} AND taskId = ${taskId} LIMIT 1
      `);
      if (!row) return null;
      const view = shapeTaskRow(row);
      return view.userId === userId ? view : null;
    },
    async resolveTasksForPlan(userId, planId) {
      await guarded("mission_plan_tasks");
      const rows = normalizeSqlRows(
        await db.execute(sql`
          SELECT taskId, planId, planVersion, userId, businessId, missionId, taskType, status,
                 requiredCapabilities, constraints, capabilityStatus, taskFingerprint
          FROM mission_plan_tasks WHERE userId = ${userId} AND planId = ${planId}
          ORDER BY taskId ASC
        `)
      );
      return rows.map(shapeTaskRow);
    },
    async resolveSchedule(userId, scheduleId) {
      if (!SCHEDULE_ID_PATTERN.test(scheduleId)) return null;
      await guarded("mission_schedules");
      const row = await rawOne(sql`
        SELECT scheduleId, userId, businessId, missionId, planId, planFingerprint, status,
               orderedTaskIds, blockingStates, validFrom, validUntil, scheduleFingerprint
        FROM mission_schedules WHERE userId = ${userId} AND scheduleId = ${scheduleId} LIMIT 1
      `);
      if (!row) return null;
      const view = shapeScheduleRow(row);
      return view.userId === userId ? view : null;
    },
    async resolveScheduleGlobal(scheduleId) {
      if (!SCHEDULE_ID_PATTERN.test(scheduleId)) return null;
      await guarded("mission_schedules");
      const row = await rawOne(sql`
        SELECT userId, businessId FROM mission_schedules WHERE scheduleId = ${scheduleId} LIMIT 1
      `);
      return row ? { userId: Number(row.userId), businessId: Number(row.businessId) } : null;
    },
  };
}

// ─── In-memory port over planted raw rows (identical validation) ───

export interface FakeUpstreamRow {
  readonly table: string;
  readonly row: Record<string, unknown>;
}

export function createInMemoryMissionStateUpstreamAuthority(
  rows: readonly FakeUpstreamRow[]
): MissionStateUpstreamAuthority {
  const ofTable = (table: string) => rows.filter((r) => r.table === table).map((r) => r.row);
  return {
    async resolveMission(userId, missionId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return null;
      const hit = ofTable("mission_proposals").find((r) => r.missionId === missionId);
      if (!hit) return null;
      const view = shapeMissionRow(hit);
      return view.userId === userId ? view : null;
    },
    async resolveMissionGlobal(missionId) {
      if (!MISSION_ID_PATTERN.test(missionId)) return null;
      const hit = ofTable("mission_proposals").find((r) => r.missionId === missionId);
      return hit ? { userId: Number(hit.userId), businessId: Number(hit.businessId) } : null;
    },
    async resolvePlan(userId, planId) {
      const hit = ofTable("mission_plans").find((r) => r.planId === planId);
      if (!hit) return null;
      const view = shapePlanRow(hit);
      return view.userId === userId ? view : null;
    },
    async resolveTask(userId, taskId) {
      const hit = ofTable("mission_plan_tasks").find((r) => r.taskId === taskId);
      if (!hit) return null;
      const view = shapeTaskRow(hit);
      return view.userId === userId ? view : null;
    },
    async resolveTasksForPlan(userId, planId) {
      return ofTable("mission_plan_tasks")
        .filter((r) => Number(r.userId) === userId && r.planId === planId)
        .map(shapeTaskRow);
    },
    async resolveSchedule(userId, scheduleId) {
      if (!SCHEDULE_ID_PATTERN.test(scheduleId)) return null;
      const hit = ofTable("mission_schedules").find((r) => r.scheduleId === scheduleId);
      if (!hit) return null;
      const view = shapeScheduleRow(hit);
      return view.userId === userId ? view : null;
    },
    async resolveScheduleGlobal(scheduleId) {
      if (!SCHEDULE_ID_PATTERN.test(scheduleId)) return null;
      const hit = ofTable("mission_schedules").find((r) => r.scheduleId === scheduleId);
      return hit ? { userId: Number(hit.userId), businessId: Number(hit.businessId) } : null;
    },
  };
}
